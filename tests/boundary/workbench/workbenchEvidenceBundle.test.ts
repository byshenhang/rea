import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  createWorkbenchServer,
  listenWorkbenchServer,
  type WorkbenchServerHandle,
} from "../../../src/workbench/server.js";
import { WorkbenchStore } from "../../../src/workbench/store.js";

const TOKEN = "workbench-bundle-test-token";

interface StartedServer {
  readonly handle: WorkbenchServerHandle;
  readonly base: string;
  readonly databasePath: string;
  readonly bundleRoot: string;
}

const startServer = async (
  bundleRoot: string,
  existingDatabasePath?: string,
): Promise<StartedServer> => {
  const databasePath =
    existingDatabasePath ??
    join(
      await mkdtemp(join(tmpdir(), "rea-workbench-bundle-db-")),
      "workbench.sqlite",
    );
  const handle = createWorkbenchServer({
    port: 0,
    token: TOKEN,
    databasePath,
    bundleRoot,
  });
  await listenWorkbenchServer(handle);
  const address = handle.server.address();
  if (address === null || typeof address === "string")
    throw new Error("workbench server did not bind a TCP port");
  return {
    handle,
    base: `http://127.0.0.1:${String(address.port)}`,
    databasePath,
    bundleRoot,
  };
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

const runSucceededAnalysis = async (
  base: string,
): Promise<{ readonly runId: string }> => {
  const targetDir = await mkdtemp(
    join(tmpdir(), "rea-workbench-bundle-target-"),
  );
  writeFileSync(
    join(targetDir, "main.js"),
    "export const bundleProbe = 'bundle-target';\n",
  );
  const project = (await (
    await call(base, "/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Bundle 项目" }),
    })
  ).json()) as { id: string };
  const target = (await (
    await call(base, `/api/projects/${project.id}/targets`, {
      method: "POST",
      body: JSON.stringify({ path: targetDir, format: "directory" }),
    })
  ).json()) as { id: string };
  const create = await call(base, "/api/runs", {
    method: "POST",
    body: JSON.stringify({ project_id: project.id, target_id: target.id }),
  });
  expect(create.status).toBe(202);
  const run = (await create.json()) as { id: string };
  expect(await waitForTerminalState(base, run.id, 120_000)).toBe("succeeded");
  return { runId: run.id };
};

it("commits a digest-verified bundle, keeps the database to identity, and binds every identity together", async () => {
  const bundleRoot = join(
    await mkdtemp(join(tmpdir(), "rea-workbench-bundles-")),
    "bundles",
  );
  const server = await startServer(bundleRoot);
  try {
    const { runId } = await runSucceededAnalysis(server.base);

    const bundleDir = join(bundleRoot, runId);
    expect(existsSync(join(bundleDir, "COMPLETE"))).toBe(true);
    expect(existsSync(join(bundleDir, "evidence.json"))).toBe(true);
    const manifestOnDisk = JSON.parse(
      readFileSync(join(bundleDir, "bundle.json"), "utf8"),
    ) as Record<string, unknown>;
    const payload = readFileSync(join(bundleDir, "evidence.json"), "utf8");
    expect(createHash("sha256").update(payload).digest("hex")).toBe(
      manifestOnDisk.evidence_sha256,
    );

    const runDetail = (await (
      await call(server.base, `/api/runs/${runId}`)
    ).json()) as {
      bundle: Record<string, unknown> | null;
      workflowId: string;
      workflowVersion: string;
    };
    expect(runDetail.bundle).toMatchObject({
      bundle_version: 1,
      run_id: runId,
      evidence_id: manifestOnDisk.evidence_id,
      workflow_id: runDetail.workflowId,
      workflow_version: runDetail.workflowVersion,
    });

    const evidence = (await (
      await call(server.base, `/api/runs/${runId}/evidence`)
    ).json()) as {
      evidence_id: string;
      normalized_result: { root_artifact_sha256?: string };
    };
    expect(evidence.evidence_id).toBe(manifestOnDisk.evidence_id);
    expect(manifestOnDisk.target_sha256).toBe(
      evidence.normalized_result.root_artifact_sha256 ?? null,
    );

    // The database no longer carries the payload for bundle-backed runs.
    const metadata = new WorkbenchStore(server.databasePath);
    try {
      expect(metadata.getEvidence(runId)).toBeNull();
      expect(metadata.getRun(runId)?.bundle).toMatchObject({
        evidence_sha256: manifestOnDisk.evidence_sha256,
      });
    } finally {
      metadata.close();
    }
  } finally {
    await server.handle.close();
  }
}, 180_000);

