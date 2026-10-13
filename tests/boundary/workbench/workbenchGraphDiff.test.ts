import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPackage } from "@electron/asar";
import { expect, it } from "vitest";

import {
  createWorkbenchServer,
  listenWorkbenchServer,
  type WorkbenchServerHandle,
} from "../../../src/workbench/server.js";
import { defaultWorkflow } from "../../../src/workbench/store.js";

const TOKEN = "workbench-graph-diff-test-token";

interface StartedServer {
  readonly handle: WorkbenchServerHandle;
  readonly base: string;
}

const startServer = async (): Promise<StartedServer> => {
  const databasePath = join(
    await mkdtemp(join(tmpdir(), "rea-workbench-diff-db-")),
    "workbench.sqlite",
  );
  const handle = createWorkbenchServer({ port: 0, token: TOKEN, databasePath });
  await listenWorkbenchServer(handle);
  const address = handle.server.address();
  if (address === null || typeof address === "string")
    throw new Error("workbench server did not bind a TCP port");
  return { handle, base: `http://127.0.0.1:${String(address.port)}` };
};

const call = async (
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set("X-REA-Workbench-Token", TOKEN);
  if (init.body !== undefined && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
};

const waitForTerminalState = async (
  base: string,
  runId: string,
  timeoutMs: number,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = (await (await call(base, `/api/runs/${runId}`)).json()) as {
      state: string;
    };
    if (
      ["succeeded", "failed", "cancelled", "interrupted"].includes(
        current.state,
      )
    )
      return current.state;
    if (Date.now() > deadline)
      throw new Error(`运行未在期限内结束，最后状态 ${current.state}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
};

const buildAsarFixture = async (
  options: { readonly extraModule?: boolean } = {},
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "rea-workbench-diff-src-"));
  const sourceDir = join(root, "app");
  await mkdir(join(sourceDir, "lib"), { recursive: true });
  await writeFile(
    join(sourceDir, "package.json"),
    JSON.stringify({ name: "diff-app", main: "index.js", version: "1.0.0" }),
  );
  await writeFile(
    join(sourceDir, "index.js"),
    "import { shared } from './lib/shared.js';\nexport const main = () => shared('diff-app');\n",
  );
  await writeFile(
    join(sourceDir, "lib", "shared.js"),
    "export const shared = (name) => name.toUpperCase();\n",
  );
  if (options.extraModule === true)
    await writeFile(
      join(sourceDir, "lib", "extra.js"),
      "export const extraFeature = () => 'extra-marker';\n",
    );
  const archivePath = join(root, "app.asar");
  await createPackage(sourceDir, archivePath);
  return archivePath;
};

const registerAndRun = async (
  base: string,
  archivePath: string,
): Promise<string> => {
  const project = (await (
    await call(base, "/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "图差异" }),
    })
  ).json()) as { id: string };
  const target = (await (
    await call(base, `/api/projects/${project.id}/targets`, {
      method: "POST",
      body: JSON.stringify({ path: archivePath, format: "asar" }),
    })
  ).json()) as { id: string };
  const create = await call(base, "/api/runs", {
    method: "POST",
    body: JSON.stringify({ project_id: project.id, target_id: target.id }),
  });
  expect(create.status).toBe(202);
  const run = (await create.json()) as { id: string };
  expect(await waitForTerminalState(base, run.id, 120_000)).toBe("succeeded");
  return run.id;
};

it("treats two runs of identical target content as the same version, not as churn", async () => {
  const server = await startServer();
  try {
    const archivePath = await buildAsarFixture();
    const leftRun = await registerAndRun(server.base, archivePath);
    const rightRun = await registerAndRun(server.base, archivePath);
    const diff = (await (
      await call(
        server.base,
        `/api/runs/${leftRun}/graph/diff?against=${rightRun}`,
      )
    ).json()) as {
      status: string;
      summary: unknown;
      changes: unknown[];
      limitations: string[];
    };
    expect(diff.status).toBe("unavailable");
    expect(diff.summary).toBeNull();
    expect(diff.changes).toEqual([]);
    expect(diff.limitations.join("")).toContain("同一份应用图证据");
  } finally {
    await server.handle.close();
  }
}, 180_000);

it("reports added and removed nodes with run, evidence, and source-location traceback", async () => {
  const server = await startServer();
  try {
    const baseArchive = await buildAsarFixture();
    const extraArchive = await buildAsarFixture({ extraModule: true });
    const baseRun = await registerAndRun(server.base, baseArchive);
    const extraRun = await registerAndRun(server.base, extraArchive);

    const diff = (await (
      await call(
        server.base,
        `/api/runs/${baseRun}/graph/diff?against=${extraRun}&change=added`,
      )
    ).json()) as {
      status: string;
      summary: { added: number; removed: number };
      changes: Array<{
        status: string;
        node_kind: string;
        right_run_id: string | null;
        evidence_links: string[];
        locations: Array<Record<string, unknown>>;
        limitations: string[];
      }>;
    };
    expect(diff.status).toBe("compared");
    expect(diff.summary.added).toBeGreaterThan(0);
    const extraChange = diff.changes.find((change) =>
      JSON.stringify(change.locations).includes("extra.js"),
    );
    expect(extraChange).toBeDefined();
    expect(extraChange?.right_run_id).toBe(extraRun);
    expect(extraChange?.evidence_links.length).toBeGreaterThan(0);

    const removed = (await (
      await call(
        server.base,
        `/api/runs/${extraRun}/graph/diff?against=${baseRun}&change=removed`,
      )
    ).json()) as {
      summary: { removed: number };
    };
    expect(removed.summary.removed).toBeGreaterThan(0);

    const filtered = (await (
      await call(
        server.base,
        `/api/runs/${baseRun}/graph/diff?against=${extraRun}&change=added&kind=edge`,
      )
    ).json()) as {
      changes: Array<{
        status: string;
        left_node_id: string | null;
        right_node_id: string | null;
      }>;
    };
    expect(
      filtered.changes.every(
        (change) =>
          change.left_node_id === null && change.right_node_id === null,
      ),
    ).toBe(true);
  } finally {
    await server.handle.close();
  }
}, 240_000);

it("refuses to infer additions or removals when either side lacks a graph", async () => {
  const server = await startServer();
  try {
    const archivePath = await buildAsarFixture();
    const goodRun = await registerAndRun(server.base, archivePath);

    const brokenDir = await mkdtemp(
      join(tmpdir(), "rea-workbench-diff-broken-"),
    );
    await writeFile(join(brokenDir, "broken.asar"), "not an archive");
    const project = (await (
      await call(server.base, "/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: "失败运行" }),
      })
    ).json()) as { id: string };
    const target = (await (
      await call(server.base, `/api/projects/${project.id}/targets`, {
        method: "POST",
        body: JSON.stringify({
          path: join(brokenDir, "broken.asar"),
          format: "asar",
        }),
      })
    ).json()) as { id: string };
    const create = await call(server.base, "/api/runs", {
      method: "POST",
      body: JSON.stringify({ project_id: project.id, target_id: target.id }),
    });
    const failedRun = (await create.json()) as { id: string };
    expect(await waitForTerminalState(server.base, failedRun.id, 120_000)).toBe(
      "failed",
    );

    const diff = (await (
      await call(
        server.base,
        `/api/runs/${goodRun}/graph/diff?against=${failedRun.id}`,
      )
    ).json()) as {
      status: string;
      summary: unknown;
      changes: unknown[];
      limitations: string[];
    };
    expect(diff.status).toBe("unavailable");
    expect(diff.summary).toBeNull();
    expect(diff.changes).toEqual([]);
    expect(diff.limitations.join("")).toContain("不推断增删");

    await expect(
      call(server.base, `/api/runs/${goodRun}/graph/diff`),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      call(server.base, `/api/runs/${goodRun}/graph/diff?against=missing-run`),
    ).resolves.toMatchObject({ status: 404 });
  } finally {
    await server.handle.close();
  }
}, 240_000);

it("paginates nodes and edges without loading the whole graph", async () => {
  const server = await startServer();
  try {
    const archivePath = await buildAsarFixture();
    const runId = await registerAndRun(server.base, archivePath);

    const firstPage = (await (
      await call(server.base, `/api/runs/${runId}/graph/nodes?limit=1`)
    ).json()) as {
      total: number;
      cursor: string | null;
      nodes: Array<{
        node_id: string;
        kind: string;
        label: string | null;
        locations: unknown[];
        evidence_ids: string[];
      }>;
      limitations: string[];
    };
    expect(firstPage.total).toBeGreaterThan(1);
    expect(firstPage.nodes).toHaveLength(1);
    expect(firstPage.cursor).not.toBeNull();
    expect(firstPage.nodes[0]?.evidence_ids.length).toBeGreaterThan(0);
    expect(firstPage.nodes[0]?.locations.length ?? 0).toBeGreaterThan(0);

    const collected: string[] = [firstPage.nodes[0]!.node_id];
    let cursor = firstPage.cursor;
    for (let guard = 0; guard < 50 && cursor !== null; guard += 1) {
      const next = (await (
        await call(
          server.base,
          `/api/runs/${runId}/graph/nodes?limit=1&cursor=${cursor}`,
        )
      ).json()) as {
        nodes: Array<{ node_id: string }>;
        cursor: string | null;
      };
      collected.push(next.nodes[0]!.node_id);
      cursor = next.cursor;
    }
    expect(collected).toHaveLength(firstPage.total);
    expect(new Set(collected).size).toBe(collected.length);

    const searched = (await (
      await call(server.base, `/api/runs/${runId}/graph/nodes?search=shared`)
    ).json()) as {
      total: number;
      nodes: Array<{ label: string | null }>;
    };
    expect(searched.total).toBeGreaterThan(0);
    expect(searched.nodes.every((node) => node.label !== null)).toBe(true);

    const edges = (await (
      await call(server.base, `/api/runs/${runId}/graph/edges?limit=2`)
    ).json()) as {
      total: number;
      cursor: string | null;
      edges: Array<{
        edge_id: string;
        relation: string;
        source_node_id: string;
        target_node_id: string;
      }>;
    };
    expect(edges.total).toBeGreaterThan(0);
    expect(edges.edges.length).toBe(Math.min(2, edges.total));
    if (edges.cursor !== null) expect(edges.edges).toHaveLength(2);

    await expect(
      call(server.base, `/api/runs/${runId}/graph/nodes?cursor=-1`),
    ).resolves.toMatchObject({ status: 400 });
  } finally {
    await server.handle.close();
  }
}, 180_000);

it("expands neighbors and exposes node detail with degrees", async () => {
  const server = await startServer();
  try {
    const archivePath = await buildAsarFixture();
    const runId = await registerAndRun(server.base, archivePath);

    const nodes = (await (
      await call(server.base, `/api/runs/${runId}/graph/nodes?limit=200`)
    ).json()) as {
      nodes: Array<{ node_id: string }>;
    };
    expect(nodes.nodes.length).toBeGreaterThan(0);
    const nodeId = nodes.nodes[0]!.node_id;

    const neighbors = (await (
      await call(
        server.base,
        `/api/runs/${runId}/graph/neighbors?node_id=${encodeURIComponent(nodeId)}&direction=both&limit=10`,
      )
    ).json()) as {
      center: { node_id: string };
      nodes: Array<{ node_id: string }>;
      edges: Array<{ source_node_id: string; target_node_id: string }>;
      truncated: boolean;
    };
    expect(neighbors.center.node_id).toBe(nodeId);
    for (const edge of neighbors.edges) {
      expect(
        edge.source_node_id === nodeId || edge.target_node_id === nodeId,
      ).toBe(true);
    }

    const detail = (await (
      await call(
        server.base,
        `/api/runs/${runId}/graph/nodes/${encodeURIComponent(nodeId)}`,
      )
    ).json()) as {
      node: { node_id: string };
      in_degree: number;
      out_degree: number;
      evidence_id: string;
    };
    expect(detail.node.node_id).toBe(nodeId);
    expect(detail.in_degree + detail.out_degree).toBeGreaterThan(0);

    await expect(
      call(
        server.base,
        `/api/runs/${runId}/graph/neighbors?node_id=jag_node_unknown`,
      ),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      call(
        server.base,
        `/api/runs/${runId}/graph/neighbors?node_id=${encodeURIComponent(nodeId)}&direction=sideways`,
      ),
    ).resolves.toMatchObject({ status: 400 });
  } finally {
    await server.handle.close();
  }
}, 180_000);

it("extends POST comparisons with an opt-in graph diff summary", async () => {
  const server = await startServer();
  try {
    const archivePath = await buildAsarFixture();
    const extraArchive = await buildAsarFixture({ extraModule: true });
    const leftRun = await registerAndRun(server.base, archivePath);
    const rightRun = await registerAndRun(server.base, extraArchive);

    const plain = (await (
      await call(server.base, "/api/comparisons", {
        method: "POST",
        body: JSON.stringify({ left_run_id: leftRun, right_run_id: rightRun }),
      })
    ).json()) as { result: { graph_diff?: unknown } };
    expect("graph_diff" in plain.result).toBe(false);

    const withDiff = (await (
      await call(server.base, "/api/comparisons", {
        method: "POST",
        body: JSON.stringify({
          left_run_id: leftRun,
          right_run_id: rightRun,
          include_graph_diff: true,
        }),
      })
    ).json()) as {
      result: {
        graph_diff: {
          comparison_id: string;
          summary: { added: number };
          limitations: string[];
        } | null;
      };
    };
    expect(withDiff.result.graph_diff).not.toBeNull();
    expect(withDiff.result.graph_diff?.summary.added).toBeGreaterThan(0);
    expect(withDiff.result.graph_diff?.comparison_id).toMatch(/^javc_/u);
  } finally {
    await server.handle.close();
  }
}, 240_000);

it("registers the pinned workflow catalog for graph browsing runs", async () => {
  const server = await startServer();
  try {
    const workflows = (await (
      await call(server.base, "/api/workflows")
    ).json()) as Array<{ workflowId: string }>;
    expect(workflows).toContainEqual(
      expect.objectContaining({ workflowId: defaultWorkflow().workflowId }),
    );
  } finally {
    await server.handle.close();
  }
});
