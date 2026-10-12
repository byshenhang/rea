import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  createWorkbenchServer,
  listenWorkbenchServer,
  type WorkbenchServerHandle,
} from "../../../src/workbench/server.js";
import { defaultWorkflow } from "../../../src/workbench/store.js";
import type { WorkbenchRunEvent } from "../../../src/workbench/types.js";

const TOKEN = "workbench-sse-test-token";

interface SseFrame {
  readonly id: number;
  readonly event: string;
  readonly data: WorkbenchRunEvent;
}

interface SseConnection {
  readonly frames: SseFrame[];
  readonly response: Response;
  readonly abort: () => void;
}

const startServer = async (): Promise<{
  handle: WorkbenchServerHandle;
  base: string;
}> => {
  const databasePath = join(
    await mkdtemp(join(tmpdir(), "rea-workbench-sse-")),
    "workbench.sqlite",
  );
  const handle = createWorkbenchServer({ port: 0, token: TOKEN, databasePath });
  await listenWorkbenchServer(handle);
  const address = handle.server.address();
  if (address === null || typeof address === "string")
    throw new Error("workbench server did not bind a TCP port");
  return { handle, base: `http://127.0.0.1:${String(address.port)}` };
};

const parseFrame = (block: string): SseFrame | null => {
  let id: number | null = null;
  let event = "";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("id:")) id = Number(line.slice(3).trim());
    else if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (id === null || data === "") return null;
  return { id, event, data: JSON.parse(data) as WorkbenchRunEvent };
};

const openStream = async (
  base: string,
  runId: string,
  options: { readonly after?: number; readonly lastEventId?: number } = {},
): Promise<SseConnection> => {
  const controller = new AbortController();
  const headers: Record<string, string> = {
    "X-REA-Workbench-Token": TOKEN,
    Accept: "text/event-stream",
  };
  if (options.lastEventId !== undefined)
    headers["Last-Event-ID"] = String(options.lastEventId);
  const suffix =
    options.after === undefined ? "" : `&after=${String(options.after)}`;
  const response = await fetch(
    `${base}/api/runs/${runId}/events?token=${encodeURIComponent(TOKEN)}${suffix}`,
    { headers, signal: controller.signal },
  );
  if (!response.ok || response.body === null)
    throw new Error(`SSE 连接失败: ${String(response.status)}`);
  const connection: SseConnection = {
    frames: [],
    response,
    abort: () => controller.abort(),
  };
  const collector = createCollector(connection);
  void collect(response, collector);
  return connection;
};

const createCollector = (
  connection: SseConnection,
): { push: (chunk: string) => void } => {
  let buffer = "";
  return {
    push: (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf("\n\n");
        if (index === -1) break;
        const frame = parseFrame(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        if (frame !== null) connection.frames.push(frame);
      }
    },
  };
};

const collect = async (
  response: Response,
  collector: { push: (chunk: string) => void },
): Promise<void> => {
  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>)
      collector.push(Buffer.from(chunk).toString("utf8"));
  } catch {
    // Aborting the connection ends the read; frames collected so far remain.
  }
};

const waitForFrames = async (
  connection: SseConnection,
  count: number,
  timeoutMs: number,
): Promise<SseFrame[]> => {
  const deadline = Date.now() + timeoutMs;
  while (connection.frames.length < count) {
    if (Date.now() > deadline)
      throw new Error(
        `SSE 帧不足：期望 ${String(count)}，实际 ${String(connection.frames.length)}`,
      );
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return connection.frames;
};

const appendEvent = (
  store: WorkbenchServerHandle["store"],
  runId: string,
  type: WorkbenchRunEvent["type"],
  message: string,
): WorkbenchRunEvent =>
  store.appendEvent({ runId, type, payload: { message } });

it("replays history, merges live events without loss or duplication, and resumes from Last-Event-ID", async () => {
  const { handle, base } = await startServer();
  try {
    const project = handle.store.createProject("SSE 验收", "");
    const target = handle.store.createTarget(
      project.id,
      "/tmp/rea-workbench-sse-target",
      "directory",
    );
    const run = handle.store.createRun({
      projectId: project.id,
      targetId: target.id,
      workflow: defaultWorkflow(),
      parameters: {},
    });
    for (const [type, message] of [
      ["run.created", "创建"],
      ["run.started", "开始"],
      ["step.started", "步骤开始"],
      ["step.progress", "进行中"],
      ["step.finished", "步骤结束"],
    ] as const) {
      appendEvent(handle.store, run.id, type, message);
    }

    const first = await openStream(base, run.id, { after: 0 });
    const history = await waitForFrames(first, 5, 15_000);
    expect(history.map((frame) => frame.id)).toEqual([1, 2, 3, 4, 5]);
    expect(history[4]?.data.type).toBe("step.finished");

    appendEvent(handle.store, run.id, "evidence.recorded", "证据已保存");
    appendEvent(handle.store, run.id, "cleanup.finished", "清理完成");
    const withLive = await waitForFrames(first, 7, 15_000);
    expect(withLive.map((frame) => frame.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    first.abort();

    appendEvent(handle.store, run.id, "run.finished", "运行结束");
    const resumed = await openStream(base, run.id, { lastEventId: 7 });
    const resumeFrames = await waitForFrames(resumed, 1, 15_000);
    expect(resumeFrames.map((frame) => frame.id)).toEqual([8]);
    expect(resumeFrames[0]?.data.type).toBe("run.finished");
    resumed.abort();

    const afterQuery = await openStream(base, run.id, { after: 5 });
    expect(
      (await waitForFrames(afterQuery, 3, 15_000)).map((frame) => frame.id),
    ).toEqual([6, 7, 8]);
    afterQuery.abort();
  } finally {
    await handle.close();
  }
}, 60_000);

it("keeps full replay duplicate-free and honors the json event cursor", async () => {
  const { handle, base } = await startServer();
  try {
    const project = handle.store.createProject("SSE 游标", "");
    const target = handle.store.createTarget(
      project.id,
      "/tmp/rea-workbench-sse-cursor",
      "directory",
    );
    const run = handle.store.createRun({
      projectId: project.id,
      targetId: target.id,
      workflow: defaultWorkflow(),
      parameters: {},
    });
    for (let sequence = 0; sequence < 6; sequence += 1)
      appendEvent(
        handle.store,
        run.id,
        "step.progress",
        `进度 ${String(sequence)}`,
      );

    const full = await openStream(base, run.id, { after: 0 });
    const frames = await waitForFrames(full, 6, 15_000);
    const sequences = frames.map((frame) => frame.id);
    expect(sequences).toEqual(
      [...new Set(sequences)].sort((left, right) => left - right),
    );
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6]);
    full.abort();

    const jsonAfter = await fetch(
      `${base}/api/runs/${run.id}/events?format=json&after=4`,
      { headers: { "X-REA-Workbench-Token": TOKEN } },
    );
    expect(jsonAfter.status).toBe(200);
    const events = (await jsonAfter.json()) as Array<{ sequence: number }>;
    expect(events.map((event) => event.sequence)).toEqual([5, 6]);
  } finally {
    await handle.close();
  }
}, 60_000);
