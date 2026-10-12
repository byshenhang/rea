import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { workbenchErrorEnvelopeSchema } from "../../../src/workbench/api.js";
import {
  createWorkbenchServer,
  listenWorkbenchServer,
  type WorkbenchServerHandle,
} from "../../../src/workbench/server.js";
import { defaultWorkflow } from "../../../src/workbench/store.js";

const TOKEN = "workbench-contract-test-token";

interface StartedServer {
  readonly handle: WorkbenchServerHandle;
  readonly base: string;
}

const startServer = async (): Promise<StartedServer> => {
  const databasePath = join(
    await mkdtemp(join(tmpdir(), "rea-workbench-contract-")),
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
  init: RequestInit & { readonly token?: string | false } = {},
): Promise<Response> => {
  const { token = TOKEN, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token !== false) headers.set("X-REA-Workbench-Token", token);
  if (rest.body !== undefined && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  return fetch(`${base}${path}`, { ...rest, headers });
};

const expectErrorEnvelope = async (
  response: Response,
  status: number,
  code: string,
): Promise<void> => {
  expect(response.status).toBe(status);
  const body: unknown = await response.json();
  expect(workbenchErrorEnvelopeSchema.parse(body)).toMatchObject({
    error: { code },
  });
};

const registerTarget = async (
  base: string,
  targetPath: string,
): Promise<string> => {
  const project = (await (
    await call(base, "/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "契约测试项目" }),
    })
  ).json()) as { id: string };
  const target = (await (
    await call(base, `/api/projects/${project.id}/targets`, {
      method: "POST",
      body: JSON.stringify({ path: targetPath }),
    })
  ).json()) as { id: string };
  return JSON.stringify({ project_id: project.id, target_id: target.id });
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

it("rejects unauthenticated and cross-origin requests with the unified envelope", async () => {
  const { handle, base } = await startServer();
  try {
    await expectErrorEnvelope(
      await call(base, "/api/projects", { token: false }),
      401,
      "unauthorized",
    );
    const denied = await fetch(base, {
      headers: { Origin: "http://evil.example" },
    });
    await expectErrorEnvelope(denied, 403, "origin_denied");
  } finally {
    await handle.close();
  }
});

it("rejects invalid project bodies without writing partial entities", async () => {
  const { handle, base } = await startServer();
  try {
    await expectErrorEnvelope(
      await call(base, "/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: "" }),
      }),
      400,
      "invalid_request",
    );
    await expectErrorEnvelope(
      await call(base, "/api/projects", { method: "POST", body: "{not-json" }),
      400,
      "malformed_body",
    );
    const projects = (await (
      await call(base, "/api/projects")
    ).json()) as unknown[];
    expect(projects).toEqual([]);
  } finally {
    await handle.close();
  }
});

it("validates target registration, run creation, and unknown resources", async () => {
  const { handle, base } = await startServer();
  try {
    const project = (await (
      await call(base, "/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: "目标校验" }),
      })
    ).json()) as { id: string };
    await expectErrorEnvelope(
      await call(base, `/api/projects/${project.id}/targets`, {
        method: "POST",
        body: JSON.stringify({ path: "relative/path" }),
      }),
      400,
      "invalid_path",
    );
    await expectErrorEnvelope(
      await call(base, `/api/projects/${project.id}/targets`, {
        method: "POST",
        body: JSON.stringify({ path: "/rea-workbench-definitely-missing" }),
      }),
      400,
      "target_unreadable",
    );
    await expectErrorEnvelope(
      await call(base, `/api/projects/not-a-project/targets`, {
        method: "POST",
        body: JSON.stringify({ path: "/tmp" }),
      }),
      404,
      "project_not_found",
    );

    await expectErrorEnvelope(
      await call(base, "/api/runs", {
        method: "POST",
        body: JSON.stringify({ target_id: "t" }),
      }),
      400,
      "invalid_request",
    );
    await expectErrorEnvelope(
      await call(base, "/api/runs", {
        method: "POST",
        body: JSON.stringify({
          project_id: project.id,
          target_id: "missing",
          workflow_id: "rea.missing",
          workflow_version: "9.9.9",
        }),
      }),
      400,
      "workflow_not_found",
    );
    await expectErrorEnvelope(
      await call(base, "/api/runs", {
        method: "POST",
        body: JSON.stringify({
          project_id: project.id,
          target_id: "missing-target",
        }),
      }),
      400,
      "run_rejected",
    );
    await expectErrorEnvelope(
      await call(base, "/api/runs/does-not-exist"),
      404,
      "run_not_found",
    );
    await expectErrorEnvelope(
      await call(base, "/api/runs/does-not-exist/events?format=json"),
      404,
      "run_not_found",
    );
    await expectErrorEnvelope(
      await call(base, "/api/comparisons", {
        method: "POST",
        body: JSON.stringify({ left_run_id: "a" }),
      }),
      400,
      "invalid_request",
    );
  } finally {
    await handle.close();
  }
});

