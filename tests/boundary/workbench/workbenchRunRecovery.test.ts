import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Script } from "node:vm";

import { expect, it } from "vitest";
import { createPackage } from "@electron/asar";

import {
  createWorkbenchServer,
  listenWorkbenchServer,
  type WorkbenchServerHandle,
} from "../../../src/workbench/server.js";
import {
  WorkbenchStore,
  defaultWorkflow,
} from "../../../src/workbench/store.js";
import type {
  WorkbenchRun,
  WorkbenchRunEvent,
} from "../../../src/workbench/types.js";
import type { WorkbenchManagerDiagnostics } from "../../../src/workbench/runManager.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  createTestProcessRegistry,
  waitForExit,
} from "../../support/process/processFixture.js";

const TOKEN = "workbench-recovery-test";
const pause = (ms: number): Promise<void> =>
  new Promise((resolveWait) => setTimeout(resolveWait, ms));
const call = (
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      "X-REA-Workbench-Token": TOKEN,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

const start = async (
  databasePath: string,
  runTimeoutMs?: number,
): Promise<{ handle: WorkbenchServerHandle; base: string }> => {
  const handle = createWorkbenchServer({
    port: 0,
    databasePath,
    token: TOKEN,
    ...(runTimeoutMs === undefined ? {} : { runTimeoutMs }),
  });
  await listenWorkbenchServer(handle);
  const address = handle.server.address();
  if (address === null || typeof address === "string")
    throw new Error("No TCP address");
  return { handle, base: `http://127.0.0.1:${String(address.port)}` };
};

const register = async (
  base: string,
  path: string,
  format: "directory" | "asar" = "directory",
): Promise<{ project_id: string; target_id: string }> => {
  const project = (await (
    await call(base, "/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "恢复验收" }),
    })
  ).json()) as { id: string };
  const target = (await (
    await call(base, `/api/projects/${project.id}/targets`, {
      method: "POST",
      body: JSON.stringify({ path, format }),
    })
  ).json()) as { id: string };
  return { project_id: project.id, target_id: target.id };
};

const launch = async (
  base: string,
  input: Record<string, unknown>,
): Promise<WorkbenchRun> => {
  const response = await call(base, "/api/runs", {
    method: "POST",
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(202);
  return (await response.json()) as WorkbenchRun;
};

const terminal = async (base: string, id: string): Promise<WorkbenchRun> => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const run = (await (
      await call(base, `/api/runs/${id}`)
    ).json()) as WorkbenchRun;
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(run.state))
      return run;
    await pause(20);
  }
  throw new Error(`Run ${id} did not finish`);
};

const makeTarget = async (root: string, many = false): Promise<string> => {
  const path = join(root, many ? "large-target" : "target");
  await mkdir(path);
  await writeFile(
    join(path, "main.js"),
    "export const recoveryMarker = 'preserved';\n",
  );
  if (many) {
    // Enough inventory work to observe running without executing target code.
    for (let i = 0; i < 1000; i += 1)
      await writeFile(
        join(path, `module-${String(i)}.js`),
        `export const item${String(i)} = ${String(i)};\n`,
      );
  }
  return path;
};

it("recovers every lost queue/worker state, preserves cancel history, and recovers once", async () => {
  const root = await createTestTempDirectory("rea-workbench-recovery-states-");
  const databasePath = join(root, "workbench.sqlite");
  const targetPath = await makeTarget(root);
  const seed = new WorkbenchStore(databasePath);
  const project = seed.createProject("recovery");
  const target = seed.createTarget(project.id, targetPath, "directory");
  const ids: string[] = [];
  for (const state of [
    "queued",
    "starting",
    "running",
    "finalizing",
    "cancelling",
  ] as const) {
    const run = seed.createRun({
      projectId: project.id,
      targetId: target.id,
      workflow: defaultWorkflow(),
      parameters: {},
    });
    seed.updateRun(run.id, { state });
    if (state === "cancelling")
      seed.appendEvent({ runId: run.id, type: "run.cancel_requested" });
    ids.push(run.id);
  }
  seed.close();
  const first = await start(databasePath);
  try {
    for (const id of ids) {
      expect(first.handle.store.getRun(id)).toMatchObject({
        state: "interrupted",
        resultCompleteness: "unknown",
        cleanupStatus: "unknown",
        error: { code: "process_interrupted" },
      });
      const events = first.handle.store.listEvents(id);
      expect(
        events.filter((event) => event.type === "run.interrupted"),
      ).toHaveLength(1);
    }
    expect(first.handle.store.listEvents(ids[4]!)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run.cancel_requested" }),
        expect.objectContaining({
          type: "run.interrupted",
          payload: expect.objectContaining({
            cancel_requested_before_interruption: true,
          }),
        }),
      ]),
    );
    const diagnostics = (await (
      await call(first.base, "/api/diagnostics")
    ).json()) as WorkbenchManagerDiagnostics;
    expect(diagnostics.lastStartupRecovery?.recoveredRunIds).toHaveLength(5);
    expect((await fetch(`${first.base}/api/diagnostics`)).status).toBe(401);
  } finally {
    await first.handle.close();
  }
  const second = await start(databasePath);
  try {
    expect(
      second.handle.manager.diagnostics().lastStartupRecovery?.recoveredRunIds,
    ).toEqual([]);
    expect(
      second.handle.store
        .listEvents(ids[0]!)
        .filter((event) => event.type === "run.interrupted"),
    ).toHaveLength(1);
  } finally {
    await second.handle.close();
  }
});

