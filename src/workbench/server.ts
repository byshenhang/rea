import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { URL } from "node:url";

import type { JsonValue } from "../domain/jsonValue.js";
import {
  WorkbenchApiError,
  createComparisonBodySchema,
  createProjectBodySchema,
  createRunBodySchema,
  createTargetBodySchema,
  idempotencyKeyHeader,
  parseIdempotencyKey,
  parseJsonBody,
  runRequestDigest,
  type WorkbenchComparisonResponse,
  type WorkbenchFileEntry,
  type WorkbenchGraphResponse,
  type WorkbenchSourceContent,
} from "./api.js";
import { WorkbenchBundleStore, defaultBundleRoot } from "./bundleStore.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import {
  compareRunGraphs,
  loadRunGraph,
  nodeLocations,
  nodeMatchesSearch,
  page,
  projectEdge,
  projectNeighbors,
  projectNode,
  type LoadedRunGraph,
} from "./graphView.js";
import { WorkbenchRunManager } from "./runManager.js";
import {
  WorkbenchStore,
  defaultDatabasePath,
  defaultWorkflow,
} from "./store.js";
import type { WorkbenchRunEvent } from "./types.js";

const MAX_SOURCE_BYTES = 1_000_000;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;

export interface WorkbenchServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly databasePath?: string;
  readonly token?: string;
  /** Cumulative snapshot text-read budget per run; see sourceSnapshot.ts. */
  readonly maxRunSourceBytes?: number;
  /** Filesystem root for evidence bundles; defaults beside the database. */
  readonly bundleRoot?: string;
}

export interface WorkbenchServerHandle {
  readonly server: Server;
  readonly store: WorkbenchStore;
  readonly bundles: WorkbenchBundleStore;
  readonly manager: WorkbenchRunManager;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  close(): Promise<void>;
}

/** Create the loopback Workbench API and browser application. */
export const createWorkbenchServer = (
  options: WorkbenchServerOptions = {},
): WorkbenchServerHandle => {
  const host = options.host ?? DEFAULT_HOST;
  const port =
    options.port ?? parsePort(process.env.REA_WORKBENCH_PORT) ?? DEFAULT_PORT;
  const databasePath = options.databasePath ?? defaultDatabasePath();
  const store = new WorkbenchStore(databasePath);
  const bundles = new WorkbenchBundleStore(
    options.bundleRoot ?? defaultBundleRoot(databasePath),
  );
  const manager = new WorkbenchRunManager(store, {
    bundles,
    ...(options.maxRunSourceBytes === undefined
      ? {}
      : { sourceSnapshotLimits: { maxTotalBytes: options.maxRunSourceBytes } }),
  });
  const token =
    options.token ??
    process.env.REA_WORKBENCH_TOKEN ??
    randomBytes(24).toString("hex");
  const server = createServer((request, response) => {
    void handleRequest(request, response, {
      host,
      port,
      token,
      store,
      bundles,
      manager,
    }).catch((cause: unknown) => {
      if (cause instanceof WorkbenchApiError) {
        if (!response.headersSent)
          sendJson(response, cause.status, cause.envelope());
        else response.destroy();
        return;
      }
      if (!response.headersSent)
        sendJson(response, 500, {
          error: { code: "internal_error", message: describeError(cause) },
        });
      else response.destroy();
    });
  });
  // Analysis runs CPU-bound phases in this same process. The default 5s
  // keep-alive timer only fires once a blocked loop unblocks, reaping the
  // connection right as the client's queued request writes to it. Local,
  // single-user, loopback: hold connections well past those blocks.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  return {
    server,
    store,
    bundles,
    manager,
    host,
    port,
    token,
    close: async () => {
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) =>
          error === undefined ? resolveClose() : reject(error),
        ),
      );
      await manager.dispose();
      store.close();
    },
  };
};

export interface WorkbenchListenReport {
  readonly orphanBundlesRemoved: number;
  readonly orphanBundlesFailed: number;
}

export const listenWorkbenchServer = async (
  handle: WorkbenchServerHandle,
): Promise<WorkbenchListenReport> => {
  const recovery = await handle.bundles.recoverOrphans();
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error) => {
      handle.server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      handle.server.off("error", onError);
      resolveListen();
    };
    handle.server.once("error", onError);
    handle.server.once("listening", onListening);
    handle.server.listen(handle.port, handle.host);
  });
  return {
    orphanBundlesRemoved: recovery.removed.length,
    orphanBundlesFailed: recovery.failed.length,
  };
};

interface RequestContext {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly store: WorkbenchStore;
  readonly bundles: WorkbenchBundleStore;
  readonly manager: WorkbenchRunManager;
}

const handleRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
): Promise<void> => {
  if (!isAllowedOrigin(request, context))
    return sendJson(response, 403, {
      error: { code: "origin_denied", message: "仅允许本地工作台来源访问" },
    });
  const url = new URL(
    request.url ?? "/",
    `http://${context.host}:${String(context.port)}`,
  );
  if (url.pathname === "/" && request.method === "GET")
    return sendHtml(response, renderWorkbenchHtml(context.token));
  if (url.pathname === "/healthz" && request.method === "GET")
    return sendJson(response, 200, { ok: true, service: "rea-workbench" });
  if (!isAuthorized(request, context.token, url))
    return sendJson(response, 401, {
      error: { code: "unauthorized", message: "需要工作台访问凭据" },
    });
  if (
    url.pathname.startsWith("/api/runs/") &&
    url.pathname.endsWith("/events") &&
    request.method === "GET"
  ) {
    const runId = url.pathname.split("/")[3] ?? "";
    if (context.store.getRun(runId) === null)
      return sendJson(response, 404, {
        error: { code: "run_not_found", message: "运行不存在" },
      });
    if (url.searchParams.get("format") === "json") {
      const after = boundedSequence(url.searchParams.get("after"));
      return sendJson(response, 200, context.store.listEvents(runId, after));
    }
    return streamRunEvents(request, response, context, runId, url);
  }
  if (request.method === "GET" && url.pathname === "/api/workflows")
    return sendJson(response, 200, context.store.listWorkflows());
  if (request.method === "GET" && url.pathname === "/api/providers")
    return sendJson(response, 200, [
      {
        id: "rea.javascript-application",
        name: "REA JavaScript Application Analyzer",
        version: "local",
        status: "available",
      },
    ]);
  if (request.method === "POST" && url.pathname === "/api/comparisons")
    return createComparison(request, response, context);
  if (request.method === "GET" && url.pathname === "/api/projects")
    return sendJson(response, 200, context.store.listProjects());
  if (request.method === "POST" && url.pathname === "/api/projects")
    return createProject(request, response, context);
  const projectMatch = url.pathname.match(
    /^\/api\/projects\/([^/]+)(?:\/targets)?$/u,
  );
  if (projectMatch !== null && request.method === "GET") {
    const projectId = decodeURIComponent(projectMatch[1] ?? "");
    if (url.pathname.endsWith("/targets"))
      return sendJson(response, 200, context.store.listTargets(projectId));
    const project = context.store.getProject(projectId);
    return project === null
      ? sendJson(response, 404, {
          error: { code: "project_not_found", message: "项目不存在" },
        })
      : sendJson(response, 200, project);
  }
  if (
    projectMatch !== null &&
    request.method === "POST" &&
    url.pathname.endsWith("/targets")
  )
    return createTarget(
      request,
      response,
      context,
      decodeURIComponent(projectMatch[1] ?? ""),
    );
  if (request.method === "GET" && url.pathname === "/api/runs")
    return sendJson(
      response,
      200,
      context.store.listRuns(url.searchParams.get("project_id") ?? undefined),
    );
  const graphRouteMatch = url.pathname.match(
    /^\/api\/runs\/([^/]+)\/graph\/(nodes|edges|neighbors|diff)$/u,
  );
  if (graphRouteMatch !== null && request.method === "GET") {
    const runId = decodeURIComponent(graphRouteMatch[1] ?? "");
    const subresource = graphRouteMatch[2];
    if (subresource === "nodes")
      return getGraphNodes(response, context, runId, url);
    if (subresource === "edges")
      return getGraphEdges(response, context, runId, url);
    if (subresource === "neighbors")
      return getGraphNeighbors(response, context, runId, url);
    return getGraphDiff(response, context, runId, url);
  }
  const graphNodeMatch = url.pathname.match(
    /^\/api\/runs\/([^/]+)\/graph\/nodes\/([^/]+)$/u,
  );
  if (graphNodeMatch !== null && request.method === "GET")
    return getGraphNodeDetail(
      response,
      context,
      decodeURIComponent(graphNodeMatch[1] ?? ""),
      decodeURIComponent(graphNodeMatch[2] ?? ""),
    );
  const runMatch = url.pathname.match(
    /^\/api\/runs\/([^/]+)(?:\/(steps|evidence|graph|files|source|export))?$/u,
  );
  if (runMatch !== null) {
    const runId = decodeURIComponent(runMatch[1] ?? "");
    const action = runMatch[2];
    if (request.method === "GET" && action === undefined)
      return getRun(response, context, runId);
    if (
      request.method === "POST" &&
      action === undefined &&
      url.pathname.endsWith("/cancel")
    )
      return cancelRun(response, context, runId);
    if (request.method === "GET" && action === "steps")
      return sendJson(response, 200, context.store.listSteps(runId));
    if (request.method === "GET" && action === "evidence")
      return getEvidence(response, context, runId);
    if (request.method === "GET" && action === "export")
      return exportEvidence(response, context, runId);
    if (request.method === "GET" && action === "graph")
      return getGraph(response, context, runId, url);
    if (request.method === "GET" && action === "files")
      return getFiles(response, context, runId, url);
    if (request.method === "GET" && action === "source")
      return getSource(response, context, runId, url);
  }
  if (request.method === "POST" && url.pathname === "/api/runs")
    return createRun(request, response, context);
  if (
    request.method === "POST" &&
    /^\/api\/runs\/[^/]+\/cancel$/u.test(url.pathname)
  )
    return cancelRun(
      response,
      context,
      decodeURIComponent(url.pathname.split("/")[3] ?? ""),
    );
  sendJson(response, 404, {
    error: { code: "not_found", message: "资源不存在" },
  });
};

