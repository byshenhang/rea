import type { WorkbenchStore } from "./store.js";
import type { WorkbenchRunState } from "./types.js";

const RECOVERABLE_STATES: readonly WorkbenchRunState[] = [
  "queued",
  "starting",
  "running",
  "finalizing",
  "cancelling",
];

export interface WorkbenchStartupRecoveryReport {
  readonly recoveredRunIds: readonly string[];
  readonly reasonCounts: Readonly<Record<string, number>>;
}

/** Project work owned by a process that disappeared into an explicit terminal state. */
export const recoverInterruptedRuns = (
  store: WorkbenchStore,
  now = new Date().toISOString(),
): WorkbenchStartupRecoveryReport => {
  const recoveredRunIds: string[] = [];
  const reasonCounts: Record<string, number> = {};
  for (const run of store.listRunsByStates(RECOVERABLE_STATES)) {
    const hadCancelRequest = store
      .listEvents(run.id)
      .some((event) => event.type === "run.cancel_requested");
    const reason = "process-interrupted";
    store.transaction(() => {
      store.updateRun(run.id, {
        state: "interrupted",
        resultCompleteness: "unknown",
        cleanupStatus: "unknown",
        finishedAt: now,
        error: {
          code: "process_interrupted",
          message:
            "Workbench 进程在运行完成前退出，无法证明分析覆盖范围或资源清理结果。",
        },
      });
      store.appendEvent({
        runId: run.id,
        type: "run.interrupted",
        payload: {
          reason,
          cancel_requested_before_interruption: hadCancelRequest,
        },
      });
      store.appendEvent({
        runId: run.id,
        type: "run.finished",
        payload: {
          state: "interrupted",
          result_completeness: "unknown",
          cleanup_status: "unknown",
          cause: reason,
        },
      });
    });
    recoveredRunIds.push(run.id);
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  }
  return { recoveredRunIds, reasonCounts };
};
