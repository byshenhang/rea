import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPackage } from "@electron/asar";
import { beforeAll, expect, it } from "vitest";

import {
  createWorkbenchServer,
  listenWorkbenchServer,
  type WorkbenchServerHandle,
} from "../../../src/workbench/server.js";
import { defaultWorkflow } from "../../../src/workbench/store.js";

const TOKEN = "workbench-asar-test-token";
const OVERSIZED_SOURCE = `${"export const filler = 1;\n".repeat(60_000)}`;

interface StartedServer {
  readonly handle: WorkbenchServerHandle;
  readonly base: string;
}

const startServer = async (
  maxRunSourceBytes?: number,
): Promise<StartedServer> => {
  const databasePath = join(
    await mkdtemp(join(tmpdir(), "rea-workbench-asar-")),
    "workbench.sqlite",
  );
  const handle = createWorkbenchServer({
    port: 0,
    token: TOKEN,
    databasePath,
    ...(maxRunSourceBytes === undefined ? {} : { maxRunSourceBytes }),
  });
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
  options: { readonly oversized?: boolean } = {},
): Promise<{ readonly archivePath: string; readonly sourceDir: string }> => {
  const root = await mkdtemp(join(tmpdir(), "rea-workbench-asar-src-"));
  const sourceDir = join(root, "app");
  await mkdir(join(sourceDir, "nested"), { recursive: true });
  await writeFile(
    join(sourceDir, "package.json"),
    JSON.stringify({ name: "snapshot-app", main: "index.js" }),
  );
  await writeFile(
    join(sourceDir, "index.js"),
    "export const main = () => 'snapshot-marker-original';\n",
  );
  await writeFile(join(sourceDir, "nested", "readme.md"), "# 快照内文档\n");
  if (options.oversized === true) {
    await writeFile(
      join(sourceDir, "logo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
    );
    await writeFile(join(sourceDir, "big.js"), OVERSIZED_SOURCE);
  }
  const archivePath = join(root, "app.asar");
  await createPackage(sourceDir, archivePath);
  return { archivePath, sourceDir };
};

const runAnalysisOverAsar = async (
  base: string,
  archivePath: string,
): Promise<string> => {
  const project = (await (
    await call(base, "/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "ASAR 快照" }),
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

// One shared analysis run covers the snapshot-identity and rejection suites;
// each test asserts a different facet of the same finished run.
const shared: { server?: StartedServer; runId?: string; archivePath?: string } =
  {};

beforeAll(async () => {
  shared.server = await startServer();
  const fixture = await buildAsarFixture({ oversized: true });
  shared.archivePath = fixture.archivePath;
  shared.runId = await runAnalysisOverAsar(
    shared.server.base,
    fixture.archivePath,
  );
}, 180_000);

it("pins ASAR source browsing to the run's fixed snapshot identity", async () => {
  const { base } = shared.server!;
  const runId = shared.runId!;

  const run = (await (await call(base, `/api/runs/${runId}`)).json()) as {
    sourceSnapshot: { format: string; sha256: string; bytes: number } | null;
  };
  expect(run.sourceSnapshot).toMatchObject({ format: "asar" });
  expect(run.sourceSnapshot?.sha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(run.sourceSnapshot?.bytes ?? 0).toBeGreaterThan(0);

  const tree = (await (
    await call(base, `/api/runs/${runId}/files`)
  ).json()) as Array<{ path: string; kind: string }>;
  expect(tree.map((entry) => entry.path)).toEqual(
    expect.arrayContaining([
      "big.js",
      "index.js",
      "logo.png",
      "nested",
      "package.json",
    ]),
  );

  const nested = (await (
    await call(base, `/api/runs/${runId}/files?prefix=nested`)
  ).json()) as Array<{ path: string }>;
  expect(nested.map((entry) => entry.path)).toEqual(["nested/readme.md"]);

  const source = (await (
    await call(base, `/api/runs/${runId}/source?path=index.js`)
  ).json()) as {
    content: string;
    origin: string;
    snapshot_sha256?: string;
  };
  expect(source.content).toContain("snapshot-marker-original");
  expect(source.origin).toBe("run-snapshot");
  expect(source.snapshot_sha256).toBe(run.sourceSnapshot?.sha256);

  const events = (await (
    await call(base, `/api/runs/${runId}/events?format=json`)
  ).json()) as Array<{ type: string; payload: Record<string, unknown> }>;
  const snapshotEvent = events.find(
    (event) =>
      event.type === "artifact.available" &&
      event.payload.kind === "source-snapshot",
  );
  expect(snapshotEvent?.payload.snapshot_sha256).toBe(
    run.sourceSnapshot?.sha256,
  );

  // Overwrite the target archive after the run: snapshot reads stay fixed.
  const { sourceDir: replacementSource } = await buildAsarFixture();
  await writeFile(
    join(replacementSource, "index.js"),
    "export const main = () => 'REPLACED';\n",
  );
  const replacement = `${shared.archivePath}.replacement`;
  await createPackage(replacementSource, replacement);
  await rm(shared.archivePath!, { force: true });
  await copyFile(replacement, shared.archivePath!);
  const after = (await (
    await call(base, `/api/runs/${runId}/source?path=index.js`)
  ).json()) as { content: string };
  expect(after.content).toContain("snapshot-marker-original");
  expect(after.content).not.toContain("REPLACED");
}, 60_000);

it("rejects traversal, absolute paths, and non-text members with the unified envelope", async () => {
  const { base } = shared.server!;
  const runId = shared.runId!;

  const expectRejected = async (path: string, code: string): Promise<void> => {
    const response = await call(
      base,
      `/api/runs/${runId}/source?path=${encodeURIComponent(path)}`,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe(code);
  };
  await expectRejected("../outside.js", "invalid_path");
  await expectRejected("a/../../outside.js", "invalid_path");
  await expectRejected("/etc/passwd", "invalid_path");
  await expectRejected("missing.js", "source_not_file");
  await expectRejected("logo.png", "source_not_text");

  const oversized = await call(base, `/api/runs/${runId}/source?path=big.js`);
  expect(oversized.status).toBe(413);
  const oversizedBody = (await oversized.json()) as { error: { code: string } };
  expect(oversizedBody.error.code).toBe("source_too_large");
}, 60_000);

it("enforces the cumulative read budget and records one diagnostic", async () => {
  const server = await startServer(30);
  try {
    const fixture = await buildAsarFixture();
    const runId = await runAnalysisOverAsar(server.base, fixture.archivePath);

    const first = await call(
      server.base,
      `/api/runs/${runId}/source?path=nested/readme.md`,
    );
    expect(first.status).toBe(200);
    const second = await call(
      server.base,
      `/api/runs/${runId}/source?path=index.js`,
    );
    expect(second.status).toBe(413);
    const body = (await second.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("source_too_large");

    const events = (await (
      await call(server.base, `/api/runs/${runId}/events?format=json`)
    ).json()) as Array<{ type: string; payload: Record<string, unknown> }>;
    const limits = events.filter(
      (event) =>
        event.type === "diagnostic.reported" &&
        event.payload.kind === "source-read-limit",
    );
    expect(limits).toHaveLength(1);
  } finally {
    await server.handle.close();
  }
}, 120_000);

it("keeps directory targets on live authorized reads and labels them as target files", async () => {
  const server = await startServer();
  try {
    const sourceDir = await mkdtemp(join(tmpdir(), "rea-workbench-dir-"));
    await writeFile(
      join(sourceDir, "main.js"),
      "export const origin = 'target-file';\n",
    );
    const project = (await (
      await call(server.base, "/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: "目录目标" }),
      })
    ).json()) as { id: string };
    const target = (await (
      await call(server.base, `/api/projects/${project.id}/targets`, {
        method: "POST",
        body: JSON.stringify({ path: sourceDir, format: "directory" }),
      })
    ).json()) as { id: string };
    const create = await call(server.base, "/api/runs", {
      method: "POST",
      body: JSON.stringify({ project_id: project.id, target_id: target.id }),
    });
    const run = (await create.json()) as { id: string };
    expect(await waitForTerminalState(server.base, run.id, 120_000)).toBe(
      "succeeded",
    );

    const detail = (await (
      await call(server.base, `/api/runs/${run.id}`)
    ).json()) as { sourceSnapshot: { format: string } | null };
    expect(detail.sourceSnapshot).toEqual({ format: "directory" });

    const files = (await (
      await call(server.base, `/api/runs/${run.id}/files`)
    ).json()) as Array<{ path: string }>;
    expect(files.map((entry) => entry.path)).toEqual(["main.js"]);
    const source = (await (
      await call(server.base, `/api/runs/${run.id}/source?path=main.js`)
    ).json()) as { origin: string; content: string };
    expect(source.origin).toBe("target-file");
    expect(source.content).toContain("target-file");
  } finally {
    await server.handle.close();
  }
}, 120_000);

it("registers the pinned first-phase workflow for asar runs", async () => {
  const workflows = (await (
    await call(shared.server!.base, "/api/workflows")
  ).json()) as Array<{ supportedTargets: string[] }>;
  const pinned = defaultWorkflow();
  expect(workflows).toContainEqual(
    expect.objectContaining({
      workflowId: pinned.workflowId,
      supportedTargets: ["directory", "asar"],
    }),
  );
});