const createProject = async (
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
): Promise<void> => {
  const body = await parseJsonBody(request, createProjectBodySchema);
  const name = (body.name ?? "未命名项目").trim();
  if (name === "" || name.length > 200)
    throw new WorkbenchApiError(
      "invalid_request",
      "项目名称必须为 1-200 个字符",
      [{ path: "name", message: "提供时不能为空白且不超过 200 字符" }],
    );
  sendJson(
    response,
    201,
    context.store.createProject(name, body.description ?? ""),
  );
};

const createTarget = async (
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
  projectId: string,
): Promise<void> => {
  if (context.store.getProject(projectId) === null)
    return sendJson(response, 404, {
      error: { code: "project_not_found", message: "项目不存在" },
    });
  const body = await parseJsonBody(request, createTargetBodySchema);
  const requestedPath = body.path.trim();
  if (!isAbsolute(requestedPath))
    return sendJson(response, 400, {
      error: { code: "invalid_path", message: "目标必须是绝对路径" },
    });
  try {
    const targetPath = await realpath(requestedPath);
    await access(targetPath, constants.R_OK);
    const target = context.store.createTarget(
      projectId,
      targetPath,
      body.format ?? "auto",
    );
    sendJson(response, 201, target);
  } catch (cause: unknown) {
    sendJson(response, 400, {
      error: { code: "target_unreadable", message: describeError(cause) },
    });
  }
};

const createRun = async (
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
): Promise<void> => {
  const body = await parseJsonBody(request, createRunBodySchema);
  const idempotencyKey = parseIdempotencyKey(
    request.headers[idempotencyKeyHeader],
  );
  const workflowId = body.workflow_id ?? defaultWorkflow().workflowId;
  const workflowVersion = body.workflow_version ?? defaultWorkflow().version;
  const workflow = context.store.getWorkflow(workflowId, workflowVersion);
  if (workflow === null)
    return sendJson(response, 400, {
      error: { code: "workflow_not_found", message: "流程版本不存在" },
    });
  const parameters = (body.parameters ?? {}) as Record<string, JsonValue>;
  try {
    const { run, replayed } = await context.manager.createRun({
      projectId: body.project_id,
      targetId: body.target_id,
      workflow,
      parameters,
      ...(idempotencyKey === null
        ? {}
        : {
            idempotency: {
              key: idempotencyKey,
              requestDigest: runRequestDigest({
                projectId: body.project_id,
                targetId: body.target_id,
                workflowId,
                workflowVersion,
                parameters,
              }),
            },
          }),
    });
    sendJson(
      response,
      202,
      run,
      replayed ? { "idempotency-replayed": "true" } : undefined,
    );
  } catch (cause: unknown) {
    if (cause instanceof WorkbenchApiError) throw cause;
    sendJson(response, 400, {
      error: { code: "run_rejected", message: describeError(cause) },
    });
  }
};

const getRun = (
  response: ServerResponse,
  context: RequestContext,
  runId: string,
): void => {
  const run = context.store.getRun(runId);
  if (run === null)
    sendJson(response, 404, {
      error: { code: "run_not_found", message: "运行不存在" },
    });
  else sendJson(response, 200, run);
};

const cancelRun = (
  response: ServerResponse,
  context: RequestContext,
  runId: string,
): void => {
  try {
    sendJson(response, 202, context.manager.cancelRun(runId));
  } catch (cause: unknown) {
    sendJson(response, 404, {
      error: { code: "run_not_found", message: describeError(cause) },
    });
  }
};

/** Bundle evidence first (digest-verified), falling back to inline rows. */
const resolveEvidence = async (
  context: RequestContext,
  runId: string,
): Promise<JsonValue | null> => {
  const fromBundle = context.bundles.readEvidence(runId);
  if (fromBundle !== null) return fromBundle;
  return context.store.getEvidence(runId);
};

const getEvidence = async (
  response: ServerResponse,
  context: RequestContext,
  runId: string,
): Promise<void> => {
  const evidence = await resolveEvidence(context, runId);
  if (evidence === null)
    sendJson(response, 404, {
      error: {
        code: "evidence_not_available",
        message: "该运行尚未生成完整 Evidence",
      },
    });
  else sendJson(response, 200, evidence);
};

