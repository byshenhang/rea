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
  retryRequestDigest,
  retryRunBodySchema,
  runRequestDigest,
  type WorkbenchComparisonResponse,
  type WorkbenchFileEntry,
  type WorkbenchGraphResponse,
  type WorkbenchSourceContent,
} from "./api.js";
import { WorkbenchBundleStore, defaultBundleRoot } from "./bundleStore.js";
import { WORKBENCH_STYLES } from "./ui/styles.js";
import { workbenchUiScript } from "./ui/bootstrap.js";
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
import { recoverInterruptedRuns } from "./recovery.js";
import type { WorkbenchStartupRecoveryReport } from "./recovery.js";
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
  /** Analysis deadline, including source snapshot preparation (default 30 minutes). */
  readonly runTimeoutMs?: number;
}

export interface WorkbenchServerHandle {
  readonly server: Server;
  readonly store: WorkbenchStore;
  readonly bundles: WorkbenchBundleStore;
  readonly manager: WorkbenchRunManager;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  /** Actual listening port, updated by listenWorkbenchServer on bind. */
  boundPort: number;
  completeStartup(): void;
  close(): Promise<void>;
}

/** Create the loopback Workbench API and browser application. */
export const createWorkbenchServer = (
  options: WorkbenchServerOptions = {},
): WorkbenchServerHandle => {
  let startupComplete = false;
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
    ...(options.runTimeoutMs === undefined
      ? {}
      : { runTimeoutMs: options.runTimeoutMs }),
    ...(options.maxRunSourceBytes === undefined
      ? {}
      : { sourceSnapshotLimits: { maxTotalBytes: options.maxRunSourceBytes } }),
  });
  const token =
    options.token ??
    process.env.REA_WORKBENCH_TOKEN ??
    randomBytes(24).toString("hex");
  // The configured port may be 0 (ephemeral); bindPort is updated once the
  // listener is live so origin checks and HTML base URLs use the real port.
  // Late-bound handle reference: the request context reads the live port
  // after listenWorkbenchServer records the ephemeral bind.
  let handleRef: WorkbenchServerHandle | undefined;
  const server = createServer((request, response) => {
    if (!startupComplete) {
      sendJson(response, 503, {
        error: {
          code: "service_starting",
          message: "工作台正在恢复本地运行状态，请稍后重试。",
        },
      });
      return;
    }
    void handleRequest(request, response, {
      host,
      resolvedPort: () => handleRef?.boundPort ?? port,
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
  const handle: WorkbenchServerHandle = {
    server,
    store,
    bundles,
    manager,
    host,
    port,
    token,
    boundPort: port,
    completeStartup: () => {
      startupComplete = true;
    },
    close: async () => {
      const closed = new Promise<void>((resolveClose, reject) =>
        server.close((error) =>
          error === undefined ||
          ("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")
            ? resolveClose()
            : reject(error),
        ),
      );
      // Long-lived SSE clients must not prevent local worker shutdown.
      server.closeAllConnections();
      await Promise.all([closed, manager.dispose()]);
      store.close();
    },
  };
  handleRef = handle;
  return handle;
};

export interface WorkbenchListenReport {
  readonly orphanBundlesRemoved: number;
  readonly orphanBundlesFailed: number;
  readonly runRecovery: WorkbenchStartupRecoveryReport;
}

export const listenWorkbenchServer = async (
  handle: WorkbenchServerHandle,
): Promise<WorkbenchListenReport> => {
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
  const address = handle.server.address();
  if (address !== null && typeof address !== "string")
    handle.boundPort = address.port;
  // Acquire the port before changing durable state: a second start on the
  // same listener must fail without interrupting the live instance's runs.
  const recovery = await handle.bundles.recoverOrphans();
  const runRecovery = recoverInterruptedRuns(handle.store);
  handle.manager.setStartupRecoveryReport(runRecovery);
  handle.completeStartup();
  return {
    orphanBundlesRemoved: recovery.removed.length,
    orphanBundlesFailed: recovery.failed.length,
    runRecovery,
  };
};

interface RequestContext {
  readonly host: string;
  /** Resolved listening port; the configured value may be 0 (ephemeral). */
  readonly resolvedPort: () => number;
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
    `http://${context.host}:${String(context.resolvedPort())}`,
  );
  if (url.pathname === "/" && request.method === "GET")
    return sendHtml(
      response,
      renderWorkbenchHtml(context.token).replace("__TOKEN__", context.token),
    );
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
  if (request.method === "GET" && url.pathname === "/api/diagnostics")
    return sendJson(response, 200, {
      ...context.manager.diagnostics(),
      databasePath: context.store.databasePath,
      bundleRoot: context.bundles.root,
    });
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
    /^\/api\/runs\/[^/]+\/retry$/u.test(url.pathname)
  )
    return retryRun(
      request,
      response,
      context,
      decodeURIComponent(url.pathname.split("/")[3] ?? ""),
    );
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

const retryRun = async (
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
  runId: string,
): Promise<void> => {
  await parseJsonBody(request, retryRunBodySchema);
  const key = parseIdempotencyKey(request.headers[idempotencyKeyHeader]);
  try {
    const { run, replayed } = await context.manager.retryRun({
      runId,
      ...(key === null
        ? {}
        : { idempotency: { key, requestDigest: retryRequestDigest(runId) } }),
    });
    sendJson(
      response,
      202,
      run,
      replayed ? { "idempotency-replayed": "true" } : undefined,
    );
  } catch (cause: unknown) {
    if (cause instanceof WorkbenchApiError) throw cause;
    throw new WorkbenchApiError("run_rejected", describeError(cause));
  }
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
  const port = String(context.resolvedPort());
  return (
    origin === `http://${context.host}:${port}` ||
    origin === `http://localhost:${port}`
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
${WORKBENCH_STYLES}
</style></head><body><div id="app"></div><script>
${workbenchUiScript()}
</script></body></html>`;
