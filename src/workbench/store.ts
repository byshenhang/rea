import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";

import type { JsonValue } from "../domain/jsonValue.js";
import type {
  WorkbenchBundleManifest,
  WorkbenchCleanupStatus,
  WorkbenchEventType,
  WorkbenchProject,
  WorkbenchResultCompleteness,
  WorkbenchRun,
  WorkbenchRunEvent,
  WorkbenchRunState,
  WorkbenchSourceSnapshotIdentity,
  WorkbenchStepSnapshot,
  WorkbenchTarget,
  WorkflowDefinition,
} from "./types.js";

const DEFAULT_WORKFLOW: WorkflowDefinition = {
  workflowId: "rea.javascript-electron-static",
  version: "1.0.0",
  definitionDigest: "rea-workbench-js-electron-v1",
  name: "JavaScript / Electron 静态分析",
  description: "复用 REA 的应用图、语义图和 Electron 边界分析工作流。",
  supportedTargets: ["directory", "asar"],
  capabilities: { cancel: true, retry: true },
  steps: [
    {
      id: "validate-target",
      name: "目标检查",
      description: "检查目标路径、格式和读取权限。",
      type: "input",
    },
    {
      id: "inventory",
      name: "建立目标快照",
      description: "扫描目标并固定本次运行读取的内容身份。",
      type: "read",
    },
    {
      id: "read-sources",
      name: "读取源码",
      description: "读取已选 JavaScript 文件和资源。",
      type: "read",
    },
    {
      id: "parse-sources",
      name: "源码解析",
      description: "解析源码并构建静态语义投影。",
      type: "parse",
    },
    {
      id: "build-graphs",
      name: "构建关系图",
      description: "构建应用图、语义图和 Electron 边界关系。",
      type: "transform",
    },
    {
      id: "validate-result",
      name: "结果验证",
      description: "校验跨图绑定和覆盖限制。",
      type: "validate",
    },
    {
      id: "persist-evidence",
      name: "保存 Evidence",
      description: "生成并固定可追溯的 Evidence 身份。",
      type: "persist",
    },
    {
      id: "cleanup",
      name: "释放资源",
      description: "回收分析器和目标读取资源。",
      type: "cleanup",
    },
  ],
};

interface StoredRunRow {
  id: string;
  project_id: string;
  target_id: string;
  workflow_id: string;
  workflow_version: string;
  input_json: string;
  state: WorkbenchRunState;
  result_completeness: WorkbenchResultCompleteness;
  cleanup_status: WorkbenchCleanupStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  evidence_id: string | null;
  result_summary_json: string | null;
  error_json: string | null;
  source_snapshot_json: string | null;
  bundle_json: string | null;
}

interface StoredEventRow {
  event_id: string;
  run_id: string;
  sequence: number;
  timestamp: string;
  type: WorkbenchEventType;
  step_instance_id: string | null;
  attempt_id: string | null;
  payload_json: string;
}

type StoreEventListener = (event: WorkbenchRunEvent) => void;

/** Durable local metadata and event log for the Workbench. */
export class WorkbenchStore {
  readonly #db: DatabaseSync;
  readonly #events = new EventEmitter();
  readonly #databasePath: string;

