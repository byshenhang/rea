import { describe, expect, it } from "vitest";

import {
  eventCursor,
  failureExplanation,
  humanizeError,
  initialUiState,
  isActiveState,
  isRetryableState,
  mergeEvents,
  statusTone,
  statusText,
} from "../../../src/workbench/ui/state.js";
import type { WorkbenchRunEvent } from "../../../src/workbench/types.js";

const event = (
  sequence: number,
  type: WorkbenchRunEvent["type"] = "step.progress",
): WorkbenchRunEvent => ({
  eventId: `ev_${String(sequence)}`,
  runId: "run-1",
  sequence,
  timestamp: "2026-10-13T00:00:00.000Z",
  type,
  stepInstanceId: null,
  attemptId: null,
  payload: {},
});

describe("Workbench UI state transitions", () => {
  it("merges events by run-internal sequence without duplicates", () => {
    const merged = mergeEvents(
      [event(1), event(3)],
      [event(3), event(2), event(3)],
    );
    expect(merged.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(mergeEvents([], [])).toEqual([]);
  });

  it("derives the event cursor from the highest sequence", () => {
    expect(eventCursor([])).toBe(0);
    expect(eventCursor([event(2), event(7), event(5)])).toBe(7);
  });

  it("classifies run states into tones and localized labels", () => {
    expect(statusTone("succeeded")).toBe("ok");
    expect(statusTone("partial")).toBe("warn");
    expect(statusTone("failed")).toBe("bad");
    expect(statusTone("interrupted")).toBe("bad");
    expect(statusTone("running")).toBe("warn");
    expect(statusTone("unknown")).toBe("muted");
    expect(statusText("cancelling")).toBe("取消中");
    expect(statusText("not-required")).toBe("无需清理");
    expect(statusText("mystery-state")).toBe("mystery-state");
  });

  it("separates active, retryable, and terminal states", () => {
    expect(isActiveState("cancelling")).toBe(true);
    expect(isActiveState("succeeded")).toBe(false);
    expect(isRetryableState("interrupted")).toBe(true);
    expect(isRetryableState("succeeded")).toBe(false);
  });

  it("explains interrupted runs without server error objects", () => {
    const state = initialUiState();
    expect(state.loading).toBe(true);
    const base = {
      id: "r",
      projectId: "p",
      targetId: "t",
      state: "interrupted",
      resultCompleteness: "unknown",
      cleanupStatus: "unknown",
      workflowId: "w",
      workflowVersion: "1",
      createdAt: "",
      startedAt: null,
      finishedAt: null,
      evidenceId: null,
      error: null,
      sourceSnapshot: null,
    } as const;
    expect(failureExplanation(base)?.code).toBe("process_interrupted");
    expect(failureExplanation({ ...base, state: "succeeded" })).toBeNull();
    expect(
      failureExplanation({
        ...base,
        state: "failed",
        error: { code: "analysis_timeout", message: "超时" },
      })?.code,
    ).toBe("analysis_timeout");
  });

  it("humanizes the server error envelope into banner fields", () => {
    const banner = humanizeError({
      code: "invalid_request",
      message: "请求字段不符合契约",
      details: [{ path: "name", message: "不能为空" }],
    });
    expect(banner.code).toBe("invalid_request");
    expect(banner.details).toEqual(["name: 不能为空"]);
    expect(humanizeError({ message: "plain" }).code).toBeNull();
  });
});
