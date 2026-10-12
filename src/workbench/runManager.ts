import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";

import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { createProgressReporter } from "../application/ProgressReporter.js";
import { analyzeJavaScriptApplication } from "../application/javascript/JavaScriptApplicationService.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Evidence } from "../domain/evidence.js";
import { WorkbenchIdempotencyConflictError } from "./api.js";
import { WorkbenchBundleStore, defaultBundleRoot } from "./bundleStore.js";
import { WorkbenchStore } from "./store.js";
import {
  createRunSourceSnapshot,
  DEFAULT_SOURCE_SNAPSHOT_LIMITS,
  type RunAsarSourceSnapshot,
  type SourceSnapshotLimits,
} from "./sourceSnapshot.js";
import type {
  WorkbenchBundleManifest,
  WorkbenchRun,
  WorkbenchRunState,
  WorkflowDefinition,
} from "./types.js";

interface QueuedRun {
  readonly runId: string;
  readonly controller: AbortController;
}

const PHASE_STEP: Readonly<Record<string, string>> = {
  read_javascript_artifacts: "read-sources",
  parse_javascript_sources: "parse-sources",
  parse_javascript_source: "parse-sources",
  build_javascript_application_graph: "build-graphs",
  seal_javascript_application_graph: "build-graphs",
  build_javascript_semantic_graph: "build-graphs",
  seal_javascript_semantic_graph: "build-graphs",
  validate_javascript_application_result: "validate-result",
  create_javascript_application_evidence: "persist-evidence",
  seal_javascript_application_result: "persist-evidence",
  validate_javascript_application_evidence: "persist-evidence",
  hash_javascript_application_evidence: "persist-evidence",
};

/** Owns the one local analysis worker and projects REA progress into events. */
export class WorkbenchRunManager {
  readonly #store: WorkbenchStore;
  readonly #queue: QueuedRun[] = [];
  readonly #sourceLimits: SourceSnapshotLimits;
  readonly #bundles: WorkbenchBundleStore;
  readonly #sourceSnapshots = new Map<string, RunAsarSourceSnapshot>();
  readonly #sourceLimitNoted = new Set<string>();
  #active: QueuedRun | undefined;
  #activeStep: string | undefined;

