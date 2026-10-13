import type { JsonValue } from "../../domain/jsonValue.js";
import type { WorkbenchRunEvent } from "../types.js";
import {
  humanizeError,
  type UiDiff,
  type UiGraphNode,
  type UiNodeDetail,
  type UiProject,
  type UiRun,
  type UiState,
  type UiTarget,
  type WorkbenchTab,
} from "./state.js";

/**
 * Typed HTTP/SSE client for the Workbench UI. Every failure surfaces as a
 * UiFailure carrying the server's error envelope, so components can show
 * code, message, and details instead of an opaque string.
 */

export class UiFailure extends Error {
  readonly banner: ReturnType<typeof humanizeError>;

  constructor(banner: ReturnType<typeof humanizeError>) {
    super(banner.message);
    this.banner = banner;
  }
}

export interface ApiRequestInit {
  readonly method?: string;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

export interface WorkbenchApiClient {
  readonly token: string;
  get<T>(path: string): Promise<T>;
  post<T>(
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T>;
  /** Raw fetch for downloads that must not be parsed as JSON. */
  fetchRaw(path: string): Promise<Response>;
}

export const createApiClient = (token: string): WorkbenchApiClient => ({
  token,
  fetchRaw: async (path: string): Promise<Response> => {
    const response = await fetch(path, {
      headers: { "X-REA-Workbench-Token": token },
    });
    if (!response.ok) throw await toFailure(response);
    return response;
  },
  get: async <T>(path: string): Promise<T> => {
    const response = await fetch(path, {
      headers: { "X-REA-Workbench-Token": token },
    });
    if (!response.ok) throw await toFailure(response);
    return (await response.json()) as T;
  },
  post: async <T>(
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> => {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-REA-Workbench-Token": token,
        ...headers,
      },
      body: JSON.stringify(body ?? {}),
    });
    if (!response.ok) throw await toFailure(response);
    return (await response.json()) as T;
  },
});

const toFailure = async (response: Response): Promise<UiFailure> => {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON failure body; fall back to the HTTP status text.
  }
  const envelope =
    typeof payload === "object" && payload !== null && "error" in payload
      ? (
          payload as {
            error: {
              code?: string;
              message: string;
              details?: readonly { path?: string; message: string }[];
            };
          }
        ).error
      : undefined;
  if (envelope !== undefined) return new UiFailure(humanizeError(envelope));
  return new UiFailure(
    humanizeError({ message: `请求失败(HTTP ${String(response.status)})` }),
  );
};

export const listProjects = async (
  client: WorkbenchApiClient,
): Promise<UiProject[]> => client.get<UiProject[]>("/api/projects");
export const listTargets = async (
  client: WorkbenchApiClient,
  projectId: string,
): Promise<UiTarget[]> =>
  client.get<UiTarget[]>(
    `/api/projects/${encodeURIComponent(projectId)}/targets`,
  );
export const listRuns = async (
  client: WorkbenchApiClient,
  projectId?: string,
): Promise<UiRun[]> =>
  client.get<UiRun[]>(
    `/api/runs${projectId === undefined ? "" : `?project_id=${encodeURIComponent(projectId)}`}`,
  );
export const getRun = async (
  client: WorkbenchApiClient,
  runId: string,
): Promise<UiRun> =>
  client.get<UiRun>(`/api/runs/${encodeURIComponent(runId)}`);
export const listSteps = (
  client: WorkbenchApiClient,
  runId: string,
): Promise<UiState["steps"]> =>
  client.get<UiState["steps"]>(`/api/runs/${encodeURIComponent(runId)}/steps`);
export const listEvents = async (
  client: WorkbenchApiClient,
  runId: string,
  after: number,
): Promise<WorkbenchRunEvent[]> =>
  client.get<WorkbenchRunEvent[]>(
    `/api/runs/${encodeURIComponent(runId)}/events?format=json&after=${String(after)}`,
  );
export const cancelRun = (
  client: WorkbenchApiClient,
  runId: string,
): Promise<UiRun> =>
  client.post<UiRun>(`/api/runs/${encodeURIComponent(runId)}/cancel`);
export const retryRun = (
  client: WorkbenchApiClient,
  runId: string,
  idempotencyKey: string,
): Promise<UiRun> =>
  client.post<UiRun>(
    `/api/runs/${encodeURIComponent(runId)}/retry`,
    {},
    { "Idempotency-Key": idempotencyKey },
  );
export const createRun = (
  client: WorkbenchApiClient,
  input: {
    readonly projectId: string;
    readonly targetId: string;
    readonly idempotencyKey: string;
  },
  integrityPolicy: string,
): Promise<UiRun> =>
  client.post<UiRun>(
    "/api/runs",
    {
      project_id: input.projectId,
      target_id: input.targetId,
      parameters: { integrity_policy: integrityPolicy },
    },
    { "Idempotency-Key": input.idempotencyKey },
  );
