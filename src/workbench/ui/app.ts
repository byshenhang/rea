import type { WorkbenchRunEvent } from "../types.js";
import {
  initialUiState,
  eventCursor,
  isTerminalState,
  mergeEvents,
  type UiState,
  type WorkbenchTab,
} from "./state.js";
import * as api from "./client.js";
import { appShell } from "./render.js";

/**
 * Workbench UI controller: owns the UiState instance, applies user intents,
 * renders through the pure components, and manages the SSE subscription.
 * Session storage keeps the selected run and event cursor across reloads so
 * a refresh resumes exactly where the operator was.
 */

const SESSION_RUN_KEY = "rea-workbench:run-id";
const SESSION_CURSOR_KEY = "rea-workbench:event-cursor";

interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WorkbenchAppOptions {
  readonly root: HTMLElement;
  readonly client: api.WorkbenchApiClient;
  readonly sessionStorage?: StorageLike;
  readonly confirmPrompt?: (message: string, fallback: string) => string | null;
}

type RefreshGraphMode = "reset" | "append";

export class WorkbenchApp {
  readonly #root: HTMLElement;
  readonly #client: api.WorkbenchApiClient;
  readonly #sessionStorage: StorageLike | null;
  readonly #prompt: (message: string, fallback: string) => string | null;
  #state: UiState = initialUiState();
  #subscription: api.RunEventSubscription | null = null;
  #graphLimit = 100;