const exportEvidence = async (
  response: ServerResponse,
  context: RequestContext,
  runId: string,
): Promise<void> => {
  const evidence = await resolveEvidence(context, runId);
  if (evidence === null)
    return sendJson(response, 404, {
      error: {
        code: "evidence_not_available",
        message: "该运行尚未生成完整 Evidence",
      },
    });
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="rea-workbench-${runId}.json"`,
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(evidence, null, 2));
};

const createComparison = async (
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
): Promise<void> => {
  const body = await parseJsonBody(request, createComparisonBodySchema);
  const left = context.store.getRun(body.left_run_id);
  const right = context.store.getRun(body.right_run_id);
  if (left === null || right === null)
    return sendJson(response, 404, {
      error: { code: "run_not_found", message: "比较运行不存在" },
    });
  const leftEvidence = await resolveEvidence(context, left.id);
  const rightEvidence = await resolveEvidence(context, right.id);
  const leftResult =
    isJsonRecord(leftEvidence) && isJsonRecord(leftEvidence.normalized_result)
      ? leftEvidence.normalized_result
      : null;
  const rightResult =
    isJsonRecord(rightEvidence) && isJsonRecord(rightEvidence.normalized_result)
      ? rightEvidence.normalized_result
      : null;
  const leftRoot =
    leftResult !== null && typeof leftResult.root_artifact_sha256 === "string"
      ? leftResult.root_artifact_sha256
      : null;
  const rightRoot =
    rightResult !== null && typeof rightResult.root_artifact_sha256 === "string"
      ? rightResult.root_artifact_sha256
      : null;
  const comparable = leftRoot !== null && rightRoot !== null;
  let graphDiff: Record<string, JsonValue> | null = null;
  if (body.include_graph_diff === true) {
    try {
      const leftLoaded = loadRunGraph(context.bundles, context.store, left.id);
      const rightLoaded = loadRunGraph(
        context.bundles,
        context.store,
        right.id,
      );
      if (leftLoaded.status === "loaded" && rightLoaded.status === "loaded") {
        const diff = compareRunGraphs({
          left: leftLoaded.loaded.evidence,
          right: rightLoaded.loaded.evidence,
        });
        graphDiff = {
          comparison_id: diff.comparisonId,
          summary: diff.summary,
          coverage: diff.coverage,
          limitations: [...diff.limitations],
        };
      } else {
        graphDiff = {
          summary: null,
          limitations: ["至少一侧运行缺少可用的应用图证据，未推断增删。"],
        };
      }
    } catch (cause: unknown) {
      graphDiff = {
        summary: null,
        limitations: [`图差异计算失败：${describeError(cause)}`],
      };
    }
  }
  const comparison: WorkbenchComparisonResponse = {
    comparison_id: `cmp_${left.id.slice(0, 8)}_${right.id.slice(0, 8)}`,
    comparable,
    configuration: {
      left_run_id: left.id,
      right_run_id: right.id,
      same_workflow:
        left.workflowId === right.workflowId &&
        left.workflowVersion === right.workflowVersion,
      same_target: leftRoot !== null && leftRoot === rightRoot,
      left_root_artifact_sha256: leftRoot,
      right_root_artifact_sha256: rightRoot,
    },
    execution: {
      left: {
        state: left.state,
        completeness: left.resultCompleteness,
        duration_ms: durationMs(left.startedAt, left.finishedAt),
      },
      right: {
        state: right.state,
        completeness: right.resultCompleteness,
        duration_ms: durationMs(right.startedAt, right.finishedAt),
      },
    },
    result: {
      left: graphCounts(leftResult),
      right: graphCounts(rightResult),
      limitations: ["耗时差异仅为观测值，不能单独归因于源码修改。"],
      ...(body.include_graph_diff === true ? { graph_diff: graphDiff } : {}),
    },
  };
  sendJson(response, 200, comparison);
};

const getGraph = async (
  response: ServerResponse,
  context: RequestContext,
  runId: string,
  url: URL,
): Promise<void> => {
  const evidence = await resolveEvidence(context, runId);
  if (!isJsonRecord(evidence))
    return sendJson(response, 404, {
      error: { code: "graph_not_available", message: "图结果尚未生成" },
    });
  const normalized = evidence.normalized_result;
  if (!isJsonRecord(normalized))
    return sendJson(response, 404, {
      error: { code: "graph_not_available", message: "图结果尚未生成" },
    });
  const graphValue = normalized.graph;
  if (!isJsonRecord(graphValue))
    return sendJson(response, 404, {
      error: { code: "graph_not_available", message: "图结果尚未生成" },
    });
  const graph = graphValue;
  const nodesValue = graph.nodes;
  const nodes = Array.isArray(nodesValue)
    ? nodesValue.slice(
        0,
        boundedNumber(url.searchParams.get("limit"), 300, 1000),
      )
    : [];
  const nodeIds = new Set(
    nodes.flatMap((node) =>
      isJsonRecord(node) && typeof node.node_id === "string"
        ? [node.node_id]
        : [],
    ),
  );
  const edgesValue = graph.edges;
  const edges = Array.isArray(edgesValue)
    ? edgesValue
        .filter(
          (edge) =>
            isJsonRecord(edge) &&
            typeof edge.source_node_id === "string" &&
            typeof edge.target_node_id === "string" &&
            nodeIds.has(edge.source_node_id) &&
            nodeIds.has(edge.target_node_id),
        )
        .slice(0, 2000)
    : [];
  const graphResponse: WorkbenchGraphResponse = {
    graph_id: graph.graph_id ?? null,
    coverage: graph.coverage ?? null,
    limitations: graph.limitations ?? [],
    nodes,
    edges,
  };
  sendJson(response, 200, graphResponse);
};

const isAsarTarget = (target: {
  readonly path: string;
  readonly format: "auto" | "asar" | "directory";
}): boolean =>
  target.format === "asar" || target.path.toLowerCase().endsWith(".asar");

const GRAPH_PAGE_DEFAULT = 100;
const GRAPH_PAGE_MAX = 500;

const graphPageLimit = (url: URL): number =>
  boundedNumber(
    url.searchParams.get("limit"),
    GRAPH_PAGE_DEFAULT,
    GRAPH_PAGE_MAX,
  );

const requireRunGraph = (
  context: RequestContext,
  runId: string,
): LoadedRunGraph => {
  const outcome = loadRunGraph(context.bundles, context.store, runId);
  if (outcome.status === "missing")
    throw new WorkbenchApiError(
      "graph_not_available",
      "该运行没有可用的应用图证据",
    );
  if (outcome.status === "invalid")
    throw new WorkbenchApiError(
      "graph_not_available",
      `图证据不可用：${outcome.reason}`,
    );
  return outcome.loaded;
};

const getGraphNodes = (
  response: ServerResponse,
  context: RequestContext,
  runId: string,
  url: URL,
): void => {
  const { evidenceId, graph } = requireRunGraph(context, runId);
  const kind = url.searchParams.get("kind");
  const search = url.searchParams.get("search") ?? "";
  let nodes = graph.nodes;
  if (kind !== null) nodes = nodes.filter((node) => node.kind === kind);
  if (search !== "")
    nodes = nodes.filter((node) => nodeMatchesSearch(node, search));
  const result = page(
    nodes,
    url.searchParams.get("cursor"),
    graphPageLimit(url),
  );
  sendJson(response, 200, {
    graph_id: graph.graph_id,
    evidence_id: evidenceId,
    coverage: graph.coverage,
    limitations: [...graph.limitations],
    total: result.total,
    cursor: result.cursor,
    nodes: result.items.map((node) => projectNode(node, evidenceId)),
  });
};

const getGraphEdges = (
  response: ServerResponse,
  context: RequestContext,
  runId: string,
  url: URL,
): void => {
  const { evidenceId, graph } = requireRunGraph(context, runId);
  const relation = url.searchParams.get("relation");
  let edges = [...graph.edges].sort((left, right) =>
    compareUnicodeCodePoints(left.edge_id, right.edge_id),
  );
  if (relation !== null)
    edges = edges.filter((edge) => edge.relation === relation);
  const result = page(
    edges,
    url.searchParams.get("cursor"),
    graphPageLimit(url),
  );
  sendJson(response, 200, {
    graph_id: graph.graph_id,
    evidence_id: evidenceId,
    coverage: graph.coverage,
    limitations: [...graph.limitations],
    total: result.total,
    cursor: result.cursor,
    edges: result.items.map(projectEdge),
  });
};

const getGraphNeighbors = (
  response: ServerResponse,
  context: RequestContext,
  runId: string,
  url: URL,
): void => {
  const { evidenceId, graph } = requireRunGraph(context, runId);
  const nodeId = url.searchParams.get("node_id") ?? "";
  const directionParam = url.searchParams.get("direction") ?? "both";
  if (nodeId === "")
    throw new WorkbenchApiError("invalid_request", "node_id 为必填项", [
      { path: "node_id", message: "缺少节点标识" },
    ]);
  if (
    directionParam !== "in" &&
    directionParam !== "out" &&
    directionParam !== "both"
  )
    throw new WorkbenchApiError(
      "invalid_request",
      "direction 只接受 in、out 或 both",
      [{ path: "direction", message: directionParam }],
    );
  const projection = projectNeighbors(
    graph,
    nodeId,
    directionParam,
    boundedNumber(url.searchParams.get("limit"), 50, GRAPH_PAGE_MAX),
    evidenceId,
  );
  if (projection === null)
    throw new WorkbenchApiError(
      "graph_not_available",
      "节点不存在于该运行的关系图中",
      [{ path: "node_id", message: nodeId }],
    );
  sendJson(response, 200, {
    graph_id: graph.graph_id,
    evidence_id: evidenceId,
    direction: directionParam,
    ...projection,
  });
};

const getGraphNodeDetail = (
  response: ServerResponse,
  context: RequestContext,
  runId: string,
  nodeId: string,
): void => {
  const { evidenceId, graph } = requireRunGraph(context, runId);
  const node = graph.nodes.find((entry) => entry.node_id === nodeId);
  if (node === undefined)
    throw new WorkbenchApiError(
      "graph_not_available",
      "节点不存在于该运行的关系图中",
      [{ path: "node_id", message: nodeId }],
    );
  sendJson(response, 200, {
    graph_id: graph.graph_id,
    evidence_id: evidenceId,
    coverage: graph.coverage,
    limitations: [...graph.limitations],
    in_degree: graph.edges.filter((edge) => edge.target_node_id === nodeId)
      .length,
    out_degree: graph.edges.filter((edge) => edge.source_node_id === nodeId)
      .length,
    node: {
      ...projectNode(node, evidenceId),
      identity: node.identity as unknown as JsonValue,
      observations: node.observations as unknown as JsonValue,
    },
  });
};

const requireRunForDiff = (context: RequestContext, runId: string): void => {
  if (context.store.getRun(runId) === null)
    throw new WorkbenchApiError("run_not_found", "运行不存在");
};

/**
 * Diff change entries trace back to both runs: each carries the item identity,
 * the run/evidence it came from, and the node's source locations.
 */
const getGraphDiff = (
  response: ServerResponse,
  context: RequestContext,
  runId: string,
  url: URL,
): void => {
  requireRunForDiff(context, runId);
  const against = url.searchParams.get("against") ?? "";
  if (against === "")
    throw new WorkbenchApiError("invalid_request", "against 为必填项", [
      { path: "against", message: "缺少要比较的运行 ID" },
    ]);
  requireRunForDiff(context, against);
  const change = url.searchParams.get("change") ?? "all";
  const kind = url.searchParams.get("kind") ?? "all";
  if (
    change !== "all" &&
    change !== "added" &&
    change !== "removed" &&
    change !== "changed"
  )
    throw new WorkbenchApiError(
      "invalid_request",
      "change 只接受 added、removed、changed 或 all",
      [{ path: "change", message: change }],
    );
  if (kind !== "all" && kind !== "node" && kind !== "edge")
    throw new WorkbenchApiError(
      "invalid_request",
      "kind 只接受 node、edge 或 all",
      [{ path: "kind", message: kind }],
    );

  const leftOutcome = loadRunGraph(context.bundles, context.store, runId);
  const rightOutcome = loadRunGraph(context.bundles, context.store, against);
  if (leftOutcome.status !== "loaded" || rightOutcome.status !== "loaded") {
    const reasonFor = (outcome: typeof leftOutcome): string =>
      outcome.status === "loaded"
        ? "已有图证据"
        : outcome.status === "missing"
          ? "运行没有可用的应用图证据"
          : `图证据不可用：${outcome.reason}`;
    sendJson(response, 200, {
      status: "unavailable",
      left_run_id: runId,
      right_run_id: against,
      summary: null,
      coverage: null,
      limitations: [
        `缺少完整图证据时不推断增删：左侧${reasonFor(leftOutcome)}；右侧${reasonFor(rightOutcome)}`,
      ],
      changes: [],
      cursor: null,
    });
    return;
  }

  const left = leftOutcome.loaded;
  const right = rightOutcome.loaded;
  if (left.evidenceId === right.evidenceId) {
    // Evidence identity is content-derived: both runs established the same
    // application version, so there is no cross-version diff to infer.
    sendJson(response, 200, {
      status: "unavailable",
      left_run_id: runId,
      right_run_id: against,
      summary: null,
      coverage: null,
      limitations: [
        "两次运行持有同一份应用图证据（相同目标内容），不存在可比较的版本差异。",
      ],
      changes: [],
      cursor: null,
    });
    return;
  }
  const diff = compareRunGraphs({ left: left.evidence, right: right.evidence });
  const leftNodeById = new Map(
    left.graph.nodes.map((node) => [node.node_id, node]),
  );
  const rightNodeById = new Map(
    right.graph.nodes.map((node) => [node.node_id, node]),
  );
  const statusRank: Record<string, number> = {
    added: 0,
    removed: 1,
    changed: 2,
    unknown: 3,
    unchanged: 4,
  };
  const changes = diff.items
    .filter((item) => (change === "all" ? true : item.status === change))
    .map((item) => {
      const node =
        item.right_node_id !== null
          ? rightNodeById.get(item.right_node_id)
          : item.left_node_id !== null
            ? leftNodeById.get(item.left_node_id)
            : undefined;
      return {
        item_id: item.item_id,
        status: item.status,
        node_kind: item.node_kind,
        dimensions: item.dimensions,
        left_run_id: item.left_node_id === null ? null : runId,
        right_run_id: item.right_node_id === null ? null : against,
        left_node_id: item.left_node_id,
        right_node_id: item.right_node_id,
        match: item.match,
        evidence_links: item.evidence_links,
        limitations: item.limitations,
        locations: node === undefined ? [] : nodeLocations(node),
      };
    })
    .filter((entry) =>
      kind === "all"
        ? true
        : kind === "node"
          ? entry.left_node_id !== null || entry.right_node_id !== null
          : entry.left_node_id === null && entry.right_node_id === null,
    )
    .sort((a, b) => {
      const rank =
        (statusRank[String(a.status)] ?? 9) -
        (statusRank[String(b.status)] ?? 9);
      return rank !== 0
        ? rank
        : compareUnicodeCodePoints(String(a.item_id), String(b.item_id));
    });
  const result = page(
    changes,
    url.searchParams.get("cursor"),
    graphPageLimit(url),
  );
  sendJson(response, 200, {
    status: "compared",
    left_run_id: runId,
    right_run_id: against,
    comparison_id: diff.comparisonId,
    summary: diff.summary,
    coverage: diff.coverage,
    limitations: [...diff.limitations],
    changes: result.items,
    total: result.total,
    cursor: result.cursor,
  });
};

const getFiles = async (
  response: ServerResponse,
  context: RequestContext,
  runId: string,
  url: URL,
): Promise<void> => {
  const run = context.store.getRun(runId);
  if (run === null)
    return sendJson(response, 404, {
      error: { code: "run_not_found", message: "运行不存在" },
    });
  const target = context.store.getTarget(run.targetId);
  if (target === null)
    return sendJson(response, 404, {
      error: { code: "target_not_found", message: "目标不存在" },
    });
  const prefix = safeRelativePath(url.searchParams.get("prefix") ?? "");
  const snapshot = context.manager.getSourceSnapshot(run.id);
  if (snapshot !== undefined)
    return sendJson(response, 200, await snapshot.listChildren(prefix, 500));
  if (isAsarTarget(target))
    return sendJson(response, 400, {
      error: {
        code: "source_snapshot_unavailable",
        message: "该 ASAR 运行尚未建立源码快照，无法浏览文件树",
      },
    });
  try {
    const root = await realpath(target.path);
    const directory = await resolveAuthorizedPath(root, prefix);
    const entries = await readdir(directory, { withFileTypes: true });
    const listing: WorkbenchFileEntry[] = entries
      .slice(0, 500)
      .map((entry) => ({
        name: entry.name,
        path: prefix === "" ? entry.name : `${prefix}/${entry.name}`,
        kind: entry.isDirectory() ? "directory" : "file",
        extension: entry.isFile() ? extname(entry.name) : null,
      }));
    sendJson(response, 200, listing);
  } catch (cause: unknown) {
    if (cause instanceof WorkbenchApiError) throw cause;
    sendJson(response, 400, {
      error: { code: "file_listing_failed", message: describeError(cause) },
    });
  }
};

const getSource = async (
  response: ServerResponse,
  context: RequestContext,
  runId: string,
  url: URL,
): Promise<void> => {
  const run = context.store.getRun(runId);
  if (run === null)
    return sendJson(response, 404, {
      error: { code: "run_not_found", message: "运行不存在" },
    });
  const target = context.store.getTarget(run.targetId);
  if (target === null)
    return sendJson(response, 404, {
      error: { code: "target_not_found", message: "目标不存在" },
    });
  const path = safeRelativePath(url.searchParams.get("path") ?? "");
  const snapshot = context.manager.getSourceSnapshot(run.id);
  if (snapshot !== undefined) {
    try {
      const text = await snapshot.readText(path);
      const source: WorkbenchSourceContent = {
        path: text.path,
        content: text.content,
        size: text.size,
        origin: "run-snapshot",
        snapshot_sha256: text.snapshotSha256,
      };
      sendJson(response, 200, source);
    } catch (cause: unknown) {
      if (
        cause instanceof WorkbenchApiError &&
        cause.code === "source_too_large"
      )
        context.manager.noteSourceReadLimit(run.id, cause.message);
      throw cause;
    }
    return;
  }
  if (isAsarTarget(target))
    return sendJson(response, 400, {
      error: {
        code: "source_snapshot_unavailable",
        message: "该 ASAR 运行尚未建立源码快照，无法读取源码",
      },
    });
  try {
    const root = await realpath(target.path);
    const filePath = await resolveAuthorizedPath(root, path);
    const info = await stat(filePath);
    if (!info.isFile())
      return sendJson(response, 400, {
        error: { code: "source_not_file", message: "请求对象不是文件" },
      });
    if (info.size > MAX_SOURCE_BYTES)
      return sendJson(response, 413, {
        error: { code: "source_too_large", message: "源码超过单次读取上限" },
      });
    const source: WorkbenchSourceContent = {
      path,
      content: await readFile(filePath, "utf8"),
      size: info.size,
      origin: "target-file",
    };
    sendJson(response, 200, source);
  } catch (cause: unknown) {
    if (cause instanceof WorkbenchApiError) throw cause;
    sendJson(response, 400, {
      error: { code: "source_read_failed", message: describeError(cause) },
    });
  }
};

const streamRunEvents = (
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
  runId: string,
  url: URL,
): void => {
  const requested = Number(
    request.headers["last-event-id"] ?? url.searchParams.get("after") ?? "0",
  );
  const after =
    Number.isSafeInteger(requested) && requested >= 0 ? requested : 0;
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write("retry: 3000\n\n");
  let lastSent = after;
  let replaying = true;
  const buffered: WorkbenchRunEvent[] = [];
  const deliver = (event: WorkbenchRunEvent): void => {
    // Deduplicate by the run-internal sequence so replay and live delivery
    // can never emit one event twice on the same stream.
    if (event.sequence <= lastSent) return;
    lastSent = event.sequence;
    response.write(
      `id: ${String(event.sequence)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    );
  };
  // Subscribe before replaying history: appends landing between the history
  // read and listener registration buffer here instead of being lost.
  const unsubscribe = context.store.onRunEvent(runId, (event) => {
    if (replaying) buffered.push(event);
    else deliver(event);
  });
  for (const event of context.store.listEvents(runId, after)) deliver(event);
  replaying = false;
  for (const event of buffered.splice(0)) deliver(event);
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": heartbeat\n\n");
  }, 15_000);
  request.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
};

