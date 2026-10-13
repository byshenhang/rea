import type { JsonValue } from "../../domain/jsonValue.js";
import type {
  WorkbenchRunEvent,
  WorkbenchRunState,
  WorkbenchStepSnapshot,
} from "../types.js";

/**
 * Typed browser-side state for the Workbench UI, plus the pure transitions
 * over it. Rendering components consume this module; they never re-derive
 * status from log text — server API data and RunEvents are the only sources.
 */

export type WorkbenchTab =
  | "timeline"
  | "graph"
  | "diff"
  | "source"
  | "evidence";

export interface UiProject {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface UiTarget {
  readonly id: string;
  readonly path: string;
  readonly format: "auto" | "asar" | "directory";
}

export interface UiRun {
  readonly id: string;
  readonly projectId: string;
  readonly targetId: string;
  readonly state: WorkbenchRunState;
  readonly resultCompleteness: string;
  readonly cleanupStatus: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly evidenceId: string | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly sourceSnapshot: {
    readonly format: string;
    readonly sha256?: string;
  } | null;
  readonly retryOfRunId?: string;
}

export interface UiGraphFilter {
  readonly search: string;
  readonly kind: string;
}

export interface UiGraphNode {
  readonly node_id: string;
  readonly kind: string;
  readonly label: string | null;
  readonly locations: readonly JsonValue[];
  readonly evidence_ids: readonly string[];
}

export interface UiNodeDetail {
  readonly node: UiGraphNode & { readonly node_id: string };
  readonly in_degree: number;
  readonly out_degree: number;
  readonly graph_id: string;
}

export interface UiDiff {
  readonly status: "compared" | "unavailable";
  readonly summary: {
    readonly added: number;
    readonly removed: number;
    readonly changed: number;
    readonly unchanged: number;
    readonly unknown: number;
  } | null;
  readonly coverage: { readonly status?: string } | null;
  readonly limitations: readonly string[];
  readonly changes: readonly {
    readonly status: string;
    readonly node_kind: string;
    readonly locations: readonly JsonValue[];
  }[];
}

export interface UiErrorBanner {
  readonly code: string | null;
  readonly message: string;
  readonly details: readonly string[];
}

export interface UiState {
  readonly projects: readonly UiProject[];
  readonly targets: readonly UiTarget[];
  readonly runs: readonly UiRun[];
  readonly project: UiProject | null;
  readonly target: UiTarget | null;
  readonly run: UiRun | null;
  readonly events: readonly WorkbenchRunEvent[];
  readonly steps: readonly WorkbenchStepSnapshot[];
  readonly tab: WorkbenchTab;
  /** Loading flag for the initial page hydration. */
  readonly loading: boolean;
  /** Banner for API failures; cleared on the next successful action. */
  readonly error: UiErrorBanner | null;
  readonly graphNodes: readonly UiGraphNode[];
  readonly graphCursor: string | null;
  readonly graphTotal: number;
  readonly graphFilter: UiGraphFilter;
  readonly graphLoading: boolean;
  readonly nodeDetail: UiNodeDetail | null;
  readonly nodeDetailId: string | null;
  readonly diff: UiDiff | null;
  readonly diffLoading: boolean;
  readonly files: readonly { readonly path: string; readonly kind: string }[];
  readonly source: {
    readonly path: string;
    readonly content: string;
    readonly origin: string;
  } | null;
  readonly evidence: JsonValue | null;
  readonly evidenceLoading: boolean;
}

export const initialUiState = (): UiState => ({
  projects: [],
  targets: [],
  runs: [],
  project: null,
  target: null,
  run: null,
  events: [],
  steps: [],
  tab: "timeline",
  loading: true,
  error: null,
  graphNodes: [],
  graphCursor: null,
  graphTotal: 0,
  graphFilter: { search: "", kind: "" },
  graphLoading: false,
  nodeDetail: null,
  nodeDetailId: null,
  diff: null,
  diffLoading: false,
  files: [],
  source: null,
  evidence: null,
  evidenceLoading: false,
});

/** Dedupe by run-internal sequence and keep ascending order. */
export const mergeEvents = (
  existing: readonly WorkbenchRunEvent[],
  incoming: readonly WorkbenchRunEvent[],
): readonly WorkbenchRunEvent[] => {
  const bySequence = new Map<number, WorkbenchRunEvent>();
  for (const event of existing) bySequence.set(event.sequence, event);
  for (const event of incoming) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
};

export const eventCursor = (events: readonly WorkbenchRunEvent[]): number =>
  events.reduce((max, event) => Math.max(max, event.sequence), 0);

const terminalStates: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export const isTerminalState = (state: string): boolean =>
  terminalStates.has(state);

/** States that may still execute; a cancel button is meaningful here. */
export const isActiveState = (state: string): boolean =>
  ["queued", "starting", "running", "finalizing", "cancelling"].includes(state);

export const retryableStates: ReadonlySet<string> = new Set([
  "failed",
  "cancelled",
  "interrupted",
]);
export const isRetryableState = (state: string): boolean =>
  retryableStates.has(state);

export type StatusTone = "ok" | "bad" | "warn" | "muted";

export const statusTone = (state: string): StatusTone => {
  if (state === "succeeded" || state === "complete" || state === "not-required")
    return "ok";
  if (state === "failed") return "bad";
  if (state === "cancelled" || state === "interrupted") return "bad";
  if (state === "partial") return "warn";
  if (isActiveState(state)) return "warn";
  return "muted";
};

export const statusText = (state: string): string =>
  ({
    queued: "排队中",
    starting: "启动中",
    running: "运行中",
    finalizing: "收尾中",
    succeeded: "成功",
    failed: "失败",
    cancelling: "取消中",
    cancelled: "已取消",
    interrupted: "已中断",
    complete: "完整",
    partial: "部分结果",
    none: "无结果",
    unknown: "未知",
    "not-required": "无需清理",
  })[state] ?? state;

/** Whether this run discloses an explainable failure beyond its state. */
export const failureExplanation = (run: UiRun): UiErrorBanner | null => {
  if (run.error !== null) {
    return { code: run.error.code, message: run.error.message, details: [] };
  }
  if (run.state === "interrupted")
    return {
      code: "process_interrupted",
      message: "服务中断导致运行未完成;可在启动日志确认后重试。",
      details: [],
    };
  return null;
};

export const humanizeError = (error: {
  readonly code?: string;
  readonly message: string;
  readonly details?: readonly {
    readonly path?: string;
    readonly message: string;
  }[];
}): UiErrorBanner => ({
  code: error.code ?? null,
  message: error.message,
  details: (error.details ?? []).map((detail) =>
    [detail.path, detail.message]
      .filter((part) => part !== undefined && part !== "")
      .join(": "),
  ),
});