  constructor(
    store: WorkbenchStore,
    options: {
      readonly sourceSnapshotLimits?: Partial<SourceSnapshotLimits>;
      readonly bundles?: WorkbenchBundleStore;
    } = {},
  ) {
    this.#store = store;
    this.#sourceLimits = {
      ...DEFAULT_SOURCE_SNAPSHOT_LIMITS,
      ...options.sourceSnapshotLimits,
    };
    this.#bundles =
      options.bundles ??
      new WorkbenchBundleStore(defaultBundleRoot(store.databasePath));
  }

  /** Snapshot bound to a finished or running run, for tree and text reads. */
  getSourceSnapshot(runId: string): RunAsarSourceSnapshot | undefined {
    return this.#sourceSnapshots.get(runId);
  }

  /** Record the per-run read-limit diagnostic once, not per rejected read. */
  noteSourceReadLimit(runId: string, message: string): void {
    if (this.#sourceLimitNoted.has(runId)) return;
    this.#sourceLimitNoted.add(runId);
    this.#store.appendEvent({
      runId,
      type: "diagnostic.reported",
      payload: { kind: "source-read-limit", message },
    });
  }

  /** Release every run-scoped source snapshot (private ASAR copies). */
  async dispose(): Promise<void> {
    const snapshots = [...this.#sourceSnapshots.values()];
    this.#sourceSnapshots.clear();
    for (const snapshot of snapshots) {
      try {
        await snapshot.close();
      } catch {
        // A leaked snapshot directory is diagnosable on disk; closing must not mask other cleanup.
      }
    }
  }

  async createRun(input: {
    readonly projectId: string;
    readonly targetId: string;
    readonly workflow: WorkflowDefinition;
    readonly parameters: Record<string, JsonValue>;
    readonly idempotency?: {
      readonly key: string;
      readonly requestDigest: string;
    };
  }): Promise<{ readonly run: WorkbenchRun; readonly replayed: boolean }> {
    const target = this.#store.getTarget(input.targetId);
    if (target === null || target.projectId !== input.projectId)
      throw new Error("目标不存在或不属于当前项目");
    await access(target.path, constants.R_OK);
    const resolvedPath = await realpath(target.path);
    if (input.idempotency !== undefined) {
      const replayed = this.#replayByIdempotencyKey(input.idempotency);
      if (replayed !== null) return { run: replayed, replayed: true };
    }
    const run = this.#store.createRun({
      projectId: input.projectId,
      targetId: input.targetId,
      workflow: input.workflow,
      sourceSnapshot:
        target.format === "directory" ? { format: "directory" } : null,
      parameters: {
        ...input.parameters,
        input_path: resolvedPath,
        format: input.parameters.format ?? target.format,
        integrity_policy: input.parameters.integrity_policy ?? "fail",
      },
    });
    if (input.idempotency !== undefined) {
      try {
        this.#store.recordRunIdempotency(
          input.idempotency.key,
          input.idempotency.requestDigest,
          run.id,
        );
      } catch (cause: unknown) {
        // A racing same-key request won the unique binding; drop this
        // duplicate run and replay the winner so one key yields one run.
        this.#store.deleteRun(run.id);
        const winner = this.#replayByIdempotencyKey(input.idempotency);
        if (winner !== null) return { run: winner, replayed: true };
        throw cause;
      }
    }
    this.#store.appendEvent({
      runId: run.id,
      type: "run.created",
      payload: {
        workflow_id: run.workflowId,
        workflow_version: run.workflowVersion,
        target_id: run.targetId,
      },
    });
    const controller = new AbortController();
    this.#queue.push({ runId: run.id, controller });
    this.#pump();
    return { run, replayed: false };
  }

  #replayByIdempotencyKey(idempotency: {
    readonly key: string;
    readonly requestDigest: string;
  }): WorkbenchRun | null {
    const existing = this.#store.findRunIdempotency(idempotency.key);
    if (existing === null) return null;
    if (existing.requestDigest !== idempotency.requestDigest)
      throw new WorkbenchIdempotencyConflictError(existing.runId);
    const replayed = this.#store.getRun(existing.runId);
    if (replayed !== null) return replayed;
    // Stale binding to a run that no longer exists; cascade removes it so the
    // caller can re-create.
    this.#store.deleteRun(existing.runId);
    return null;
  }

  cancelRun(runId: string): WorkbenchRun {
    const current = this.#store.getRun(runId);
    if (current === null) throw new Error("运行不存在");
    if (
      ["succeeded", "failed", "cancelled", "interrupted"].includes(
        current.state,
      )
    )
      return current;
    this.#store.appendEvent({
      runId,
      type: "run.cancel_requested",
      payload: { requested_at: new Date().toISOString() },
    });
    const queued = this.#queue.find((entry) => entry.runId === runId);
    if (queued !== undefined && this.#active?.runId !== runId) {
      queued.controller.abort();
      this.#queue.splice(this.#queue.indexOf(queued), 1);
      const cancelled = this.#store.updateRun(runId, {
        state: "cancelled",
        resultCompleteness: "none",
        cleanupStatus: "not-required",
        finishedAt: new Date().toISOString(),
      });
      this.#store.appendEvent({
        runId,
        type: "run.finished",
        payload: { state: "cancelled", result_completeness: "none" },
      });
      return cancelled;
    }
    if (this.#active?.runId === runId) {
      this.#store.updateRun(runId, { state: "cancelling" });
      this.#active.controller.abort();
    }
    return this.#store.getRun(runId) ?? current;
  }

  #pump(): void {
    if (this.#active !== undefined) return;
    const next = this.#queue.shift();
    if (next === undefined) return;
    this.#active = next;
    void this.#execute(next).finally(() => {
      this.#active = undefined;
      this.#activeStep = undefined;
      this.#pump();
    });
  }

  async #execute(entry: QueuedRun): Promise<void> {
    const run = this.#store.getRun(entry.runId);
    if (run === null) return;
    const workflow = this.#store.getWorkflow(
      run.workflowId,
      run.workflowVersion,
    );
    if (workflow === null) {
      this.#fail(run.id, "流程定义不存在");
      return;
    }
    const startedAt = new Date().toISOString();
    this.#store.updateRun(run.id, { state: "starting", startedAt });
    this.#store.appendEvent({
      runId: run.id,
      type: "run.started",
      payload: { started_at: startedAt },
    });
    this.#startStep(run.id, workflow, "validate-target");
    this.#finishStep(
      run.id,
      "validate-target",
      "succeeded",
      "目标路径已授权并可读",
    );
    await this.#captureSourceSnapshot(run.id, String(run.input.input_path));
    const resources = new ArtifactResourceScope();
    let result: Awaited<ReturnType<typeof analyzeJavaScriptApplication>>;
    try {
      this.#store.updateRun(run.id, { state: "running" });
      const progress = createProgressReporter(
        async (update) => {
          const step =
            PHASE_STEP[update.phase] ?? this.#activeStep ?? "inventory";
          if (this.#activeStep !== step) {
            if (this.#activeStep !== undefined)
              this.#finishStep(run.id, this.#activeStep, "succeeded");
            this.#startStep(run.id, workflow, step);
            this.#activeStep = step;
          }
          this.#store.appendEvent({
            runId: run.id,
            type: "step.progress",
            stepInstanceId: step,
            payload: {
              phase: update.phase,
              completed: update.completed,
              ...(update.total === null ? {} : { total: update.total }),
              message: update.message,
            },
          });
        },
        { minimumIntervalMs: 50 },
      );
      result = await analyzeJavaScriptApplication(
        {
          input_path: run.input.input_path,
          format: run.input.format ?? "auto",
          integrity_policy: run.input.integrity_policy ?? "fail",
          ...(run.input.source_paths === undefined
            ? {}
            : { source_paths: run.input.source_paths }),
          ...(typeof run.input.max_semantic_nodes === "number"
            ? { max_semantic_nodes: run.input.max_semantic_nodes }
            : {}),
          ...(typeof run.input.max_semantic_nodes_per_file === "number"
            ? {
                max_semantic_nodes_per_file:
                  run.input.max_semantic_nodes_per_file,
              }
            : {}),
          ...(typeof run.input.max_heap_mb === "number"
            ? { max_heap_mb: run.input.max_heap_mb }
            : {}),
          ...(typeof run.input.analysis_timeout_ms === "number"
            ? { analysis_timeout_ms: run.input.analysis_timeout_ms }
            : {}),
        },
        resources,
        { signal: entry.controller.signal, progress },
      );
    } catch (cause: unknown) {
      result = {
        ok: false,
        error: cause instanceof Error ? cause : new Error(String(cause)),
      } as never;
    }
    let cleanupStatus: "complete" | "failed" = "complete";
    try {
      await resources.close();
    } catch (cause: unknown) {
      cleanupStatus = "failed";
      this.#store.appendEvent({
        runId: run.id,
        type: "diagnostic.reported",
        payload: { kind: "cleanup", message: describeError(cause) },
      });
    }
    if (result.ok) {
      if (this.#activeStep !== undefined)
        this.#finishStep(run.id, this.#activeStep, "succeeded");
      this.#startStep(run.id, workflow, "cleanup");
      this.#finishStep(
        run.id,
        "cleanup",
        cleanupStatus === "complete" ? "succeeded" : "failed",
        cleanupStatus === "complete" ? "资源释放完成" : "资源释放失败",
      );
      const evidence = result.value;
      const summary = summarizeEvidence(evidence);
      let bundle: WorkbenchBundleManifest | null = null;
      try {
        bundle = await this.#bundles.commit(
          {
            runId: run.id,
            evidenceId: evidence.evidence_id,
            targetSha256:
              typeof summary.root_artifact_sha256 === "string" &&
              summary.root_artifact_sha256 !== ""
                ? summary.root_artifact_sha256
                : null,
            workflowId: run.workflowId,
            workflowVersion: run.workflowVersion,
          },
          evidence,
        );
      } catch (cause: unknown) {
        // The analysis succeeded; a bundle failure must not turn into a run
        // error. Degrade to inline database evidence and record the reason.
        this.#store.appendEvent({
          runId: run.id,
          type: "diagnostic.reported",
          payload: { kind: "evidence-bundle", message: describeError(cause) },
        });
      }
      this.#store.updateRun(run.id, {
        state: "succeeded",
        resultCompleteness: "complete",
        cleanupStatus,
        finishedAt: new Date().toISOString(),
        evidenceId: evidence.evidence_id,
        resultSummary: summary,
        bundle,
        // Inline evidence only degrades into the database when the bundle
        // commit failed; committed runs keep the database to identity only.
        ...(bundle === null ? { evidence } : {}),
      });
      this.#store.appendEvent({
        runId: run.id,
        type: "evidence.recorded",
        payload: { evidence_id: evidence.evidence_id, summary },
      });
      this.#store.appendEvent({
        runId: run.id,
        type: "cleanup.finished",
        payload: { status: cleanupStatus },
      });
      this.#store.appendEvent({
        runId: run.id,
        type: "run.finished",
        payload: {
          state: "succeeded",
          result_completeness: "complete",
          cleanup_status: cleanupStatus,
        },
      });
      return;
    }
    const cancelled =
      entry.controller.signal.aborted ||
      this.#store.getRun(run.id)?.state === "cancelling";
    if (this.#activeStep !== undefined)
      this.#finishStep(
        run.id,
        this.#activeStep,
        cancelled ? "cancelled" : "failed",
        describeError(result.error),
      );
    const finalState: WorkbenchRunState = cancelled ? "cancelled" : "failed";
    const completeness: "partial" | "none" = cancelled ? "partial" : "none";
    const error = projectWorkbenchError(result.error);
    this.#store.updateRun(run.id, {
      state: finalState,
      resultCompleteness: completeness,
      cleanupStatus,
      finishedAt: new Date().toISOString(),
      error,
    });
    this.#store.appendEvent({
      runId: run.id,
      type: "diagnostic.reported",
      payload: error,
    });
    this.#store.appendEvent({
      runId: run.id,
      type: "cleanup.finished",
      payload: { status: cleanupStatus },
    });
    this.#store.appendEvent({
      runId: run.id,
      type: "run.finished",
      payload: {
        state: finalState,
        result_completeness: completeness,
        cleanup_status: cleanupStatus,
      },
    });
  }

  /**
   * Pin the run's source bytes before analysis: ASAR targets are copied once
   * into a private snapshot whose identity is recorded on the run. A snapshot
   * failure never fails the analysis; it is recorded as a diagnostic.
   */
  async #captureSourceSnapshot(
    runId: string,
    inputPath: string,
  ): Promise<void> {
    if (!inputPath.toLowerCase().endsWith(".asar")) return;
    try {
      const snapshot = await createRunSourceSnapshot(
        inputPath,
        this.#sourceLimits,
      );
      this.#sourceSnapshots.set(runId, snapshot);
      const identity = snapshot.identity;
      this.#store.updateRun(runId, { sourceSnapshot: identity });
      this.#store.appendEvent({
        runId,
        type: "artifact.available",
        payload: {
          kind: "source-snapshot",
          snapshot_sha256: identity.sha256,
          snapshot_bytes: identity.bytes,
        },
      });
    } catch (cause: unknown) {
      this.#store.appendEvent({
        runId,
        type: "diagnostic.reported",
        payload: { kind: "source-snapshot", message: describeError(cause) },
      });
    }
  }

  #startStep(
    runId: string,
    workflow: WorkflowDefinition,
    stepId: string,
  ): void {
    const definition = workflow.steps.find((step) => step.id === stepId);
    this.#store.appendEvent({
      runId,
      type: "step.started",
      stepInstanceId: stepId,
      payload: {
        step_definition_id: stepId,
        name: definition?.name ?? stepId,
        description: definition?.description ?? "",
      },
    });
  }

  #finishStep(
    runId: string,
    stepId: string,
    state: "succeeded" | "failed" | "cancelled",
    message?: string,
  ): void {
    this.#store.appendEvent({
      runId,
      type: "step.finished",
      stepInstanceId: stepId,
      payload: { state, ...(message === undefined ? {} : { message }) },
    });
  }

  #fail(runId: string, message: string): void {
    const error = { code: "workflow_unavailable", message };
    this.#store.updateRun(runId, {
      state: "failed",
      resultCompleteness: "none",
      cleanupStatus: "not-required",
      finishedAt: new Date().toISOString(),
      error,
    });
    this.#store.appendEvent({
      runId,
      type: "diagnostic.reported",
      payload: error,
    });
    this.#store.appendEvent({
      runId,
      type: "run.finished",
      payload: { state: "failed", result_completeness: "none" },
    });
  }
}

const summarizeEvidence = (evidence: Evidence): Record<string, JsonValue> => {
  const result = evidence.normalized_result;
  if (typeof result !== "object" || result === null || Array.isArray(result))
    return { evidence_id: evidence.evidence_id };
  const summary = result.summary;
  const statistics = result.statistics;
  return {
    evidence_id: evidence.evidence_id,
    root_artifact_sha256:
      typeof result.root_artifact_sha256 === "string"
        ? result.root_artifact_sha256
        : "",
    ...(isJsonRecord(summary) ? { electron_summary: summary } : {}),
    ...(isJsonRecord(statistics) ? { statistics } : {}),
    limitations: evidence.limitations,
  };
};

const isJsonRecord = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const projectWorkbenchError = (error: unknown): Record<string, JsonValue> => ({
  code:
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "analysis_failed",
  message: describeError(error),
});

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