const resolveAuthorizedPath = async (
  root: string,
  relativePath: string,
): Promise<string> => {
  const candidate = await realpath(resolve(root, relativePath));
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  if (candidate !== root && !candidate.startsWith(normalizedRoot))
    throw new Error("路径超出目标授权范围");
  return candidate;
};

const safeRelativePath = (value: string): string => {
  const unified = value.replaceAll("\\", "/");
  if (unified.startsWith("/"))
    throw new WorkbenchApiError("invalid_path", "路径超出目标授权范围", [
      { path: value, message: "不接受绝对路径" },
    ]);
  const normalized = unified.replace(/\/+$/gu, "");
  if (normalized === "") return "";
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".." || part === "." || part === ""))
    throw new WorkbenchApiError("invalid_path", "路径超出目标授权范围", [
      { path: value, message: "不接受路径穿越" },
    ]);
  return parts.join("/");
};

const isAuthorized = (
  request: IncomingMessage,
  token: string,
  url: URL,
): boolean => {
  const authorization = request.headers.authorization;
  const supplied = request.headers["x-rea-workbench-token"];
  return (
    authorization === `Bearer ${token}` ||
    supplied === token ||
    url.searchParams.get("token") === token
  );
};

const isAllowedOrigin = (
  request: IncomingMessage,
  context: RequestContext,
): boolean => {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  return (
    origin === `http://${context.host}:${String(context.port)}` ||
    origin === `http://localhost:${String(context.port)}`
  );
};

const sendJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void => {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
};

const sendHtml = (response: ServerResponse, body: string): void => {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  });
  response.end(body);
};

const isJsonRecord = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const parsePort = (value: string | undefined): number | undefined => {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536
    ? parsed
    : undefined;
};
const boundedNumber = (
  value: string | null,
  fallback: number,
  maximum: number,
): number => {
  const parsed = value === null ? Number.NaN : Number(value);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
};
const boundedSequence = (value: string | null): number => {
  const parsed = value === null ? Number.NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};
const durationMs = (
  startedAt: string | null,
  finishedAt: string | null,
): number | null =>
  startedAt === null || finishedAt === null
    ? null
    : Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
const graphCounts = (
  result: Record<string, JsonValue> | null,
): Record<string, JsonValue> => {
  const graph = result?.graph;
  if (!isJsonRecord(graph)) return { available: false };
  return {
    available: true,
    nodes: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
    edges: Array.isArray(graph.edges) ? graph.edges.length : 0,
  };
};
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const renderWorkbenchHtml = (token: string): string => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>REA Workbench</title><style>
:root{color-scheme:dark;--bg:#0b1020;--panel:#121a2c;--panel2:#18233a;--line:#2a3857;--text:#e9efff;--muted:#91a0bd;--accent:#72a7ff;--ok:#55d6a1;--warn:#ffc56b;--bad:#ff7c92}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button,input,select,textarea{font:inherit;color:inherit;background:#0e172b;border:1px solid var(--line);border-radius:7px;padding:8px 10px}button{cursor:pointer;background:#21345a;border-color:#395b97}button:hover{background:#2c4880}button.ghost{background:transparent}.shell{display:grid;grid-template-columns:300px 1fr;min-height:100vh}.sidebar{border-right:1px solid var(--line);padding:18px;background:#0d1528}.brand{font-weight:700;font-size:18px;letter-spacing:.02em;margin-bottom:18px}.muted{color:var(--muted)}.section{margin:18px 0}.section h3{font-size:12px;text-transform:uppercase;color:var(--muted);letter-spacing:.08em;margin:0 0 8px}.row{display:flex;gap:8px;align-items:center}.stack{display:flex;flex-direction:column;gap:8px}.project{padding:10px;border:1px solid transparent;border-radius:8px;cursor:pointer}.project.active{background:var(--panel2);border-color:#385385}.target,.run{padding:9px;border-top:1px solid var(--line);cursor:pointer}.target:hover,.run:hover{background:#15213a}.pill{display:inline-flex;align-items:center;border-radius:999px;padding:2px 8px;font-size:11px;background:#263657;color:var(--muted)}.pill.ok{color:#081b16;background:#55d6a1}.pill.warn{color:#211708;background:#ffc56b}.pill.bad{color:#260812;background:#ff7c92}.main{min-width:0}.topbar{display:flex;align-items:center;justify-content:space-between;padding:17px 22px;border-bottom:1px solid var(--line);background:#0d1528;position:sticky;top:0;z-index:2}.topbar h1{font-size:17px;margin:0}.content{padding:22px;max-width:1500px}.cards{display:grid;grid-template-columns:repeat(4,minmax(130px,1fr));gap:12px}.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}.card .label{color:var(--muted);font-size:12px}.card .value{font-size:21px;font-weight:650;margin-top:5px}.workspace{display:grid;grid-template-columns:220px minmax(0,1fr) 320px;gap:14px;margin-top:14px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;min-height:180px;overflow:hidden}.panel h2{font-size:13px;padding:12px 14px;margin:0;border-bottom:1px solid var(--line)}.panel-body{padding:12px 14px}.steps{padding:6px 0}.step{display:flex;gap:8px;align-items:flex-start;padding:9px 12px}.step .dot{width:9px;height:9px;border-radius:50%;background:#415273;margin-top:5px;flex:none}.step.running .dot{background:var(--accent);box-shadow:0 0 0 4px #72a7ff22}.step.succeeded .dot{background:var(--ok)}.step.failed .dot{background:var(--bad)}.step .name{font-size:13px}.step .message{font-size:11px;color:var(--muted);margin-top:2px}.timeline{max-height:420px;overflow:auto}.event{padding:7px 0;border-bottom:1px solid #20304c;font-size:12px}.event strong{color:var(--accent);font-weight:550}.tabs{display:flex;gap:7px;margin:14px 0}.tabs button.active{background:#395b97}.tab{display:none}.tab.active{display:block}.graph{height:420px;overflow:auto;background:#0b1221;border-top:1px solid var(--line)}.node{display:flex;gap:8px;padding:7px 10px;border-bottom:1px solid #17243d;align-items:center}.node-kind{color:var(--accent);font-size:11px;min-width:135px}.node-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.code{white-space:pre-wrap;word-break:break-word;background:#0a1120;padding:14px;border-radius:8px;min-height:300px;overflow:auto;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}.empty{color:var(--muted);padding:18px;text-align:center}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.form-grid label{display:flex;flex-direction:column;gap:5px;color:var(--muted);font-size:12px}.form-grid label.full{grid-column:1/-1}.form-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}@media(max-width:1100px){.shell{grid-template-columns:240px 1fr}.workspace{grid-template-columns:190px minmax(0,1fr)}.workspace>.panel:last-child{grid-column:1/-1}}@media(max-width:760px){.shell{display:block}.sidebar{border-right:0;border-bottom:1px solid var(--line)}.cards{grid-template-columns:repeat(2,1fr)}.workspace{display:block}.panel{margin-top:12px}}
</style></head><body><div id="app"></div><script>window.__REA_WORKBENCH_TOKEN__=${JSON.stringify(token)};</script><script>
const token=window.__REA_WORKBENCH_TOKEN__, state={projects:[],targets:[],runs:[],workflows:[],project:null,target:null,run:null,events:[],steps:[],graph:null,graphNodes:[],graphCursor:null,graphTotal:0,graphFilter:{search:'',kind:''},nodeDetail:null,nodeDetailId:null,diff:null,files:[],source:null,tab:'timeline',eventSource:null};
const api=async(path,options={})=>{const res=await fetch(path,{...options,headers:{'Content-Type':'application/json','X-REA-Workbench-Token':token,...(options.headers||{})}});const data=await res.json();if(!res.ok)throw new Error(data.error?.message||'请求失败');return data};
const esc=value=>String(value??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmtTime=value=>value?new Date(value).toLocaleString():'—';
const statusClass=s=>['succeeded','complete'].includes(s)?'ok':['failed','cancelled','interrupted'].includes(s)?'bad':['running','starting','cancelling','queued','finalizing'].includes(s)?'warn':'';
const statusText=s=>({queued:'排队中',starting:'启动中',running:'运行中',finalizing:'收尾中',succeeded:'成功',failed:'失败',cancelling:'取消中',cancelled:'已取消',interrupted:'已中断',unknown:'未知'}[s]||s);
const render=()=>{document.getElementById('app').innerHTML=\`<div class="shell"><aside class="sidebar"><div class="brand">REA Workbench</div><div class="muted">本地分析与流程调试台</div><div class="section"><h3>项目</h3><div class="stack">\${state.projects.map(p=>\`<div class="project \${state.project?.id===p.id?'active':''}" onclick="selectProject('\${p.id}')"><div>\${esc(p.name)}</div><small class="muted">\${esc(p.description||'未填写说明')}</small></div>\`).join('')||'<div class="empty">还没有项目</div>'}</div><div class="form-actions"><button class="ghost" onclick="newProject()">+ 新建项目</button></div></div>\${state.project?'<div class="section"><h3>目标</h3><div class="stack">'+(state.targets.map(t=>\`<div class="target" onclick="selectTarget('\${t.id}')"><div>\${esc(t.path.split('/').pop()||t.path)}</div><small class="muted">\${esc(t.path)}</small></div>\`).join('')||'<div class="empty">登记目录或 ASAR</div>')+'</div><div class="form-actions"><button class="ghost" onclick="newTarget()">+ 登记目标</button></div></div>':''}<div class="section"><h3>最近运行</h3><div class="stack">\${state.runs.slice(0,8).map(r=>\`<div class="run" onclick="selectRun('\${r.id}')"><div class="row"><span class="pill \${statusClass(r.state)}">\${statusText(r.state)}</span><span class="muted">\${fmtTime(r.createdAt)}</span></div><small class="muted">\${esc(r.id.slice(0,8))} · \${esc(r.resultCompleteness)}</small></div>\`).join('')||'<div class="empty">暂无运行</div>'}</div></div></aside><main class="main"><header class="topbar"><div><h1>\${esc(state.run?'运行工作台':'项目首页')}</h1><div class="muted">\${esc(state.project?.name||'选择一个项目开始')}</div></div><div class="row">\${state.run?\`<span class="pill \${statusClass(state.run.state)}">\${statusText(state.run.state)}</span>\${['queued','starting','running','cancelling'].includes(state.run.state)?'<button onclick="cancelRun()">取消运行</button>':''}<button class="ghost" onclick="downloadEvidence()">导出</button><button class="ghost" onclick="compareCurrentRun()">比较</button>\` : ''}<button class="ghost" onclick="refresh()">刷新</button></div></header><section class="content">\${state.run?runView():homeView()}</section></main></div>\`};
const homeView=()=>{const r=state.runs[0];return \`<div class="cards"><div class="card"><div class="label">目标</div><div class="value">\${state.targets.length}</div></div><div class="card"><div class="label">运行</div><div class="value">\${state.runs.length}</div></div><div class="card"><div class="label">成功</div><div class="value">\${state.runs.filter(x=>x.state==='succeeded').length}</div></div><div class="card"><div class="label">Provider</div><div class="value" style="font-size:15px">REA JS</div></div></div><div class="panel" style="margin-top:14px"><h2>开始一次分析</h2><div class="panel-body"><p class="muted">首期工作台复用 REA 的 JavaScript/Electron 静态分析工作流，不执行目标代码。</p>\${state.project?'<button onclick="newRun()">新建运行</button>':'<button onclick="newProject()">先创建项目</button>'}</div></div>\${r?'<div class="panel" style="margin-top:14px"><h2>最近运行</h2><div class="panel-body"><button onclick="selectRun(\\''+r.id+'\\')">打开最近运行</button></div></div>':''}\`};
const runView=()=>{const summary=state.run.resultSummary||{},stats=summary.statistics||{};return \`<div class="cards"><div class="card"><div class="label">状态</div><div class="value"><span class="pill \${statusClass(state.run.state)}">\${statusText(state.run.state)}</span></div></div><div class="card"><div class="label">源码文件</div><div class="value">\${stats.parsed_javascript_files??'—'}</div></div><div class="card"><div class="label">模块</div><div class="value">\${stats.modules??'—'}</div></div><div class="card"><div class="label">Evidence</div><div class="value" style="font-size:12px;word-break:break-all">\${esc(state.run.evidenceId||'尚未生成')}</div></div></div><div class="tabs"><button class="\${state.tab==='timeline'?'active':''}" onclick="setTab('timeline')">执行时间线</button><button class="\${state.tab==='graph'?'active':''}" onclick="setTab('graph')">结果图</button><button class="\${state.tab==='source'?'active':''}" onclick="setTab('source')">源码</button><button class="\${state.tab==='evidence'?'active':''}" onclick="setTab('evidence')">Evidence</button><button class="\${state.tab==='diff'?'active':''}" onclick="setTab('diff')">差异</button></div><div class="workspace"><div class="panel"><h2>步骤</h2><div class="steps">\${state.steps.map(s=>\`<div class="step \${s.state}"><span class="dot"></span><div><div class="name">\${esc(s.name)}</div><div class="message">\${esc(s.message||statusText(s.state))}</div></div></div>\`).join('')||'<div class="empty">等待事件</div>'}</div></div><div class="panel"><h2>\${state.tab==='timeline'?'执行时间线':state.tab==='graph'?'关系图':state.tab==='diff'?'运行差异':state.tab==='source'?'源码查看':'Evidence 详情'}</h2><div class="panel-body"><div class="tab \${state.tab==='timeline'?'active':''}"><div class="timeline">\${state.events.slice().reverse().map(e=>\`<div class="event"><strong>\${esc(e.type)}</strong> <span class="muted">#\${e.sequence} · \${fmtTime(e.timestamp)}</span><div>\${esc(e.payload?.message||e.payload?.phase||e.payload?.state||'')}</div></div>\`).join('')||'<div class="empty">还没有事件</div>'}</div></div><div class="tab \${state.tab==='graph'?'active':''}"><div class="row"><input id="graphSearch" placeholder="搜索节点（标签或 ID）" value="\${esc(state.graphFilter.search)}" onchange="applyGraphFilter()"><select id="graphKind" onchange="applyGraphFilter()"><option value="">全部类型</option>\${graphKindOptions()}</select><button class="ghost" onclick="applyGraphFilter()">筛选</button></div><div class="graph">\${graphNodesHtml()}</div></div><div class="tab \${state.tab==='diff'?'active':''}"><div class="row"><input id="diffAgainst" placeholder="对比的运行 ID" style="flex:1"><button onclick="runDiffFromInput()">比较</button></div><div class="graph">\${diffHtml()}</div></div><div class="tab \${state.tab==='source'?'active':''}"><div class="row"><select id="fileSelect" onchange="loadSource(this.value)"><option value="">选择源码文件</option>\${state.files.filter(f=>f.kind==='file').map(f=>\`<option value="\${esc(f.path)}">\${esc(f.path)}</option>\`).join('')}</select><button class="ghost" onclick="loadFiles()">刷新文件</button></div><p class="muted" style="font-size:11px">\${state.run.sourceSnapshot?.format==='asar'?\`读取自运行快照 <span class="pill">\${esc(String(state.run.sourceSnapshot.sha256).slice(0,12))}</span>（目标文件后续变化不影响本运行内容）\`:'读取自原始目标文件（只读，随目标变化）'}</p><pre class="code" id="sourceCode">\${esc(state.source?.content||'选择文件后查看；工作台只读显示源码。')}</pre></div><div class="tab \${state.tab==='evidence'?'active':''}"><pre class="code">\${esc(state.evidence?JSON.stringify(state.evidence,null,2):'切换到此页后加载 Evidence')}</pre></div></div></div><aside class="panel"><h2>上下文</h2><div class="panel-body"><p><span class="muted">目标</span><br>\${esc(state.target?.path||'—')}</p><p><span class="muted">流程</span><br>\${esc(state.run.workflowId)} @ \${esc(state.run.workflowVersion)}</p><p><span class="muted">开始</span><br>\${fmtTime(state.run.startedAt)}</p><p><span class="muted">结束</span><br>\${fmtTime(state.run.finishedAt)}</p><p><span class="muted">结果完整性</span><br><span class="pill \${statusClass(state.run.resultCompleteness)}">\${esc(state.run.resultCompleteness)}</span></p><p><span class="muted">清理</span><br>\${esc(state.run.cleanupStatus)}</p>\${state.run.error?'<p style="color:var(--bad)">'+esc(state.run.error.message)+'</p>':''}</div></aside></div>\`};
async function refresh(){try{state.projects=await api('/api/projects');if(state.project)state.project=state.projects.find(p=>p.id===state.project.id)||state.projects[0]||null;else state.project=state.projects[0]||null;if(state.project)state.targets=await api('/api/projects/'+state.project.id+'/targets');state.runs=await api('/api/runs'+(state.project?'?project_id='+encodeURIComponent(state.project.id):''));if(state.run){state.run=await api('/api/runs/'+state.run.id);state.steps=await api('/api/runs/'+state.run.id+'/steps')}render()}catch(e){alert(e.message)}}
async function selectProject(id){state.project=state.projects.find(p=>p.id===id)||null;state.run=null;state.target=null;await refresh()}
async function selectTarget(id){state.target=state.targets.find(t=>t.id===id)||null;render()}
async function selectRun(id){state.run=await api('/api/runs/'+id);state.project=state.projects.find(p=>p.id===state.run.projectId)||null;state.targets=state.project?await api('/api/projects/'+state.project.id+'/targets'):[];state.target=state.targets.find(t=>t.id===state.run.targetId)||null;state.steps=await api('/api/runs/'+id+'/steps');state.events=await api('/api/runs/'+id+'/events?format=json&after=0').catch(()=>[]);subscribe();render()}
function setTab(tab){state.tab=tab;render();if(tab==='graph'&&!state.graphNodes.length)loadGraphNodes(true);if(tab==='evidence'&&!state.evidence)loadEvidence();if(tab==='source'&&!state.files.length)loadFiles()}
function graphKindOptions(){const kinds=[...new Set(state.graphNodes.map(n=>n.kind))];if(state.graphFilter.kind&&!kinds.includes(state.graphFilter.kind))kinds.push(state.graphFilter.kind);return kinds.map(k=>'<option value="'+esc(k)+'"'+(state.graphFilter.kind===k?' selected':'')+'>'+esc(k)+'</option>').join('')}
function graphNodesHtml(){if(!state.graphNodes.length)return '<div class="empty">没有匹配的节点</div>';const rows=state.graphNodes.map(n=>'<div class="node" onclick="openNode(''+esc(n.node_id)+'')"><span class="node-kind">'+esc(n.kind)+'</span><span class="node-label">'+esc(n.label||n.node_id)+'</span></div>').join('');const more=state.graphCursor?'<div style="padding:8px;text-align:center"><button class="ghost" onclick="loadMoreGraph()">加载更多（已 '+state.graphNodes.length+'/'+state.graphTotal+'）</button></div>':'<div class="empty" style="font-size:11px">共 '+state.graphTotal+' 个节点</div>';const detail=state.nodeDetail?nodeDetailHtml():'';return rows+more+detail}
function nodeDetailHtml(){const d=state.nodeDetail;const locs=(d.node&&d.node.locations||[]).map(l=>esc(typeof l==='string'?l:(l.path||JSON.stringify(l)))).join('<br>');return '<div style="border-top:1px solid var(--line);padding:10px"><div><strong>'+esc((d.node&&d.node.label)||state.nodeDetailId||'')+'</strong> <span class="pill">'+esc((d.node&&d.node.kind)||'')+'</span></div><div class="muted" style="font-size:11px">入边 '+d.in_degree+' · 出边 '+d.out_degree+' · 图 '+esc(String(d.graph_id||'').slice(0,12))+'</div><div class="muted" style="font-size:11px;word-break:break-all">'+(locs||'无源码位置')+'</div><div style="margin-top:6px"><button class="ghost" onclick="expandNeighbors()">展开邻居</button> <button class="ghost" onclick="state.nodeDetail=null;render()">关闭</button></div></div>'}
async function loadGraphNodes(reset){try{if(reset){state.graphNodes=[];state.graphCursor=null}const params=new URLSearchParams({limit:'100'});if(state.graphFilter.search)params.set('search',state.graphFilter.search);if(state.graphFilter.kind)params.set('kind',state.graphFilter.kind);if(!reset&&state.graphCursor)params.set('cursor',state.graphCursor);const pageData=await api('/api/runs/'+state.run.id+'/graph/nodes?'+params.toString());const seen=new Set(state.graphNodes.map(n=>n.node_id));for(const n of pageData.nodes)if(!seen.has(n.node_id)){state.graphNodes.push(n);seen.add(n.node_id)}state.graphCursor=pageData.cursor;state.graphTotal=pageData.total;render()}catch(e){alert(e.message)}}
async function loadMoreGraph(){await loadGraphNodes(false)}
async function applyGraphFilter(){state.graphFilter={search:document.getElementById('graphSearch')?document.getElementById('graphSearch').value:'',kind:document.getElementById('graphKind')?document.getElementById('graphKind').value:''};await loadGraphNodes(true)}
async function openNode(id){try{state.nodeDetail=await api('/api/runs/'+state.run.id+'/graph/nodes/'+encodeURIComponent(id));state.nodeDetailId=id;render()}catch(e){alert(e.message)}}
async function expandNeighbors(){const target=state.nodeDetailId||(state.nodeDetail&&state.nodeDetail.node&&state.nodeDetail.node.node_id);if(!target)return;try{const data=await api('/api/runs/'+state.run.id+'/graph/neighbors?node_id='+encodeURIComponent(target)+'&limit=50');const seen=new Set(state.graphNodes.map(n=>n.node_id));for(const n of data.nodes)if(!seen.has(n.node_id)){state.graphNodes.push(n);seen.add(n.node_id)}alert('展开邻居 '+data.nodes.length+' 个'+(data.truncated?'（已截断）':''));render()}catch(e){alert(e.message)}}
function diffHtml(){const d=state.diff;if(!d)return '<div class="empty">输入另一个运行 ID，比较节点与边变化</div>';if(d.status!=='compared')return '<div class="empty">'+esc((d.limitations||[]).join('；')||'差异不可用')+'</div>';const s=d.summary;const rows=(d.changes||[]).map(c=>{const loc=(c.locations||[])[0];const where=loc?(typeof loc==='string'?loc:(loc.path||JSON.stringify(loc))):(c.right_node_id||c.left_node_id||'');return '<div class="event"><strong>'+esc(c.status)+'</strong> <span class="muted">'+esc(c.node_kind)+'</span><div>'+esc(where)+'</div></div>'}).join('')||'<div class="empty">两运行的节点没有变化</div>';return '<div class="cards" style="grid-template-columns:repeat(5,minmax(0,1fr))"><div class="card"><div class="label">新增</div><div class="value">'+s.added+'</div></div><div class="card"><div class="label">删除</div><div class="value">'+s.removed+'</div></div><div class="card"><div class="label">修改</div><div class="value">'+s.changed+'</div></div><div class="card"><div class="label">未变</div><div class="value">'+s.unchanged+'</div></div><div class="card"><div class="label">未知</div><div class="value">'+s.unknown+'</div></div></div><div class="muted" style="font-size:11px;margin:8px 0">覆盖：'+esc(String((d.coverage&&d.coverage.status)||'—'))+((d.limitations||[]).length?'；'+esc(d.limitations.join('；')):'')+'</div><div class="timeline" style="max-height:320px">'+rows+'</div>'}
async function runDiffFromInput(){const input=document.getElementById('diffAgainst');if(!input||!input.value)return;try{state.diff=await api('/api/runs/'+state.run.id+'/graph/diff?against='+encodeURIComponent(input.value.trim())+'&change=all&limit=50');render()}catch(e){alert(e.message)}}
async function loadEvidence(){try{state.evidence=await api('/api/runs/'+state.run.id+'/evidence');render()}catch(e){alert(e.message)}}
async function downloadEvidence(){if(!state.run)return;try{const res=await fetch('/api/runs/'+state.run.id+'/export',{headers:{'X-REA-Workbench-Token':token}});if(!res.ok)throw new Error('Evidence 尚未生成');const blob=await res.blob();const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='rea-workbench-'+state.run.id+'.json';link.click();URL.revokeObjectURL(link.href)}catch(e){alert(e.message)}}
async function compareCurrentRun(){state.tab='diff';render();setTimeout(()=>{const input=document.getElementById('diffAgainst');if(input)input.focus()},0)}
async function loadFiles(){try{state.files=await api('/api/runs/'+state.run.id+'/files');render()}catch(e){alert(e.message)}}
async function loadSource(path){if(!path)return;try{state.source=await api('/api/runs/'+state.run.id+'/source?path='+encodeURIComponent(path));render()}catch(e){alert(e.message)}}
function subscribe(){if(state.eventSource)state.eventSource.close();if(!state.run)return;state.eventSource=new EventSource('/api/runs/'+state.run.id+'/events?token='+encodeURIComponent(token)+'&after='+(state.events.at(-1)?.sequence||0));state.eventSource.addEventListener('step.progress',onEvent);state.eventSource.addEventListener('step.started',onEvent);state.eventSource.addEventListener('step.finished',onEvent);state.eventSource.addEventListener('run.finished',onEvent);state.eventSource.addEventListener('diagnostic.reported',onEvent);state.eventSource.addEventListener('evidence.recorded',onEvent)}
async function onEvent(event){const item=JSON.parse(event.data);if(!state.events.some(e=>e.sequence===item.sequence))state.events.push(item);state.steps=await api('/api/runs/'+state.run.id+'/steps');state.run=await api('/api/runs/'+state.run.id);render();if(['succeeded','failed','cancelled','interrupted'].includes(state.run.state))state.eventSource?.close()}
async function cancelRun(){if(state.run)try{state.run=await api('/api/runs/'+state.run.id+'/cancel',{method:'POST',body:'{}'});render()}catch(e){alert(e.message)}}
function newProject(){const name=prompt('项目名称');if(!name)return;const description=prompt('项目说明')||'';api('/api/projects',{method:'POST',body:JSON.stringify({name,description})}).then(refresh).catch(e=>alert(e.message))}
function newTarget(){if(!state.project)return;const path=prompt('目标绝对路径（目录或 ASAR）');if(!path)return;api('/api/projects/'+state.project.id+'/targets',{method:'POST',body:JSON.stringify({path,format:path.toLowerCase().endsWith('.asar')?'asar':'auto'})}).then(refresh).catch(e=>alert(e.message))}
function newRun(){if(!state.project){alert('请先创建项目');return}if(!state.targets.length){alert('请先登记目标');return}const target=state.target||state.targets[0];const integrity=prompt('完整性策略：fail 或 record-and-continue','fail')||'fail';const idempotencyKey=(self.crypto&&crypto.randomUUID)?crypto.randomUUID():'run-'+Date.now()+'-'+Math.random().toString(36).slice(2);api('/api/runs',{method:'POST',headers:{'Idempotency-Key':idempotencyKey},body:JSON.stringify({project_id:state.project.id,target_id:target.id,parameters:{integrity_policy:integrity}})}).then(r=>selectRun(r.id)).catch(e=>alert(e.message))}
refresh();
</script></body></html>`;
