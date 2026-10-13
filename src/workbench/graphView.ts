import type { Evidence } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { parseApplicationGraphEvidence } from "../application/javascript/JavaScriptApplicationEvidenceGraph.js";
import { compareApplicationVersionsEvidence } from "../application/javascript/JavaScriptApplicationWorkflowService.js";
import type {
  ApplicationEdge,
  ApplicationNode,
} from "../domain/javascript/javascriptApplicationGraphSchemas.js";
import type { JavaScriptApplicationGraph } from "../domain/javascript/javascriptApplicationGraph.js";
import type { ApplicationVersionComparisonItem } from "../domain/javascript/javascriptApplicationVersionComparisonSchemas.js";
import { WorkbenchApiError } from "./api.js";
import type { WorkbenchBundleStore } from "./bundleStore.js";
import type { WorkbenchStore } from "./store.js";

/**
 * Read-side projections over one run's authenticated application graph. All
 * semantics (node/edge identity, diff matching, coverage) stay owned by the
 * REA domain and application layers; this module only paginates and shapes.
 */

export interface LoadedRunGraph {
  readonly runId: string;
  readonly evidenceId: string;
  readonly graph: JavaScriptApplicationGraph;
  readonly evidence: Evidence;
}

export type RunGraphOutcome =
  | { readonly status: "loaded"; readonly loaded: LoadedRunGraph }
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly reason: string };

/** Load one run's graph evidence through the owning application parser. */
export const loadRunGraph = (
  bundles: WorkbenchBundleStore,
  store: WorkbenchStore,
  runId: string,
): RunGraphOutcome => {
  const run = store.getRun(runId);
  if (run === null) return { status: "missing" };
  const evidence: unknown =
    bundles.readEvidence(runId) ?? store.getEvidence(runId);
  if (evidence === null) return { status: "missing" };
  const parsed = parseApplicationGraphEvidence(evidence);
  if (parsed.ok)
    return {
      status: "loaded",
      loaded: {
        runId,
        evidenceId: parsed.value.evidence.evidence_id,
        graph: parsed.value.graph,
        // The parser just authenticated this value as application Evidence.
        evidence: evidence as Evidence,
      },
    };
  const reason = parsed.error.issues.map((issue) => issue.message).join("; ");
  return {
    status: "invalid",
    reason: reason === "" ? "Evidence 不是可识别的应用图证据" : reason,
  };
};

export interface GraphPage<Item> {
  readonly items: readonly Item[];
  readonly total: number;
  readonly cursor: string | null;
}

/** Offset cursor over an already deterministically ordered array. */
export const page = <Item>(
  items: readonly Item[],
  cursor: string | null,
  limit: number,
): GraphPage<Item> => {
  const offset = decodeCursor(cursor);
  const slice = items.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  return {
    items: slice,
    total: items.length,
    cursor: nextOffset < items.length ? String(nextOffset) : null,
  };
};

export const decodeCursor = (cursor: string | null): number => {
  if (cursor === null) return 0;
  const parsed = Number(cursor);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new WorkbenchApiError("invalid_request", "分页游标不合法", [
      { path: "cursor", message: "必须是上一个响应返回的游标" },
    ]);
  return parsed;
};

export const nodeLabel = (node: ApplicationNode): string | null => {
  for (const observation of node.observations) {
    if (observation.label !== null) return observation.label;
  }
  return null;
};

export const nodeMatchesSearch = (
  node: ApplicationNode,
  search: string,
): boolean => {
  const needle = search.toLowerCase();
  if (node.node_id.toLowerCase().includes(needle)) return true;
  return node.observations.some(
    (observation) =>
      observation.label !== null &&
      observation.label.toLowerCase().includes(needle),
  );
};

/** Source locations carried by a node's observations, for traceback links. */
export const nodeLocations = (node: ApplicationNode): JsonValue[] => {
  const locations: JsonValue[] = [];
  for (const observation of node.observations) {
    const { evidence } = observation;
    if (evidence.location.available)
      locations.push(evidence.location.value as JsonValue);
  }
  return locations;
};

export const nodeEvidenceIds = (node: ApplicationNode): string[] => {
  const ids = new Set<string>();
  for (const observation of node.observations) {
    for (const id of observation.evidence.evidence_ids) ids.add(id);
  }
  return [...ids];
};

export const projectNode = (
  node: ApplicationNode,
  graphEvidenceId?: string,
): Record<string, JsonValue> => ({
  node_id: node.node_id,
  kind: node.kind,
  label: nodeLabel(node),
  observation_count: node.observations.length,
  locations: nodeLocations(node),
  // Observations may cite no specific evidence ids; the graph evidence itself
  // is then the citation for this node.
  evidence_ids:
    nodeEvidenceIds(node).length > 0
      ? nodeEvidenceIds(node)
      : graphEvidenceId
        ? [graphEvidenceId]
        : [],
});