it("serves evidence, export, and graph from the bundle after a full server restart", async () => {
  const bundleRoot = join(
    await mkdtemp(join(tmpdir(), "rea-workbench-bundles-")),
    "bundles",
  );
  const first = await startServer(bundleRoot);
  const { runId } = await runSucceededAnalysis(first.base);
  const originalEvidence = (await (
    await call(first.base, `/api/runs/${runId}/evidence`)
  ).json()) as { evidence_id: string };
  await first.handle.close();

  const second = await startServer(bundleRoot, first.databasePath);
  try {
    const evidence = (await (
      await call(second.base, `/api/runs/${runId}/evidence`)
    ).json()) as { evidence_id: string };
    expect(evidence.evidence_id).toBe(originalEvidence.evidence_id);

    const exportResponse = await call(second.base, `/api/runs/${runId}/export`);
    expect(exportResponse.status).toBe(200);
    const graph = await call(second.base, `/api/runs/${runId}/graph`);
    expect([200, 404]).toContain(graph.status);

    const comparison = await call(second.base, "/api/comparisons", {
      method: "POST",
      body: JSON.stringify({ left_run_id: runId, right_run_id: runId }),
    });
    expect(comparison.status).toBe(200);
  } finally {
    await second.handle.close();
  }
}, 180_000);

it("removes interrupted temp commits and quarantines marker-less bundles at startup", async () => {
  const bundleRoot = join(
    await mkdtemp(join(tmpdir(), "rea-workbench-bundles-")),
    "bundles",
  );
  mkdirSync(join(bundleRoot, ".tmp-interrupted-commit"), { recursive: true });
  writeFileSync(
    join(bundleRoot, ".tmp-interrupted-commit", "evidence.json"),
    '{"partial":',
    "utf8",
  );
  mkdirSync(join(bundleRoot, "stranded-run"), { recursive: true });
  writeFileSync(
    join(bundleRoot, "stranded-run", "evidence.json"),
    "{}",
    "utf8",
  );

  const server = await startServer(bundleRoot);
  try {
    expect(existsSync(join(bundleRoot, ".tmp-interrupted-commit"))).toBe(false);
    expect(existsSync(join(bundleRoot, "stranded-run"))).toBe(false);
    expect(existsSync(join(bundleRoot, ".incomplete-stranded-run"))).toBe(true);
  } finally {
    await server.handle.close();
  }
});

it("rejects tampered bundles with a typed integrity error instead of fake evidence", async () => {
  const bundleRoot = join(
    await mkdtemp(join(tmpdir(), "rea-workbench-bundles-")),
    "bundles",
  );
  const server = await startServer(bundleRoot);
  const { runId } = await runSucceededAnalysis(server.base);
  await server.handle.close();

  const evidencePath = join(bundleRoot, runId, "evidence.json");
  writeFileSync(
    evidencePath,
    readFileSync(evidencePath, "utf8").replace(
      /"evidence_id"\s*:\s*"[^"]+"/u,
      `"evidence_id":"tampered"`,
    ),
    "utf8",
  );

  const reopened = await startServer(bundleRoot);
  try {
    const response = await call(reopened.base, `/api/runs/${runId}/evidence`);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bundle_integrity_failed");
  } finally {
    await reopened.handle.close();
  }
}, 180_000);

it("degrades to inline evidence on bundle commit failure without masking the successful analysis", async () => {
  const bundleRoot = join(
    await mkdtemp(join(tmpdir(), "rea-workbench-bundles-")),
    "bundles",
  );
  mkdirSync(bundleRoot, { recursive: true });
  chmodSync(bundleRoot, 0o555);
  const server = await startServer(bundleRoot);
  try {
    const { runId } = await runSucceededAnalysis(server.base);

    const runDetail = (await (
      await call(server.base, `/api/runs/${runId}`)
    ).json()) as {
      state: string;
      error: unknown;
      bundle: unknown;
    };
    expect(runDetail.state).toBe("succeeded");
    expect(runDetail.error).toBeNull();
    expect(runDetail.bundle).toBeNull();

    const evidence = (await (
      await call(server.base, `/api/runs/${runId}/evidence`)
    ).json()) as { evidence_id: string };
    expect(typeof evidence.evidence_id).toBe("string");

    const events = (await (
      await call(server.base, `/api/runs/${runId}/events?format=json`)
    ).json()) as Array<{ type: string; payload: Record<string, unknown> }>;
    expect(
      events.some(
        (event) =>
          event.type === "diagnostic.reported" &&
          event.payload.kind === "evidence-bundle",
      ),
    ).toBe(true);
  } finally {
    chmodSync(bundleRoot, 0o755);
    await server.handle.close();
    rmSync(bundleRoot, { recursive: true, force: true });
  }
}, 180_000);
