import type { IncomingMessage } from "node:http";

import { z } from "zod";

import type { JsonValue } from "../domain/jsonValue.js";

/**
 * Caller-visible Workbench API contract: unified error envelope, request
 * schemas, and response shapes. HTTP and SSE stay at this boundary; nothing
 * here leaks into the REA domain layer.
 */

export type WorkbenchApiErrorCode =
  | "unauthorized"
  | "origin_denied"
  | "not_found"
  | "project_not_found"
  | "target_not_found"
  | "run_not_found"
  | "evidence_not_available"
  | "graph_not_available"
  | "invalid_request"
  | "invalid_path"
  | "target_unreadable"
  | "workflow_not_found"
  | "run_rejected"
  | "source_snapshot_unavailable"
  | "source_not_file"
  | "source_not_text"
  | "source_read_failed"
  | "source_too_large"
  | "file_listing_failed"
  | "body_too_large"
  | "malformed_body"
  | "idempotency_key_conflict"
  | "bundle_integrity_failed"
  | "internal_error";

export const WORKBENCH_ERROR_STATUS: Readonly<
  Record<WorkbenchApiErrorCode, number>
> = {
  unauthorized: 401,
  origin_denied: 403,
  not_found: 404,
  project_not_found: 404,
  target_not_found: 404,
  run_not_found: 404,
  evidence_not_available: 404,
  graph_not_available: 404,
  invalid_request: 400,
  invalid_path: 400,
  target_unreadable: 400,
  workflow_not_found: 400,
  run_rejected: 400,
  source_snapshot_unavailable: 400,
  source_not_file: 400,
  source_not_text: 400,
  source_read_failed: 400,
  source_too_large: 413,
  file_listing_failed: 400,
  body_too_large: 413,
  malformed_body: 400,
  idempotency_key_conflict: 409,
  bundle_integrity_failed: 500,
  internal_error: 500,
};

export interface WorkbenchErrorDetail {
  readonly path?: string;
  readonly message: string;
}

export interface WorkbenchErrorEnvelope {
  readonly error: {
    readonly code: WorkbenchApiErrorCode;
    readonly message: string;
    readonly details?: readonly WorkbenchErrorDetail[];
  };
}

/** Tagged API failure carrying its HTTP status and unified envelope. */
export class WorkbenchApiError extends Error {
  readonly code: WorkbenchApiErrorCode;
  readonly details: readonly WorkbenchErrorDetail[] | undefined;

  constructor(
    code: WorkbenchApiErrorCode,
    message: string,
    details?: readonly WorkbenchErrorDetail[],
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return WORKBENCH_ERROR_STATUS[this.code];
  }

  envelope(): WorkbenchErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

/** Thrown when a request body is not a JSON object. */
export class WorkbenchMalformedBodyError extends WorkbenchApiError {
  constructor() {
    super("malformed_body", "请求体必须是合法 JSON 对象");
  }
}

/** Thrown when a request body exceeds the accepted size. */
export class WorkbenchBodyTooLargeError extends WorkbenchApiError {
  constructor() {
    super("body_too_large", "请求体过大");
  }
}

/** Thrown when an idempotency key is reused with different request content. */
export class WorkbenchIdempotencyConflictError extends WorkbenchApiError {
  readonly runId: string;

  constructor(runId: string) {
    super("idempotency_key_conflict", "幂等键已绑定到不同的请求内容", [
      { path: "idempotency_key", message: `已绑定运行 ${runId}` },
    ]);
    this.runId = runId;
  }
}

export const idempotencyKeyHeader = "idempotency-key";
const MAX_IDEMPOTENCY_KEY_CHARS = 200;

export const parseIdempotencyKey = (
  value: string | string[] | undefined,
): string | null => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return null;
  const key = raw.trim();
  if (key === "")
    throw new WorkbenchApiError("invalid_request", "幂等键不能为空", [
      { path: idempotencyKeyHeader, message: "提供时不能为空白" },
    ]);
  if (key.length > MAX_IDEMPOTENCY_KEY_CHARS)
    throw new WorkbenchApiError("invalid_request", "幂等键过长", [
      {
        path: idempotencyKeyHeader,
        message: `最多 ${String(MAX_IDEMPOTENCY_KEY_CHARS)} 字符`,
      },
    ]);
  return key;
};

