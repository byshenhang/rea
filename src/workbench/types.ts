import type { JsonValue } from "../domain/jsonValue.js";

export type WorkbenchRunState =
  | "queued"
  | "starting"
  | "running"
  | "finalizing"
  | "succeeded"
  | "failed"
  | "cancelling"
  | "cancelled"
  | "interrupted";

export type WorkbenchResultCompleteness =
  | "complete"
  | "partial"
  | "none"
  | "unknown";

/** Identity of the source bytes a run is bound to for browsing and disclosure. */
export type WorkbenchSourceSnapshotIdentity =
  | { readonly format: "asar"; readonly sha256: string; readonly bytes: number }
  | { readonly format: "directory" };

/**
 * Manifest persisted inside a run's evidence bundle. It binds the payload
 * digest to the Evidence ID, target digest, and workflow version so each side
 * can be traced from the others.
 */
export interface WorkbenchBundleManifest {
  readonly bundle_version: 1;
  readonly run_id: string;
  readonly evidence_id: string;
  readonly evidence_sha256: string;
  readonly target_sha256: string | null;
  readonly workflow_id: string;
  readonly workflow_version: string;
  readonly committed_at: string;
}

export type WorkbenchCleanupStatus =
  | "complete"
  | "failed"
  | "unknown"
  | "not-required";

export type WorkbenchEventType =
  | "run.created"
  | "run.started"
  | "run.interrupted"
  | "step.started"
  | "step.progress"
  | "step.waiting"
  | "artifact.available"
  | "evidence.recorded"
  | "diagnostic.reported"
  | "step.finished"
  | "run.cancel_requested"
  | "cleanup.finished"
  | "run.finished";

export interface WorkbenchProject {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly createdAt: string;
}

export interface WorkbenchTarget {
  readonly id: string;
  readonly projectId: string;
  readonly path: string;
  readonly format: "auto" | "asar" | "directory";
  readonly createdAt: string;
}

export interface WorkflowStepDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly type:
    | "input"
    | "read"
    | "parse"
    | "transform"
    | "validate"
    | "persist"
    | "cleanup";
}

export interface WorkflowDefinition {
  readonly workflowId: string;
  readonly version: string;
  readonly definitionDigest: string;
  readonly name: string;
  readonly description: string;
  readonly supportedTargets: readonly ("directory" | "asar")[];
  readonly capabilities: { readonly cancel: boolean; readonly retry: boolean };
  readonly steps: readonly WorkflowStepDefinition[];
}

export interface WorkbenchRun {
  readonly id: string;
  readonly projectId: string;
  readonly targetId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly input: Record<string, JsonValue>;
  readonly state: WorkbenchRunState;
  readonly resultCompleteness: WorkbenchResultCompleteness;
  readonly cleanupStatus: WorkbenchCleanupStatus;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly evidenceId: string | null;
  readonly resultSummary: Record<string, JsonValue> | null;
  readonly error: Record<string, JsonValue> | null;
  readonly sourceSnapshot: WorkbenchSourceSnapshotIdentity | null;
  readonly bundle: WorkbenchBundleManifest | null;
}

export interface WorkbenchRunEvent {
  readonly eventId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: WorkbenchEventType;
  readonly stepInstanceId: string | null;
  readonly attemptId: string | null;
  readonly payload: Record<string, JsonValue>;
}

export interface WorkbenchStepSnapshot {
  readonly stepInstanceId: string;
  readonly stepDefinitionId: string;
  readonly name: string;
  readonly state:
    | "pending"
    | "running"
    | "waiting"
    | "succeeded"
    | "failed"
    | "skipped"
    | "cancelled"
    | "interrupted";
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly message: string | null;
  readonly completed: number | null;
  readonly total: number | null;
  readonly diagnostics: readonly Record<string, JsonValue>[];
}