  constructor(databasePath = defaultDatabasePath()) {
    this.#databasePath = databasePath;
    mkdirSync(dirname(databasePath), { recursive: true });
    this.#db = new DatabaseSync(databasePath, { timeout: 5_000 });
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS targets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        format TEXT NOT NULL CHECK (format IN ('auto', 'asar', 'directory')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflows (
        workflow_id TEXT NOT NULL,
        version TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        PRIMARY KEY (workflow_id, version)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE RESTRICT,
        workflow_id TEXT NOT NULL,
        workflow_version TEXT NOT NULL,
        input_json TEXT NOT NULL,
        state TEXT NOT NULL,
        result_completeness TEXT NOT NULL,
        cleanup_status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        evidence_id TEXT,
        evidence_json TEXT,
        result_summary_json TEXT,
        error_json TEXT,
        FOREIGN KEY (workflow_id, workflow_version) REFERENCES workflows(workflow_id, version)
      );
      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL UNIQUE,
        sequence INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        step_instance_id TEXT,
        attempt_id TEXT,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS run_idempotency (
        idempotency_key TEXT PRIMARY KEY,
        request_digest TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_targets_project ON targets(project_id);
      CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id, sequence);
    `);
    const runColumns = this.#db
      .prepare("PRAGMA table_info(runs)")
      .all() as Array<{ name: string }>;
    if (!runColumns.some((column) => column.name === "evidence_json"))
      this.#db.exec("ALTER TABLE runs ADD COLUMN evidence_json TEXT");
    if (!runColumns.some((column) => column.name === "source_snapshot_json"))
      this.#db.exec("ALTER TABLE runs ADD COLUMN source_snapshot_json TEXT");
    if (!runColumns.some((column) => column.name === "bundle_json"))
      this.#db.exec("ALTER TABLE runs ADD COLUMN bundle_json TEXT");
    this.saveWorkflow(DEFAULT_WORKFLOW);
  }

  get databasePath(): string {
    return this.#databasePath;
  }

  close(): void {
    this.#db.close();
  }

  onRunEvent(runId: string, listener: StoreEventListener): () => void {
    const key = `run:${runId}`;
    this.#events.on(key, listener);
    return () => this.#events.off(key, listener);
  }

  createProject(name: string, description = ""): WorkbenchProject {
    const project: WorkbenchProject = {
      id: randomUUID(),
      name,
      description,
      createdAt: new Date().toISOString(),
    };
    this.#db
      .prepare(
        "INSERT INTO projects (id, name, description, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(project.id, project.name, project.description, project.createdAt);
    return project;
  }

  listProjects(): WorkbenchProject[] {
    const rows = this.#db
      .prepare(
        "SELECT id, name, description, created_at FROM projects ORDER BY created_at DESC",
      )
      .all() as Array<{
      id: string;
      name: string;
      description: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.created_at,
    }));
  }

  getProject(id: string): WorkbenchProject | null {
    const row = this.#db
      .prepare(
        "SELECT id, name, description, created_at FROM projects WHERE id = ?",
      )
      .get(id) as
      | {
          id: string;
          name: string;
          description: string;
          created_at: string;
        }
      | undefined;
    return row === undefined
      ? null
      : {
          id: row.id,
          name: row.name,
          description: row.description,
          createdAt: row.created_at,
        };
  }

  createTarget(
    projectId: string,
    path: string,
    format: WorkbenchTarget["format"],
  ): WorkbenchTarget {
    const target: WorkbenchTarget = {
      id: randomUUID(),
      projectId,
      path,
      format,
      createdAt: new Date().toISOString(),
    };
    this.#db
      .prepare(
        "INSERT INTO targets (id, project_id, path, format, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        target.id,
        target.projectId,
        target.path,
        target.format,
        target.createdAt,
      );
    return target;
  }

  listTargets(projectId: string): WorkbenchTarget[] {
    const rows = this.#db
      .prepare(
        "SELECT id, project_id, path, format, created_at FROM targets WHERE project_id = ? ORDER BY created_at DESC",
      )
      .all(projectId) as Array<{
      id: string;
      project_id: string;
      path: string;
      format: WorkbenchTarget["format"];
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      path: row.path,
      format: row.format,
      createdAt: row.created_at,
    }));
  }

  getTarget(id: string): WorkbenchTarget | null {
    const row = this.#db
      .prepare(
        "SELECT id, project_id, path, format, created_at FROM targets WHERE id = ?",
      )
      .get(id) as
      | {
          id: string;
          project_id: string;
          path: string;
          format: WorkbenchTarget["format"];
          created_at: string;
        }
      | undefined;
    return row === undefined
      ? null
      : {
          id: row.id,
          projectId: row.project_id,
          path: row.path,
          format: row.format,
          createdAt: row.created_at,
        };
  }

  saveWorkflow(workflow: WorkflowDefinition): void {
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO workflows (workflow_id, version, definition_json) VALUES (?, ?, ?)",
      )
      .run(workflow.workflowId, workflow.version, JSON.stringify(workflow));
  }

  listWorkflows(): WorkflowDefinition[] {
    const rows = this.#db
      .prepare(
        "SELECT definition_json FROM workflows ORDER BY workflow_id, version",
      )
      .all() as Array<{ definition_json: string }>;
    return rows.map(
      (row) => JSON.parse(row.definition_json) as WorkflowDefinition,
    );
  }

  getWorkflow(workflowId: string, version: string): WorkflowDefinition | null {
    const row = this.#db
      .prepare(
        "SELECT definition_json FROM workflows WHERE workflow_id = ? AND version = ?",
      )
      .get(workflowId, version) as { definition_json: string } | undefined;
    return row === undefined
      ? null
      : (JSON.parse(row.definition_json) as WorkflowDefinition);
  }

  createRun(input: {
    readonly projectId: string;
    readonly targetId: string;
    readonly workflow: WorkflowDefinition;
    readonly parameters: Record<string, JsonValue>;
    readonly sourceSnapshot?: WorkbenchSourceSnapshotIdentity | null;
  }): WorkbenchRun {
    const run: WorkbenchRun = {
      id: randomUUID(),
      projectId: input.projectId,
      targetId: input.targetId,
      workflowId: input.workflow.workflowId,
      workflowVersion: input.workflow.version,
      input: input.parameters,
      state: "queued",
      resultCompleteness: "unknown",
      cleanupStatus: "unknown",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      evidenceId: null,
      resultSummary: null,
      error: null,
      sourceSnapshot: input.sourceSnapshot ?? null,
      bundle: null,
    };
    this.#db
      .prepare(`INSERT INTO runs (id, project_id, target_id, workflow_id, workflow_version, input_json, state, result_completeness, cleanup_status, created_at, source_snapshot_json, bundle_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        run.id,
        run.projectId,
        run.targetId,
        run.workflowId,
        run.workflowVersion,
        JSON.stringify(run.input),
        run.state,
        run.resultCompleteness,
        run.cleanupStatus,
        run.createdAt,
        run.sourceSnapshot === null ? null : JSON.stringify(run.sourceSnapshot),
        run.bundle === null ? null : JSON.stringify(run.bundle),
      );
    return run;
  }

  listRuns(projectId?: string): WorkbenchRun[] {
    const rows = (projectId === undefined
      ? this.#db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all()
      : this.#db
          .prepare(
            "SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC",
          )
          .all(projectId)) as unknown as StoredRunRow[];
    return rows.map((row) => this.#runFromRow(row));
  }

  getRun(id: string): WorkbenchRun | null {
    const row = this.#db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      | StoredRunRow
      | undefined;
    return row === undefined ? null : this.#runFromRow(row);
  }

  findRunIdempotency(
    key: string,
  ): { readonly runId: string; readonly requestDigest: string } | null {
    const row = this.#db
      .prepare(
        "SELECT run_id, request_digest FROM run_idempotency WHERE idempotency_key = ?",
      )
      .get(key) as { run_id: string; request_digest: string } | undefined;
    return row === undefined
      ? null
      : { runId: row.run_id, requestDigest: row.request_digest };
  }

  /** Bind a run to an idempotency key; UNIQUE rejects a racing duplicate. */
  recordRunIdempotency(
    key: string,
    requestDigest: string,
    runId: string,
  ): void {
    this.#db
      .prepare(
        "INSERT INTO run_idempotency (idempotency_key, request_digest, run_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(key, requestDigest, runId, new Date().toISOString());
  }

  deleteRun(id: string): void {
    this.#db.prepare("DELETE FROM runs WHERE id = ?").run(id);
  }

  updateRun(
    id: string,
    patch: Partial<
      Pick<
        WorkbenchRun,
        | "state"
        | "resultCompleteness"
        | "cleanupStatus"
        | "startedAt"
        | "finishedAt"
        | "evidenceId"
        | "resultSummary"
        | "error"
        | "sourceSnapshot"
        | "bundle"
      >
    > & { readonly evidence?: JsonValue },
  ): WorkbenchRun {
    const current = this.getRun(id);
    if (current === null) throw new Error(`Unknown Workbench run ${id}`);
    const next = { ...current, ...patch };
    this.#db
      .prepare(
        `UPDATE runs SET state = ?, result_completeness = ?, cleanup_status = ?, started_at = ?, finished_at = ?, evidence_id = ?, evidence_json = COALESCE(?, evidence_json), result_summary_json = ?, error_json = ?, source_snapshot_json = COALESCE(?, source_snapshot_json), bundle_json = COALESCE(?, bundle_json) WHERE id = ?`,
      )
      .run(
        next.state,
        next.resultCompleteness,
        next.cleanupStatus,
        next.startedAt,
        next.finishedAt,
        next.evidenceId,
        patch.evidence === undefined ? null : JSON.stringify(patch.evidence),
        next.resultSummary === null ? null : JSON.stringify(next.resultSummary),
        next.error === null ? null : JSON.stringify(next.error),
        patch.sourceSnapshot === undefined
          ? null
          : JSON.stringify(patch.sourceSnapshot),
        patch.bundle === undefined ? null : JSON.stringify(patch.bundle),
        id,
      );
    return next;
  }

  getEvidence(runId: string): JsonValue | null {
    const row = this.#db
      .prepare("SELECT evidence_json FROM runs WHERE id = ?")
      .get(runId) as { evidence_json: string | null } | undefined;
    return row?.evidence_json === null || row === undefined
      ? null
      : (JSON.parse(row.evidence_json) as JsonValue);
  }

  appendEvent(input: {
    readonly runId: string;
    readonly type: WorkbenchEventType;
    readonly stepInstanceId?: string;
    readonly attemptId?: string;
    readonly payload?: Record<string, JsonValue>;
  }): WorkbenchRunEvent {
    const row = this.#db
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM run_events WHERE run_id = ?",
      )
      .get(input.runId) as { sequence: number };
    const event: WorkbenchRunEvent = {
      eventId: randomUUID(),
      runId: input.runId,
      sequence: row.sequence + 1,
      timestamp: new Date().toISOString(),
      type: input.type,
      stepInstanceId: input.stepInstanceId ?? null,
      attemptId: input.attemptId ?? null,
      payload: input.payload ?? {},
    };
    this.#db
      .prepare(`INSERT INTO run_events (run_id, event_id, sequence, timestamp, type, step_instance_id, attempt_id, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        event.runId,
        event.eventId,
        event.sequence,
        event.timestamp,
        event.type,
        event.stepInstanceId,
        event.attemptId,
        JSON.stringify(event.payload),
      );
    this.#events.emit(`run:${event.runId}`, event);
    return event;
  }

  listEvents(runId: string, afterSequence = 0): WorkbenchRunEvent[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC",
      )
      .all(runId, afterSequence) as unknown as StoredEventRow[];
    return rows.map((row) => this.#eventFromRow(row));
  }

  listSteps(runId: string): WorkbenchStepSnapshot[] {
    const events = this.listEvents(runId);
    const steps = new Map<string, WorkbenchStepSnapshot>();
    for (const event of events) {
      const id = event.stepInstanceId;
      if (id === null) continue;
      const payload = event.payload;
      const current = steps.get(id) ?? {
        stepInstanceId: id,
        stepDefinitionId:
          typeof payload.step_definition_id === "string"
            ? payload.step_definition_id
            : id,
        name: typeof payload.name === "string" ? payload.name : id,
        state: "pending" as const,
        startedAt: null,
        finishedAt: null,
        message: null,
        completed: null,
        total: null,
        diagnostics: [],
      };
      const next = { ...current } as MutableStepSnapshot;
      if (event.type === "step.started") next.state = "running";
      if (event.type === "step.waiting") next.state = "waiting";
      if (event.type === "step.progress") {
        next.state = "running";
        next.completed =
          typeof payload.completed === "number"
            ? payload.completed
            : next.completed;
        next.total =
          typeof payload.total === "number" ? payload.total : next.total;
        next.message =
          typeof payload.message === "string" ? payload.message : next.message;
      }
      if (event.type === "step.finished") {
        const state = payload.state;
        next.state =
          state === "failed" || state === "cancelled" || state === "skipped"
            ? state
            : "succeeded";
        next.finishedAt = event.timestamp;
        next.message =
          typeof payload.message === "string" ? payload.message : next.message;
      }
      if (event.type === "step.started") next.startedAt = event.timestamp;
      if (event.type === "diagnostic.reported")
        next.diagnostics = [...next.diagnostics, payload];
      steps.set(id, next);
    }
    return [...steps.values()];
  }

  #runFromRow(row: StoredRunRow): WorkbenchRun {
    return {
      id: row.id,
      projectId: row.project_id,
      targetId: row.target_id,
      workflowId: row.workflow_id,
      workflowVersion: row.workflow_version,
      input: JSON.parse(row.input_json) as Record<string, JsonValue>,
      state: row.state,
      resultCompleteness: row.result_completeness,
      cleanupStatus: row.cleanup_status,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      evidenceId: row.evidence_id,
      resultSummary:
        row.result_summary_json === null
          ? null
          : (JSON.parse(row.result_summary_json) as Record<string, JsonValue>),
      error:
        row.error_json === null
          ? null
          : (JSON.parse(row.error_json) as Record<string, JsonValue>),
      sourceSnapshot:
        row.source_snapshot_json === null ||
        row.source_snapshot_json === undefined
          ? null
          : (JSON.parse(
              row.source_snapshot_json,
            ) as WorkbenchSourceSnapshotIdentity),
      bundle:
        row.bundle_json === null || row.bundle_json === undefined
          ? null
          : (JSON.parse(row.bundle_json) as WorkbenchBundleManifest),
    };
  }

  #eventFromRow(row: StoredEventRow): WorkbenchRunEvent {
    return {
      eventId: row.event_id,
      runId: row.run_id,
      sequence: row.sequence,
      timestamp: row.timestamp,
      type: row.type,
      stepInstanceId: row.step_instance_id,
      attemptId: row.attempt_id,
      payload: JSON.parse(row.payload_json) as Record<string, JsonValue>,
    };
  }
}

type MutableStepSnapshot = {
  -readonly [Key in keyof WorkbenchStepSnapshot]: WorkbenchStepSnapshot[Key];
};

export const defaultDatabasePath = (): string =>
  process.env.REA_WORKBENCH_DATABASE ??
  join(homedir(), ".rea-workbench", "workbench.sqlite");

export const defaultWorkflow = (): WorkflowDefinition =>
  structuredClone(DEFAULT_WORKFLOW);