export const createProjectBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().max(2000).optional(),
});

export const createTargetBodySchema = z.object({
  path: z.string().min(1).max(4096),
  format: z.enum(["auto", "asar", "directory"]).optional(),
});

export const createRunBodySchema = z.object({
  project_id: z.string().min(1).max(128),
  target_id: z.string().min(1).max(128),
  workflow_id: z.string().min(1).max(200).optional(),
  workflow_version: z.string().min(1).max(64).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

export const createComparisonBodySchema = z.object({
  left_run_id: z.string().min(1).max(128),
  right_run_id: z.string().min(1).max(128),
  include_graph_diff: z.boolean().optional(),
});

/** Parse a JSON object body and validate it against a schema. */
export const parseJsonBody = async <Schema extends z.ZodType>(
  request: IncomingMessage,
  schema: Schema,
): Promise<z.output<Schema>> => {
  const raw = await readBodyRecord(request);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new WorkbenchApiError(
      "invalid_request",
      "请求字段不符合契约",
      parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join(".") || "(root)",
        message: issue.message,
      })),
    );
  }
  return parsed.data;
};

const MAX_BODY_BYTES = 256 * 1024;

const readBodyRecord = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > MAX_BODY_BYTES) throw new WorkbenchBodyTooLargeError();
    chunks.push(data);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WorkbenchMalformedBodyError();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new WorkbenchMalformedBodyError();
  return parsed;
};

/** Deterministic digest of the fields that identify a run creation request. */
export const runRequestDigest = (input: {
  readonly projectId: string;
  readonly targetId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly parameters: Record<string, JsonValue>;
}): string =>
  JSON.stringify([
    input.projectId,
    input.targetId,
    input.workflowId,
    input.workflowVersion,
    input.parameters,
  ]);

/** Response shapes shared by the HTTP handlers and contract tests. */
export interface WorkbenchFileEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly extension: string | null;
  /** ASAR snapshot entries only: declared member size in bytes. */
  readonly size?: number | null;
  /** ASAR snapshot entries only: symlink member; its target is never followed. */
  readonly symlink?: boolean;
}

export interface WorkbenchSourceContent {
  readonly path: string;
  readonly content: string;
  readonly size: number;
  /** Whether the bytes came from the run's fixed snapshot or the live target. */
  readonly origin: "run-snapshot" | "target-file";
  /** ASAR snapshot reads only: sha256 of the snapshot that served the bytes. */
  readonly snapshot_sha256?: string;
}

export interface WorkbenchGraphResponse {
  readonly graph_id: JsonValue | null;
  readonly coverage: JsonValue | null;
  readonly limitations: JsonValue;
  readonly nodes: readonly JsonValue[];
  readonly edges: readonly JsonValue[];
}

export interface WorkbenchComparisonResponse {
  readonly comparison_id: string;
  readonly comparable: boolean;
  readonly configuration: {
    readonly left_run_id: string;
    readonly right_run_id: string;
    readonly same_workflow: boolean;
    readonly same_target: boolean;
    readonly left_root_artifact_sha256: string | null;
    readonly right_root_artifact_sha256: string | null;
  };
  readonly execution: {
    readonly left: {
      readonly state: string;
      readonly completeness: string;
      readonly duration_ms: number | null;
    };
    readonly right: {
      readonly state: string;
      readonly completeness: string;
      readonly duration_ms: number | null;
    };
  };
  readonly result: {
    readonly left: Record<string, JsonValue>;
    readonly right: Record<string, JsonValue>;
    readonly limitations: readonly string[];
    /** Present only when the caller asked include_graph_diff. */
    readonly graph_diff?: Record<string, JsonValue> | null;
  };
}

/** Zod mirror of the unified error envelope, for contract tests. */
export const workbenchErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z
      .array(z.object({ path: z.string().optional(), message: z.string() }))
      .optional(),
  }),
});