it("keeps one idempotency key bound to exactly one run and replays it", async () => {
  const { handle, base } = await startServer();
  try {
    const targetRoot = await mkdtemp(join(tmpdir(), "rea-workbench-target-"));
    await writeFile(
      join(targetRoot, "main.js"),
      "export const main = (input) => JSON.stringify(input);\n",
    );
    const body = await registerTarget(base, targetRoot);

    const first = await call(base, "/api/runs", {
      method: "POST",
      headers: { "Idempotency-Key": "contract-run-key" },
      body,
    });
    expect(first.status).toBe(202);
    const run = (await first.json()) as { id: string };
    expect(first.headers.get("idempotency-replayed")).toBeNull();

    const replay = await call(base, "/api/runs", {
      method: "POST",
      headers: { "Idempotency-Key": "contract-run-key" },
      body,
    });
    expect(replay.status).toBe(202);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    const replayedRun = (await replay.json()) as { id: string };
    expect(replayedRun.id).toBe(run.id);

    const runs = (await (await call(base, "/api/runs")).json()) as Array<{
      id: string;
    }>;
    expect(runs.map((entry) => entry.id)).toEqual([run.id]);

    const otherBody = JSON.stringify({
      ...JSON.parse(body),
      parameters: { integrity_policy: "record-and-continue" },
    });
    const conflict = await call(base, "/api/runs", {
      method: "POST",
      headers: { "Idempotency-Key": "contract-run-key" },
      body: otherBody,
    });
    await expectErrorEnvelope(conflict, 409, "idempotency_key_conflict");

    await expectErrorEnvelope(
      await call(base, "/api/runs", {
        method: "POST",
        headers: { "Idempotency-Key": "   " },
        body,
      }),
      400,
      "invalid_request",
    );
    await expectErrorEnvelope(
      await call(base, "/api/runs", {
        method: "POST",
        headers: { "Idempotency-Key": "k".repeat(201) },
        body,
      }),
      400,
      "invalid_request",
    );

    expect(await waitForTerminalState(base, run.id, 80_000)).toBe("succeeded");
  } finally {
    await handle.close();
  }
}, 120_000);

it("runs the real JavaScript analysis workflow and exposes contract-shaped results", async () => {
  const { handle, base } = await startServer();
  try {
    const targetRoot = await mkdtemp(join(tmpdir(), "rea-workbench-real-"));
    await writeFile(
      join(targetRoot, "index.js"),
      "const { parse } = JSON;\nexport function handler(value) { return parse(value); }\n",
    );
    const body = await registerTarget(base, targetRoot);
    const create = await call(base, "/api/runs", { method: "POST", body });
    expect(create.status).toBe(202);
    const run = (await create.json()) as { id: string };
    expect(await waitForTerminalState(base, run.id, 100_000)).toBe("succeeded");

    const events = (await (
      await call(base, `/api/runs/${run.id}/events?format=json`)
    ).json()) as Array<{ sequence: number; type: string }>;
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((event, index) => index + 1),
    );
    expect(events.some((event) => event.type === "run.started")).toBe(true);
    expect(
      events.filter((event) => event.type === "run.finished"),
    ).toHaveLength(1);

    const steps = (await (
      await call(base, `/api/runs/${run.id}/steps`)
    ).json()) as Array<{ state: string }>;
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((step) => step.state === "succeeded")).toBe(true);

    const evidenceResponse = await call(base, `/api/runs/${run.id}/evidence`);
    expect(evidenceResponse.status).toBe(200);
    const evidence = (await evidenceResponse.json()) as {
      evidence_id?: string;
      limitations?: unknown;
    };
    expect(typeof evidence.evidence_id).toBe("string");
    expect(Array.isArray(evidence.limitations)).toBe(true);

    const exportResponse = await call(base, `/api/runs/${run.id}/export`);
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get("content-disposition")).toContain(run.id);

    const comparison = await call(base, "/api/comparisons", {
      method: "POST",
      body: JSON.stringify({ left_run_id: run.id, right_run_id: run.id }),
    });
    expect(comparison.status).toBe(200);
    const comparisonBody = (await comparison.json()) as {
      configuration: { same_target: boolean; same_workflow: boolean };
    };
    expect(comparisonBody.configuration.same_target).toBe(true);
    expect(comparisonBody.configuration.same_workflow).toBe(true);
  } finally {
    await handle.close();
  }
}, 150_000);