export const projectEdge = (
  edge: ApplicationEdge,
): Record<string, JsonValue> => ({
  edge_id: edge.edge_id,
  source_node_id: edge.source_node_id,
  target_node_id: edge.target_node_id,
  relation: edge.relation,
  location: edge.evidence.location.available
    ? (edge.evidence.location.value as JsonValue)
    : null,
  evidence_ids: edge.evidence.evidence_ids,
});

export interface NeighborProjection {
  readonly center: Record<string, JsonValue>;
  readonly nodes: readonly Record<string, JsonValue>[];
  readonly edges: readonly Record<string, JsonValue>[];
  readonly truncated: boolean;
}

export const projectNeighbors = (
  graph: JavaScriptApplicationGraph,
  nodeId: string,
  direction: "in" | "out" | "both",
  limit: number,
  graphEvidenceId?: string,
): NeighborProjection | null => {
  const center = graph.nodes.find((node) => node.node_id === nodeId);
  if (center === undefined) return null;
  const edges = graph.edges.filter((edge) =>
    direction === "in"
      ? edge.target_node_id === nodeId
      : direction === "out"
        ? edge.source_node_id === nodeId
        : edge.source_node_id === nodeId || edge.target_node_id === nodeId,
  );
  const neighborIds = new Set<string>();
  for (const edge of edges) {
    if (edge.source_node_id !== nodeId) neighborIds.add(edge.source_node_id);
    if (edge.target_node_id !== nodeId) neighborIds.add(edge.target_node_id);
  }
  const truncated = neighborIds.size > limit;
  const nodes = [...neighborIds]
    .slice(0, limit)
    .map((id) => graph.nodes.find((node) => node.node_id === id))
    .filter((node): node is ApplicationNode => node !== undefined);
  const keptIds = new Set(nodes.map((node) => node.node_id));
  return {
    center: projectNode(center, graphEvidenceId),
    nodes: nodes.map((node) => projectNode(node, graphEvidenceId)),
    edges: edges
      .filter(
        (edge) =>
          keptIds.has(edge.source_node_id) && keptIds.has(edge.target_node_id),
      )
      .map(projectEdge),
    truncated,
  };
};

export interface RunDiffProjection {
  readonly comparisonId: string;
  readonly summary: {
    readonly unchanged: number;
    readonly added: number;
    readonly removed: number;
    readonly changed: number;
    readonly unknown: number;
  };
  readonly coverage: Record<string, JsonValue>;
  readonly limitations: readonly string[];
  readonly items: readonly ApplicationVersionComparisonItem[];
  readonly leftEvidenceId: string;
  readonly rightEvidenceId: string;
}

/**
 * Cross-run graph diff through the shared application workflow, so match
 * tiers, unknown handling, and coverage semantics stay owned by REA.
 */
export const compareRunGraphs = (input: {
  readonly left: Evidence;
  readonly right: Evidence;
}): RunDiffProjection => {
  const result = compareApplicationVersionsEvidence({
    left: input.left,
    right: input.right,
    left_native_observations: [],
    right_native_observations: [],
  });
  if (!result.ok)
    throw new WorkbenchApiError("run_rejected", describeError(result.error));
  const normalized = result.value.normalized_result;
  if (
    typeof normalized !== "object" ||
    normalized === null ||
    Array.isArray(normalized)
  )
    throw new WorkbenchApiError("internal_error", "版本比较证据缺少规范化结果");
  const { summary, coverage, items, left, right } = normalized as Record<
    string,
    JsonValue
  >;
  if (typeof summary !== "object" || summary === null || Array.isArray(summary))
    throw new WorkbenchApiError("internal_error", "版本比较证据缺少摘要");
  if (
    typeof coverage !== "object" ||
    coverage === null ||
    Array.isArray(coverage)
  )
    throw new WorkbenchApiError("internal_error", "版本比较证据缺少覆盖信息");
  return {
    comparisonId:
      typeof normalized.comparison_id === "string"
        ? normalized.comparison_id
        : "",
    summary: summary as RunDiffProjection["summary"],
    coverage: coverage as Record<string, JsonValue>,
    limitations: result.value.limitations,
    items: (Array.isArray(items)
      ? items
      : []) as unknown as readonly ApplicationVersionComparisonItem[],
    leftEvidenceId:
      typeof (left as Record<string, JsonValue> | undefined)?.evidence_id ===
      "string"
        ? String((left as Record<string, JsonValue>).evidence_id)
        : "",
    rightEvidenceId:
      typeof (right as Record<string, JsonValue> | undefined)?.evidence_id ===
      "string"
        ? String((right as Record<string, JsonValue>).evidence_id)
        : "",
  };
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