export const createProject = (
  client: WorkbenchApiClient,
  name: string,
  description: string,
): Promise<UiProject> =>
  client.post<UiProject>("/api/projects", { name, description });
export const createTarget = (
  client: WorkbenchApiClient,
  projectId: string,
  path: string,
  format: string,
): Promise<UiTarget> =>
  client.post<UiTarget>(
    `/api/projects/${encodeURIComponent(projectId)}/targets`,
    { path, format },
  );

export interface GraphNodesPage {
  readonly total: number;
  readonly cursor: string | null;
  readonly nodes: UiGraphNode[];
}

export const listGraphNodes = async (
  client: WorkbenchApiClient,
  runId: string,
  filter: { readonly search: string; readonly kind: string },
  cursor: string | null,
  limit: number,
): Promise<GraphNodesPage> => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (filter.search !== "") params.set("search", filter.search);
  if (filter.kind !== "") params.set("kind", filter.kind);
  if (cursor !== null) params.set("cursor", cursor);
  return client.get<GraphNodesPage>(
    `/api/runs/${encodeURIComponent(runId)}/graph/nodes?${params.toString()}`,
  );
};

export const getNodeDetail = (
  client: WorkbenchApiClient,
  runId: string,
  nodeId: string,
): Promise<UiNodeDetail> =>
  client.get<UiNodeDetail>(
    `/api/runs/${encodeURIComponent(runId)}/graph/nodes/${encodeURIComponent(nodeId)}`,
  );

export interface NeighborsPage {
  readonly nodes: UiGraphNode[];
  readonly truncated: boolean;
}

export const listNeighbors = (
  client: WorkbenchApiClient,
  runId: string,
  nodeId: string,
  limit: number,
): Promise<NeighborsPage> =>
  client.get<NeighborsPage>(
    `/api/runs/${encodeURIComponent(runId)}/graph/neighbors?node_id=${encodeURIComponent(nodeId)}&limit=${String(limit)}`,
  );

export const getDiff = (
  client: WorkbenchApiClient,
  runId: string,
  against: string,
  change: string,
  limit: number,
): Promise<UiDiff> =>
  client.get<UiDiff>(
    `/api/runs/${encodeURIComponent(runId)}/graph/diff?against=${encodeURIComponent(against)}&change=${change}&limit=${String(limit)}`,
  );

export interface UiFileEntry {
  readonly path: string;
  readonly kind: string;
}

export const listFiles = (
  client: WorkbenchApiClient,
  runId: string,
): Promise<UiFileEntry[]> =>
  client.get<UiFileEntry[]>(`/api/runs/${encodeURIComponent(runId)}/files`);
export const getSource = (
  client: WorkbenchApiClient,
  runId: string,
  path: string,
): Promise<{ path: string; content: string; origin: string }> =>
  client.get(
    `/api/runs/${encodeURIComponent(runId)}/source?path=${encodeURIComponent(path)}`,
  );
export const getEvidence = (
  client: WorkbenchApiClient,
  runId: string,
): Promise<JsonValue> =>
  client.get<JsonValue>(`/api/runs/${encodeURIComponent(runId)}/evidence`);

export interface SseHandlers {
  readonly onEvent: (event: WorkbenchRunEvent) => void;
  readonly onOpen: () => void;
  readonly onError: () => void;
}

/**
 * EventSource subscription with Last-Event-ID resume. The browser reconnects
 * automatically; `close` stops it and `lastSequence` seeds the cursor for the
 * first connection.
 */
export interface RunEventSubscription {
  close(): void;
}

export const subscribeRunEvents = (
  token: string,
  runId: string,
  lastSequence: number,
  handlers: SseHandlers,
): RunEventSubscription => {
  const source = new EventSource(
    `/api/runs/${encodeURIComponent(runId)}/events?token=${encodeURIComponent(token)}&after=${String(lastSequence)}`,
  );
  source.onopen = () => handlers.onOpen();
  source.onerror = () => handlers.onError();
  const forward = (event: unknown): void => {
    try {
      const data = (event as { data?: unknown }).data;
      if (typeof data !== "string") return;
      handlers.onEvent(JSON.parse(data) as WorkbenchRunEvent);
    } catch {
      // A malformed frame never crashes the subscription; the next poll of
      // /events?format=json reconciles any gap.
    }
  };
  for (const type of [
    "run.created",
    "run.started",
    "run.interrupted",
    "step.started",
    "step.progress",
    "step.waiting",
    "artifact.available",
    "evidence.recorded",
    "diagnostic.reported",
    "step.finished",
    "run.cancel_requested",
    "cleanup.finished",
    "run.finished",
  ]) {
    source.addEventListener(type, forward);
  }
  return {
    close: () => source.close(),
  };
};

export type { WorkbenchTab };