it("projects a failed analysis run through the same contract without fake evidence", async () => {
  const { handle, base } = await startServer();
  try {
    const targetRoot = await mkdtemp(join(tmpdir(), "rea-workbench-fail-"));
    await writeFile(
      join(targetRoot, "broken.asar"),
      "this file is not an asar archive at all",
    );
    const project = (await (
      await call(base, "/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: "失败路径" }),
      })
    ).json()) as { id: string };
    const target = (await (
      await call(base, `/api/projects/${project.id}/targets`, {
        method: "POST",
        body: JSON.stringify({ path: targetRoot, format: "asar" }),
      })
    ).json()) as { id: string };
    const create = await call(base, "/api/runs", {
      method: "POST",
      body: JSON.stringify({
        project_id: project.id,
        target_id: target.id,
        parameters: { integrity_policy: "fail" },
      }),
    });
    expect(create.status).toBe(202);
    const run = (await create.json()) as { id: string };
    expect(await waitForTerminalState(base, run.id, 80_000)).toBe("failed");

    const detail = (await (await call(base, `/api/runs/${run.id}`)).json()) as {
      error: { code: string; message: string } | null;
    };
    expect(detail.error).not.toBeNull();
    expect(detail.error?.message).not.toBe("");

    const events = (await (
      await call(base, `/api/runs/${run.id}/events?format=json`)
    ).json()) as Array<{ type: string }>;
    expect(
      events.filter((event) => event.type === "run.finished"),
    ).toHaveLength(1);
    expect(events.some((event) => event.type === "cleanup.finished")).toBe(
      true,
    );

    await expectErrorEnvelope(
      await call(base, `/api/runs/${run.id}/evidence`),
      404,
      "evidence_not_available",
    );
  } finally {
    await handle.close();
  }
}, 120_000);

it("cancels a running analysis and records the cancellation path", async () => {
  const { handle, base } = await startServer();
  try {
    const targetRoot = await mkdtemp(join(tmpdir(), "rea-workbench-cancel-"));
    for (let index = 0; index < 40; index += 1) {
      await writeFile(
        join(targetRoot, `module${String(index)}.js`),
        `export const value${String(index)} = ${String(index)}; \n`,
      );
    }
    const body = await registerTarget(base, targetRoot);
    const create = await call(base, "/api/runs", { method: "POST", body });
    expect(create.status).toBe(202);
    const run = (await create.json()) as { id: string };
    const cancel = await call(base, `/api/runs/${run.id}/cancel`, {
      method: "POST",
      body: "{}",
    });
    expect(cancel.status).toBe(202);
    expect(await waitForTerminalState(base, run.id, 80_000)).toBe("cancelled");

    const events = (await (
      await call(base, `/api/runs/${run.id}/events?format=json`)
    ).json()) as Array<{ type: string; payload: { state?: string } }>;
    expect(events.some((event) => event.type === "run.cancel_requested")).toBe(
      true,
    );
    const finished = events.filter((event) => event.type === "run.finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]?.payload.state).toBe("cancelled");

    await expectErrorEnvelope(
      await call(base, `/api/runs/${run.id}/evidence`),
      404,
      "evidence_not_available",
    );
  } finally {
    await handle.close();
  }
}, 120_000);

it("exposes the workflow catalog with the pinned first-phase workflow", async () => {
  const { handle, base } = await startServer();
  try {
    const workflows = (await (
      await call(base, "/api/workflows")
    ).json()) as Array<{ workflowId: string; version: string }>;
    const pinned = defaultWorkflow();
    expect(workflows).toContainEqual(
      expect.objectContaining({
        workflowId: pinned.workflowId,
        version: pinned.version,
      }),
    );
  } finally {
    await handle.close();
  }
});