it("retries into a fresh run, replays the key despite missing target, and preserves an old Bundle byte for byte", async () => {
  const root = await createTestTempDirectory("rea-workbench-retry-bundle-");
  const server = await start(join(root, "workbench.sqlite"));
  try {
    const input = await register(server.base, await makeTarget(root));
    const previous = await terminal(
      server.base,
      (await launch(server.base, input)).id,
    );
    expect(previous.state).toBe("succeeded");
    const manifestPath = join(
      server.handle.bundles.root,
      previous.id,
      "bundle.json",
    );
    const evidencePath = join(
      server.handle.bundles.root,
      previous.id,
      "evidence.json",
    );
    const manifest = readFileSync(manifestPath);
    const evidence = readFileSync(evidencePath);
    expect(
      (
        await call(server.base, `/api/runs/${previous.id}/retry`, {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(409);
    // A recovered finalization can retain a committed Bundle. Seed that durable
    // state to exercise the same retry path without changing the Bundle.
    server.handle.store.updateRun(previous.id, {
      state: "interrupted",
      error: {
        code: "process_interrupted",
        message: "interrupted publication",
      },
    });
    const response = await call(server.base, `/api/runs/${previous.id}/retry`, {
      method: "POST",
      headers: { "Idempotency-Key": "retry-preserved-bundle" },
      body: "{}",
    });
    expect(response.status).toBe(202);
    const retry = (await response.json()) as WorkbenchRun;
    expect(retry.id).not.toBe(previous.id);
    expect((await terminal(server.base, retry.id)).state).toBe("succeeded");
    expect(
      server.handle.store.listEvents(retry.id)[0]?.payload.retry_of_run_id,
    ).toBe(previous.id);
    expect(readFileSync(manifestPath)).toEqual(manifest);
    expect(readFileSync(evidencePath)).toEqual(evidence);
    // Existing bindings must replay without resolving a now-unreadable target.
    const savedTarget = server.handle.store.getTarget(previous.targetId)!;
    await rename(savedTarget.path, `${savedTarget.path}-moved`);
    const replay = await call(server.base, `/api/runs/${previous.id}/retry`, {
      method: "POST",
      headers: { "Idempotency-Key": "retry-preserved-bundle" },
      body: "{}",
    });
    expect(replay.status).toBe(202);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(((await replay.json()) as WorkbenchRun).id).toBe(retry.id);
    expect(
      (
        await call(server.base, `/api/runs/${previous.id}/retry`, {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(400);
  } finally {
    await server.handle.close();
  }
}, 120_000);

it("retries an actual failed archive after the registered target is repaired", async () => {
  const root = await createTestTempDirectory("rea-workbench-failed-retry-");
  const server = await start(join(root, "workbench.sqlite"));
  try {
    const archive = join(root, "target.asar");
    await writeFile(archive, "not-an-archive");
    const input = await register(server.base, archive, "asar");
    const previous = await terminal(
      server.base,
      (await launch(server.base, input)).id,
    );
    expect(previous.state).toBe("failed");
    await createPackage(await makeTarget(root), archive);
    const response = await call(server.base, `/api/runs/${previous.id}/retry`, {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(202);
    const retried = (await response.json()) as WorkbenchRun;
    expect((await terminal(server.base, retried.id)).state).toBe("succeeded");
    expect(server.handle.store.getRun(previous.id)).toEqual(previous);
    expect(
      server.handle.store.listEvents(retried.id)[0]?.payload.retry_of_run_id,
    ).toBe(previous.id);
  } finally {
    await server.handle.close();
  }
}, 120_000);

it("reports a server deadline as failed analysis_timeout and drains analysis before queue reuse", async () => {
  const root = await createTestTempDirectory("rea-workbench-timeout-");
  const server = await start(join(root, "workbench.sqlite"), 1);
  try {
    const input = await register(server.base, await makeTarget(root, true));
    const first = await launch(server.base, {
      ...input,
      parameters: { source_paths: ["main.js"] },
    });
    expect(await terminal(server.base, first.id)).toMatchObject({
      state: "failed",
      error: { code: "analysis_timeout" },
      cleanupStatus: "complete",
      resultCompleteness: "none",
    });
    const events = server.handle.store.listEvents(first.id);
    expect(events.at(-1)?.payload.cause).toBe("timeout");
    expect(events.some((event) => event.type === "evidence.recorded")).toBe(
      false,
    );
    expect(events.some((event) => event.type === "run.cancel_requested")).toBe(
      false,
    );
    const second = await launch(server.base, {
      ...input,
      parameters: { source_paths: ["main.js"] },
    });
    expect((await terminal(server.base, second.id)).error?.code).toBe(
      "analysis_timeout",
    );
  } finally {
    await server.handle.close();
  }
}, 120_000);

it("exposes active and queued work and distinguishes user cancellation and retry guards", async () => {
  const root = await createTestTempDirectory(
    "rea-workbench-cancel-diagnostics-",
  );
  const server = await start(join(root, "workbench.sqlite"));
  try {
    const input = await register(server.base, await makeTarget(root, true));
    const active = await launch(server.base, {
      ...input,
      parameters: { source_paths: ["main.js"] },
    });
    const queued = await launch(server.base, {
      ...input,
      parameters: { source_paths: ["main.js"] },
    });
    const diagnostics = (await (
      await call(server.base, "/api/diagnostics")
    ).json()) as WorkbenchManagerDiagnostics;
    expect(diagnostics.active?.runId).toBe(active.id);
    expect(diagnostics.queuedRunIds).toContain(queued.id);
    expect(diagnostics.queueLength).toBe(1);
    expect(
      (
        await call(server.base, `/api/runs/${active.id}/retry`, {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(409);
    for (const id of [queued.id, active.id]) {
      expect(
        (
          await call(server.base, `/api/runs/${id}/cancel`, {
            method: "POST",
            body: "{}",
          })
        ).status,
      ).toBe(202);
      expect(await terminal(server.base, id)).toMatchObject({
        state: "cancelled",
        error: { code: "user_cancelled" },
        resultCompleteness: "none",
      });
    }
    const workflow = {
      ...defaultWorkflow(),
      version: "no-retry",
      capabilities: { cancel: true, retry: false },
    };
    server.handle.store.saveWorkflow(workflow);
    const guarded = server.handle.store.createRun({
      projectId: input.project_id,
      targetId: input.target_id,
      workflow,
      parameters: {},
    });
    server.handle.store.updateRun(guarded.id, { state: "failed" });
    expect(
      (
        await call(server.base, `/api/runs/${guarded.id}/retry`, {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(server.base, "/api/runs/missing/retry", {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(404);
  } finally {
    await server.handle.close();
  }
}, 120_000);

it("recovers a real SIGKILL on same-database restart and retries without changing completed evidence", async () => {
  const root = await createTestTempDirectory("rea-workbench-real-crash-");
  const databasePath = join(root, "workbench.sqlite");
  const processes = createTestProcessRegistry();
  const freePort = async (): Promise<number> => {
    const listener = createTcpServer();
    await new Promise<void>((ready) => listener.listen(0, "127.0.0.1", ready));
    const address = listener.address();
    if (address === null || typeof address === "string")
      throw new Error("No port");
    await new Promise<void>((closed) => listener.close(() => closed()));
    return address.port;
  };
  const boot = async () => {
    const port = await freePort();
    const child = processes.spawn(
      process.execPath,
      [resolve("dist/workbench/main.js")],
      {
        env: {
          ...process.env,
          REA_WORKBENCH_PORT: String(port),
          REA_WORKBENCH_DATABASE: databasePath,
          REA_WORKBENCH_TOKEN: TOKEN,
        },
      },
    );
    let output = "";
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      output += data.toString();
    });
    const deadline = Date.now() + 15_000;
    while (!output.includes("REA Workbench 已启动")) {
      if (Date.now() > deadline || child.exitCode !== null)
        throw new Error(`Startup failed: ${output}`);
      await pause(10);
    }
    return { child, base: `http://127.0.0.1:${String(port)}` };
  };
  try {
    const first = await boot();
    const preservedInput = await register(first.base, await makeTarget(root));
    const completed = await terminal(
      first.base,
      (await launch(first.base, preservedInput)).id,
    );
    expect(completed.state).toBe("succeeded");
    const oldManifestPath = join(root, "bundles", completed.id, "bundle.json");
    const oldEvidencePath = join(
      root,
      "bundles",
      completed.id,
      "evidence.json",
    );
    const manifest = readFileSync(oldManifestPath);
    const evidence = readFileSync(oldEvidencePath);
    const input = await register(first.base, await makeTarget(root, true));
    const run = await launch(first.base, {
      ...input,
      parameters: { source_paths: ["main.js"] },
    });
    const observer = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const row = observer
          .prepare("SELECT state FROM runs WHERE id = ?")
          .get(run.id) as { state: string };
        if (row.state === "running") break;
        if (
          Date.now() > deadline ||
          ["succeeded", "failed"].includes(row.state)
        )
          throw new Error(`Missed running state: ${row.state}`);
        await pause(2);
      }
      first.child.kill("SIGKILL");
      expect(await waitForExit(first.child, 5000)).toBe(true);
    } finally {
      observer.close();
    }
    const second = await boot();
    const recovered = await (
      await call(second.base, `/api/runs/${run.id}`)
    ).json();
    expect(recovered).toMatchObject({
      state: "interrupted",
      cleanupStatus: "unknown",
      resultCompleteness: "unknown",
      error: { code: "process_interrupted" },
    });
    const events = (await (
      await call(second.base, `/api/runs/${run.id}/events?format=json`)
    ).json()) as WorkbenchRunEvent[];
    expect(events.some((event) => event.type === "run.interrupted")).toBe(true);
    expect(
      (await call(second.base, `/api/runs/${completed.id}/evidence`)).status,
    ).toBe(200);
    const response = await call(second.base, `/api/runs/${run.id}/retry`, {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(202);
    const retried = (await response.json()) as WorkbenchRun;
    expect(retried.id).not.toBe(run.id);
    expect((await terminal(second.base, retried.id)).state).toBe("succeeded");
    expect(readFileSync(oldManifestPath)).toEqual(manifest);
    expect(readFileSync(oldEvidencePath)).toEqual(evidence);
    expect(
      (await call(second.base, `/api/runs/${run.id}/evidence`)).status,
    ).toBe(404);
  } finally {
    await processes.shutdown();
  }
}, 150_000);

it("fails a duplicate listener before touching the live database", async () => {
  const root = await createTestTempDirectory("rea-workbench-duplicate-start-");
  const databasePath = join(root, "workbench.sqlite");
  const first = await start(databasePath);
  const input = await register(first.base, await makeTarget(root));
  const queued = first.handle.store.createRun({
    projectId: input.project_id,
    targetId: input.target_id,
    workflow: defaultWorkflow(),
    parameters: {},
  });
  const port = Number(new URL(first.base).port);
  const second = createWorkbenchServer({ port, token: TOKEN, databasePath });
  try {
    await expect(listenWorkbenchServer(second)).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    expect(first.handle.store.getRun(queued.id)?.state).toBe("queued");
    expect(first.handle.store.listEvents(queued.id)).toEqual([]);
  } finally {
    await second.close();
    await first.handle.close();
  }
});

it("serves parseable browser scripts with retry and safe graph node selection", async () => {
  const root = await createTestTempDirectory("rea-workbench-page-script-");
  const server = await start(join(root, "workbench.sqlite"));
  try {
    const response = await fetch(server.base);
    expect(response.status).toBe(200);
    const html = await response.text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)];
    expect(scripts).toHaveLength(1);
    for (const [, source] of scripts)
      expect(() => new Script(source!)).not.toThrow();
    expect(html).toContain("重试运行");
    // Node selection goes through delegated intents, never inline handlers.
    expect(html).toContain('data-action="open-node"');
    expect(html).not.toContain("onclick=");
  } finally {
    await server.handle.close();
  }
});

it("closes an SSE connection and drains a cancelled worker before closing the database", async () => {
  const root = await createTestTempDirectory("rea-workbench-shutdown-sse-");
  const databasePath = join(root, "workbench.sqlite");
  const server = await start(databasePath);
  const input = await register(server.base, await makeTarget(root, true));
  const run = await launch(server.base, {
    ...input,
    parameters: { source_paths: ["main.js"] },
  });
  const controller = new AbortController();
  try {
    const response = await call(server.base, `/api/runs/${run.id}/events`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    await server.handle.close();
    const store = new WorkbenchStore(databasePath);
    try {
      expect(store.getRun(run.id)).toMatchObject({
        state: "cancelled",
        cleanupStatus: "complete",
        error: { code: "user_cancelled" },
      });
      expect(store.listEvents(run.id).at(-1)?.type).toBe("run.finished");
    } finally {
      store.close();
    }
  } finally {
    controller.abort();
    if (server.handle.server.listening) await server.handle.close();
  }
}, 120_000);