  constructor(options: WorkbenchAppOptions) {
    this.#root = options.root;
    this.#client = options.client;
    this.#sessionStorage = options.sessionStorage ?? readSessionStorage();
    this.#prompt =
      options.confirmPrompt ??
      ((message, fallback) => globalThis.prompt(message, fallback));
    this.#root.addEventListener("click", (event) =>
      this.#onClick(event as MouseEventLike),
    );
    this.#root.addEventListener("keydown", (event) =>
      this.#onKeyDown(event as KeyboardEventLike),
    );
    this.#root.addEventListener("change", (event) =>
      this.#onChange(event as EventLike),
    );
  }

  get state(): UiState {
    return this.#state;
  }

  /** Mutate state through a pure transition and re-render. */
  #update(mutation: (draft: UiState) => UiState): void {
    this.#state = mutation(this.#state);
    this.#render();
  }

  #patch(partial: Partial<UiState>): void {
    this.#update((current) => ({ ...current, ...partial }));
  }

  #render(): void {
    this.#root.innerHTML = appShell(this.#state);
  }

  #fail(error: unknown): void {
    this.#patch({
      error:
        error instanceof api.UiFailure
          ? error.banner
          : {
              code: null,
              message: error instanceof Error ? error.message : String(error),
              details: [],
            },
    });
  }

  /** Bootstrap: restore the session selection, then load data. */
  async start(): Promise<void> {
    const restoredRunId =
      this.#sessionStorage?.getItem(SESSION_RUN_KEY) ?? null;
    try {
      await this.#loadDirectory({ restoredRunId });
    } catch (error) {
      this.#fail(error);
    }
  }

  async #loadDirectory(
    options: { readonly restoredRunId?: string | null } = {},
  ): Promise<void> {
    const projects = await api.listProjects(this.#client);
    const remembered =
      options.restoredRunId ??
      this.#sessionStorage?.getItem(SESSION_RUN_KEY) ??
      null;
    let run = this.#state.run;
    let project = this.#state.project;
    let targets = this.#state.targets;
    if (remembered !== null) {
      try {
        run = await api.getRun(this.#client, remembered);
        project =
          projects.find((entry) => entry.id === run?.projectId) ??
          projects[0] ??
          null;
        targets =
          project === null
            ? []
            : await api.listTargets(this.#client, project.id);
      } catch {
        run = null;
        this.#sessionStorage?.removeItem(SESSION_RUN_KEY);
        this.#sessionStorage?.removeItem(SESSION_CURSOR_KEY);
      }
    }
    if (run === null) {
      project =
        project !== null && projects.some((entry) => entry.id === project?.id)
          ? project
          : (projects[0] ?? null);
      // Always refetch: the project's targets may have changed since the
      // last render (e.g. a registration this same flow just performed).
      targets =
        project === null ? [] : await api.listTargets(this.#client, project.id);
    }
    const runs = await api.listRuns(this.#client, project?.id);
    this.#patch({
      projects,
      targets,
      project,
      runs,
      run,
      loading: false,
      error: null,
    });
    if (run !== null) {
      await this.#loadRunDetail(run.id, { restoreCursor: true });
    }
  }

  async #loadRunDetail(
    runId: string,
    options: { readonly restoreCursor: boolean },
  ): Promise<void> {
    const [run, steps] = await Promise.all([
      api.getRun(this.#client, runId),
      api.listSteps(this.#client, runId),
    ]);
    let events = this.#state.events;
    if (options.restoreCursor || this.#state.run?.id !== runId) {
      const after = options.restoreCursor
        ? readStoredCursor(this.#sessionStorage, runId)
        : 0;
      events = await api.listEvents(this.#client, runId, after).catch(() => []);
    }
    const target =
      this.#state.targets.find((entry) => entry.id === run.targetId) ??
      this.#state.target;
    this.#patch({
      run,
      steps,
      events: mergeEvents(
        options.restoreCursor ? [] : this.#state.events,
        events,
      ),
      target,
      tab: options.restoreCursor ? "timeline" : this.#state.tab,
      graphNodes: [],
      graphCursor: null,
      graphTotal: 0,
      nodeDetail: null,
      nodeDetailId: null,
      diff: null,
      files: [],
      source: null,
      evidence: null,
      error: null,
    });
    this.#sessionStorage?.setItem(SESSION_RUN_KEY, runId);
    this.#persistCursor();
    this.#subscribe(run.id);
  }

  #persistCursor(): void {
    const runId = this.#state.run?.id;
    if (runId === undefined) return;
    this.#sessionStorage?.setItem(
      SESSION_CURSOR_KEY,
      `${runId}:${String(eventCursor(this.#state.events))}`,
    );
  }

  storedCursor(runId: string): number {
    return readStoredCursor(this.#sessionStorage, runId);
  }

  #subscribe(runId: string): void {
    this.#subscription?.close();
    this.#subscription = api.subscribeRunEvents(
      this.#client.token,
      runId,
      eventCursor(this.#state.events),
      {
        onEvent: (event) => void this.#onServerEvent(event),
        onOpen: () => undefined,
        onError: () => undefined,
      },
    );
  }

  close(): void {
    this.#subscription?.close();
    this.#subscription = null;
  }

  async #onServerEvent(event: WorkbenchRunEvent): Promise<void> {
    if (this.#state.run?.id !== event.runId) return;
    this.#update((current) => ({
      ...current,
      events: mergeEvents(current.events, [event]),
    }));
    this.#persistCursor();
    const runId = event.runId;
    const [run, steps] = await Promise.all([
      api.getRun(this.#client, runId),
      api.listSteps(this.#client, runId),
    ]);
    this.#patch({ run, steps });
    if (isTerminalState(run.state)) {
      this.#subscription?.close();
      this.#subscription = null;
    }
  }

  #onClick(event: MouseEventLike): void {
    const target =
      event.target === null ? null : event.target.closest("[data-action]");
    if (target === null) return;
    const action = target.dataset.action;
    const runId = target.dataset.runId;
    void this.#runIntent(action, target, runId);
  }

  #onKeyDown(event: KeyboardEventLike): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target =
      event.target === null ? null : event.target.closest("[data-action]");
    if (target === null || target.getAttribute("role") !== "button") return;
    event.preventDefault();
    void this.#runIntent(target.dataset.action, target, target.dataset.runId);
  }

  #onChange(event: EventLike): void {
    const target =
      event.target === null
        ? null
        : event.target.closest("[data-action='pick-source']");
    if (target === null || target.value === "" || target.value === undefined)
      return;
    void this.#pickSource(target.value);
  }

  async #runIntent(
    action: string | undefined,
    target: HTMLElement,
    runId: string | undefined,
  ): Promise<void> {
    try {
      switch (action) {
        case "refresh":
          await this.#loadDirectory();
          return;
        case "select-project":
          await this.#selectProject(target.dataset.projectId ?? "");
          return;
        case "select-target":
          this.#selectTarget(target.dataset.targetId ?? "");
          return;
        case "select-run":
          await this.#selectRun(runId ?? "");
          return;
        case "new-project":
          await this.#newProject();
          return;
        case "new-target":
          await this.#newTarget();
          return;
        case "new-run":
          await this.#newRun();
          return;
        case "cancel-run":
          await this.#cancelRun();
          return;
        case "retry-run":
          await this.#retryRun();
          return;
        case "export-evidence":
          await this.#exportEvidence();
          return;
        case "open-diff":
          this.#setTab("diff");
          return;
        case "set-tab":
          this.#setTab((target.dataset.tab ?? "timeline") as WorkbenchTab);
          return;
        case "apply-graph-filter":
          await this.#applyGraphFilter();
          return;
        case "load-more-graph":
          await this.#loadGraph("append");
          return;
        case "open-node":
          await this.#openNode(target.dataset.nodeId ?? "");
          return;
        case "expand-neighbors":
          await this.#expandNeighbors();
          return;
        case "close-node-detail":
          this.#patch({ nodeDetail: null, nodeDetailId: null });
          return;
        case "run-diff":
          await this.#runDiffFromInput();
          return;
        case "load-files":
          await this.#loadFiles();
          return;
        default:
          return;
      }
    } catch (error) {
      this.#fail(error);
    }
  }

  async #selectProject(projectId: string): Promise<void> {
    const project =
      this.#state.projects.find((entry) => entry.id === projectId) ?? null;
    const targets =
      project === null ? [] : await api.listTargets(this.#client, project.id);
    const runs = await api.listRuns(this.#client, project?.id);
    this.#subscription?.close();
    this.#subscription = null;
    this.#sessionStorage?.removeItem(SESSION_RUN_KEY);
    this.#sessionStorage?.removeItem(SESSION_CURSOR_KEY);
    this.#patch({
      project,
      targets,
      runs,
      run: null,
      target: null,
      events: [],
      steps: [],
      graphNodes: [],
      graphCursor: null,
      nodeDetail: null,
      diff: null,
      files: [],
      source: null,
      evidence: null,
      error: null,
    });
  }

  #selectTarget(targetId: string): void {
    this.#patch({
      target:
        this.#state.targets.find((entry) => entry.id === targetId) ?? null,
      error: null,
    });
  }

  async #selectRun(runId: string): Promise<void> {
    if (runId === "") return;
    await this.#loadRunDetail(runId, { restoreCursor: false });
  }

  async #newProject(): Promise<void> {
    const name = this.#prompt("项目名称", "");
    if (name === null || name.trim() === "") return;
    const description = this.#prompt("项目说明(可留空)", "") ?? "";
    await this.#client.post("/api/projects", {
      name: name.trim(),
      description,
    });
    await this.#loadDirectory();
  }

  async #newTarget(): Promise<void> {
    const projectId = this.#state.project?.id;
    if (projectId === undefined) return;
    const path = this.#prompt("目标绝对路径(目录或 ASAR)", "");
    if (path === null || path.trim() === "") return;
    await api.createTarget(
      this.#client,
      projectId,
      path.trim(),
      path.toLowerCase().endsWith(".asar") ? "asar" : "auto",
    );
    await this.#loadDirectory();
  }

  async #newRun(): Promise<void> {
    const project = this.#state.project;
    const target = this.#state.target ?? this.#state.targets[0];
    if (project === undefined || project === null || target === undefined)
      return;
    const integrity =
      this.#prompt("完整性策略:fail 或 record-and-continue", "fail") ?? "fail";
    const run = await api.createRun(
      this.#client,
      {
        projectId: project.id,
        targetId: target.id,
        idempotencyKey: randomIdempotencyKey(),
      },
      integrity === "" ? "fail" : integrity,
    );
    await this.#loadRunDetail(run.id, { restoreCursor: false });
  }

  async #cancelRun(): Promise<void> {
    const run = this.#state.run;
    if (run === null) return;
    const cancelled = await api.cancelRun(this.#client, run.id);
    this.#patch({ run: cancelled });
  }

  async #retryRun(): Promise<void> {
    const run = this.#state.run;
    if (run === null) return;
    const retried = await api.retryRun(
      this.#client,
      run.id,
      randomIdempotencyKey(),
    );
    await this.#loadRunDetail(retried.id, { restoreCursor: false });
  }

  async #exportEvidence(): Promise<void> {
    const run = this.#state.run;
    if (run === null) return;
    const response = await this.#client.fetchRaw(
      `/api/runs/${encodeURIComponent(run.id)}/export`,
    );
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `rea-workbench-${run.id}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  #setTab(tab: WorkbenchTab): void {
    this.#patch({ tab, error: null });
    if (tab === "graph" && this.#state.graphNodes.length === 0)
      void this.#loadGraph("reset");
    if (tab === "evidence" && this.#state.evidence === null)
      void this.#loadEvidence();
    if (tab === "source" && this.#state.files.length === 0)
      void this.#loadFiles();
  }

  async #loadGraph(mode: RefreshGraphMode): Promise<void> {
    const run = this.#state.run;
    if (run === null) return;
    this.#patch({ graphLoading: true });
    try {
      const cursor = mode === "reset" ? null : this.#state.graphCursor;
      const page = await api.listGraphNodes(
        this.#client,
        run.id,
        this.#state.graphFilter,
        cursor,
        this.#graphLimit,
      );
      this.#update((current) => {
        if (mode === "reset")
          return {
            ...current,
            graphNodes: page.nodes,
            graphCursor: page.cursor,
            graphTotal: page.total,
            graphLoading: false,
          };
        const seen = new Set(current.graphNodes.map((node) => node.node_id));
        const merged = [
          ...current.graphNodes,
          ...page.nodes.filter((node) => !seen.has(node.node_id)),
        ];
        return {
          ...current,
          graphNodes: merged,
          graphCursor: page.cursor,
          graphTotal: page.total,
          graphLoading: false,
        };
      });
    } catch (error) {
      this.#patch({ graphLoading: false });
      throw error;
    }
  }

  async #applyGraphFilter(): Promise<void> {
    const search = inputById("graphSearch")?.value ?? "";
    const kind = inputById("graphKind")?.value ?? "";
    this.#patch({ graphFilter: { search, kind } });
    await this.#loadGraph("reset");
  }

  async #openNode(nodeId: string): Promise<void> {
    const run = this.#state.run;
    if (run === null || nodeId === "") return;
    const detail = await api.getNodeDetail(this.#client, run.id, nodeId);
    this.#patch({ nodeDetail: detail, nodeDetailId: nodeId });
  }

  async #expandNeighbors(): Promise<void> {
    const run = this.#state.run;
    const nodeId =
      this.#state.nodeDetailId ?? this.#state.nodeDetail?.node.node_id;
    if (
      run === undefined ||
      run === null ||
      nodeId === undefined ||
      nodeId === ""
    )
      return;
    const page = await api.listNeighbors(this.#client, run.id, nodeId, 50);
    this.#update((current) => {
      const seen = new Set(current.graphNodes.map((node) => node.node_id));
      return {
        ...current,
        graphNodes: [
          ...current.graphNodes,
          ...page.nodes.filter((node) => !seen.has(node.node_id)),
        ],
      };
    });
  }

  async #runDiffFromInput(): Promise<void> {
    const run = this.#state.run;
    const input = inputById("diffAgainst")?.value.trim();
    if (run === null || input === undefined || input === "") return;
    this.#patch({ diffLoading: true });
    try {
      const diff = await api.getDiff(this.#client, run.id, input, "all", 50);
      this.#patch({ diff, diffLoading: false });
    } catch (error) {
      this.#patch({ diffLoading: false });
      throw error;
    }
  }

  async #loadEvidence(): Promise<void> {
    const run = this.#state.run;
    if (run === null) return;
    this.#patch({ evidenceLoading: true });
    try {
      const evidence = await api.getEvidence(this.#client, run.id);
      this.#patch({ evidence, evidenceLoading: false });
    } catch (error) {
      this.#patch({ evidenceLoading: false, evidence: null });
      throw error;
    }
  }

  async #loadFiles(): Promise<void> {
    const run = this.#state.run;
    if (run === null) return;
    const files = await api.listFiles(this.#client, run.id);
    this.#patch({ files });
  }

  async #pickSource(path: string): Promise<void> {
    const run = this.#state.run;
    if (run === null || path === "") return;
    const source = await api.getSource(this.#client, run.id, path);
    this.#patch({ source });
  }
}

const readStoredCursor = (
  storage: StorageLike | null,
  runId: string,
): number => {
  const raw = storage?.getItem(SESSION_CURSOR_KEY);
  if (raw === null || raw === undefined) return 0;
  const [storedRun, sequence] = raw.split(":");
  return storedRun === runId &&
    sequence !== undefined &&
    /^\d+$/u.test(sequence)
    ? Number(sequence)
    : 0;
};

const readSessionStorage = (): StorageLike | null => sessionStorage ?? null;

const inputById = (id: string): HTMLInputElement | HTMLSelectElement | null => {
  const element = document.getElementById(id);
  if (element === null) return null;
  return "value" in element
    ? (element as HTMLInputElement)
    : (element as unknown as HTMLSelectElement);
};

const randomIdempotencyKey = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `ui-${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
