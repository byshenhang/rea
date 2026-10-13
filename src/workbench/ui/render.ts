import type { WorkbenchRunEvent } from "../types.js";
import {
  failureExplanation,
  isActiveState,
  isRetryableState,
  statusText,
  statusTone,
  type UiDiff,
  type UiGraphNode,
  type UiNodeDetail,
  type UiRun,
  type UiState,
  type WorkbenchTab,
} from "./state.js";

/**
 * Pure render components for the Workbench UI: every function maps the typed
 * UiState to an HTML string. No DOM access, no fetches, no hidden state —
 * which keeps them unit-testable and keeps status strictly derived from the
 * server-provided state module.
 */

export const esc = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>'"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        char
      ] ?? char,
  );

export const fmtTime = (value: string | null): string =>
  value ? new Date(value).toLocaleString() : "—";

const pill = (state: string): string =>
  `<span class="pill ${statusTone(state)}" data-status="${esc(state)}">${esc(statusText(state))}</span>`;

export const errorBanner = (state: UiState): string => {
  if (state.error !== null)
    return `<div class="banner" role="alert"><span class="code">${esc(state.error.code ?? "error")}</span>${esc(state.error.message)}${
      state.error.details.length > 0
        ? `<ul>${state.error.details.map((detail) => `<li>${esc(detail)}</li>`).join("")}</ul>`
        : ""
    }</div>`;
  if (state.run !== null) {
    const explanation = failureExplanation(state.run);
    if (explanation !== null && state.run.state !== "interrupted")
      return `<div class="banner" role="alert"><span class="code">${esc(explanation.code ?? "error")}</span>${esc(explanation.message)}</div>`;
  }
  return "";
};

const partialResultNote = (state: UiState): string => {
  const run = state.run;
  if (run === null) return "";
  const notes: string[] = [];
  if (run.resultCompleteness === "partial")
    notes.push("结果完整性为 partial：部分覆盖已收集，缺失部分不视为不存在。");
  if (run.resultCompleteness === "none" && run.state === "failed")
    notes.push("本次运行没有产出结果。");
  if (run.cleanupStatus === "failed")
    notes.push("资源清理失败：诊断见事件时间线;该运行的读取资源可能仍被占用。");
  if (run.cleanupStatus === "unknown" && run.state === "interrupted")
    notes.push("清理状态未知：进程中断后无法确认资源是否已释放。");
  return notes.length === 0
    ? ""
    : `<div class="state-note" data-testid="state-note">${notes.map(esc).join("<br>")}</div>`;
};

export const sidebar = (state: UiState): string => {
  const projects = state.projects
    .map(
      (project) =>
        `<div class="project ${state.project?.id === project.id ? "active" : ""}" tabindex="0" role="button" data-project-id="${esc(project.id)}" data-action="select-project"><div>${esc(project.name)}</div><small class="muted">${esc(project.description || "未填写说明")}</small></div>`,
    )
    .join("");
  const targets =
    state.project === null
      ? ""
      : `<div class="section"><h3>目标</h3><div class="stack">${
          state.targets
            .map(
              (target) =>
                `<div class="target" tabindex="0" role="button" data-target-id="${esc(target.id)}" data-action="select-target"><div>${esc(target.path.split("/").pop() || target.path)}</div><small class="muted">${esc(target.path)}</small></div>`,
            )
            .join("") || '<div class="empty">登记目录或 ASAR</div>'
        }</div><div class="form-actions"><button class="ghost" data-action="new-target">+ 登记目标</button></div></div>`;
  const runs = state.runs
    .slice(0, 8)
    .map(
      (run) =>
        `<div class="run" tabindex="0" role="button" data-run-id="${esc(run.id)}" data-action="select-run"><div class="row">${pill(run.state)}<span class="muted">${fmtTime(run.createdAt)}</span></div><small class="muted">${esc(run.id.slice(0, 8))} · ${esc(run.resultCompleteness)}${run.state === "succeeded" ? "" : " · 无结果"}</small></div>`,
    )
    .join("");
  return `<aside class="sidebar"><div class="brand">REA Workbench</div><div class="muted">本地分析与流程调试台</div><div class="section"><h3>项目</h3><div class="stack">${projects || '<div class="empty">还没有项目</div>'}</div><div class="form-actions"><button class="ghost" data-action="new-project">+ 新建项目</button></div></div>${targets}<div class="section"><h3>最近运行</h3><div class="stack">${runs || '<div class="empty">暂无运行</div>'}</div></div></aside>`;
};

export const topbar = (state: UiState): string => {
  const runControls =
    state.run === null
      ? ""
      : `${pill(state.run.state)}${isActiveState(state.run.state) ? '<button data-action="cancel-run">取消运行</button>' : ""}${
          isRetryableState(state.run.state)
            ? '<button data-action="retry-run">重试运行</button>'
            : ""
        }<button class="ghost" data-action="export-evidence">导出</button><button class="ghost" data-action="open-diff">比较</button>`;
  return `<header class="topbar"><div><h1>${esc(state.run ? "运行工作台" : "项目首页")}</h1><div class="muted">${esc(state.project?.name || "选择一个项目开始")}</div></div><div class="row">${runControls}<button class="ghost" data-action="refresh">刷新</button></div></header>`;
};

const statCard = (label: string, value: string): string =>
  `<div class="card"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div></div>`;

export const homeView = (state: UiState): string =>
  `<div class="cards">${statCard("目标", String(state.targets.length))}${statCard("运行", String(state.runs.length))}${statCard(
    "成功",
    String(state.runs.filter((run) => run.state === "succeeded").length),
  )}${statCard("Provider", "REA JS")}</div><div class="panel" style="margin-top:14px"><h2>开始一次分析</h2><div class="panel-body"><p class="muted">工作台复用 REA 的 JavaScript/Electron 静态分析工作流,不执行目标代码。</p>${
    state.project
      ? '<button data-action="new-run">新建运行</button>'
      : '<button data-action="new-project">先创建项目</button>'
  }</div></div>${
    state.runs[0]
      ? `<div class="panel" style="margin-top:14px"><h2>最近运行</h2><div class="panel-body"><button data-run-id="${esc(state.runs[0].id)}" data-action="select-run">打开最近运行</button></div></div>`
      : ""
  }`;

const eventLine = (event: WorkbenchRunEvent): string => {
  const payload = event.payload as Record<string, unknown>;
  const detail =
    typeof payload.message === "string"
      ? payload.message
      : typeof payload.state === "string"
        ? payload.state
        : typeof payload.reason === "string"
          ? payload.reason
          : typeof payload.phase === "string"
            ? payload.phase
            : "";
  return `<div class="event" data-sequence="${String(event.sequence)}"><strong>${esc(event.type)}</strong> <span class="muted">#${String(event.sequence)} · ${fmtTime(event.timestamp)}</span><div class="detail">${esc(detail)}</div></div>`;
};

const stepsPanel = (state: UiState): string =>
  state.steps
    .map(
      (step) =>
        `<div class="step ${esc(step.state)}"><span class="dot"></span><div><div class="name">${esc(step.name)}</div><div class="message">${esc(step.message || statusText(step.state))}</div></div></div>`,
    )
    .join("") || '<div class="empty">等待事件</div>';

const graphTab = (state: UiState): string => {
  if (state.graphLoading && state.graphNodes.length === 0)
    return '<div class="loading">关系图载入中…</div>';
  if (state.graphError !== null)
    return `<div class="empty" data-testid="graph-unavailable">${esc(
      state.graphError.message,
    )}<br><span class="muted" style="font-size:11px">只有状态为成功的运行会生成应用关系图。</span></div>`;
  const rows =
    state.graphNodes
      .map(
        (node) =>
          `<div class="node" tabindex="0" role="button" data-node-id="${esc(node.node_id)}" data-action="open-node"><span class="node-kind">${esc(node.kind)}</span><span class="node-label">${esc(node.label || node.node_id)}</span></div>`,
      )
      .join("") || '<div class="empty">没有匹配的节点</div>';
  const more = state.graphCursor
    ? `<div style="padding:8px;text-align:center"><button class="ghost" data-action="load-more-graph">加载更多(已 ${String(state.graphNodes.length)}/${String(state.graphTotal)})</button></div>`
    : `<div class="empty" style="font-size:11px">共 ${String(state.graphTotal)} 个节点</div>`;
  return `<div class="row"><input id="graphSearch" placeholder="搜索节点(标签或 ID)" value="${esc(state.graphFilter.search)}" aria-label="搜索节点"><select id="graphKind" aria-label="节点类型"><option value="">全部类型</option>${graphKindOptions(state)} </select><button class="ghost" data-action="apply-graph-filter">筛选</button></div><div class="graph">${rows}${more}${nodeDetail(state)}</div>`;
};

const graphKindOptions = (state: UiState): string => {
  const kinds = new Set(state.graphNodes.map((node) => node.kind));
  if (state.graphFilter.kind !== "") kinds.add(state.graphFilter.kind);
  return [...kinds]
    .map(
      (kind) =>
        `<option value="${esc(kind)}" ${state.graphFilter.kind === kind ? "selected" : ""}>${esc(kind)}</option>`,
    )
    .join("");
};

const locationText = (location: unknown): string => {
  if (typeof location === "string") return location;
  if (typeof location === "object" && location !== null && "path" in location) {
    const path = (location as { path?: unknown }).path;
    if (typeof path === "string") return path;
  }
  return JSON.stringify(location);
};

export const nodeDetail = (state: UiState): string => {
  const detail: UiNodeDetail | null = state.nodeDetail;
  if (detail === null) return "";
  const node: UiGraphNode & { node_id: string } = detail.node;
  const locations = node.locations.map(locationText).join("<br>");
  return `<div style="border-top:1px solid var(--line);padding:10px" data-testid="node-detail"><div><strong>${esc(node.label || node.node_id)}</strong> <span class="pill">${esc(node.kind)}</span></div><div class="muted" style="font-size:11px">入边 ${String(detail.in_degree)} · 出边 ${String(detail.out_degree)} · 图 ${esc(String(detail.graph_id).slice(0, 12))}</div><div class="muted" style="font-size:11px;word-break:break-all">${locations || "无源码位置"}</div><div style="margin-top:6px"><button class="ghost" data-action="expand-neighbors">展开邻居</button> <button class="ghost" data-action="close-node-detail">关闭</button></div></div>`;
};

const diffTab = (state: UiState): string => {
  if (state.diffLoading) return '<div class="loading">差异计算中…</div>';
  const diff: UiDiff | null = state.diff;
  if (diff === null)
    return '<div class="empty" data-testid="diff-empty">输入另一个运行 ID,比较节点与边变化</div>';
  if (diff.status !== "compared")
    return `<div class="empty" data-testid="diff-unavailable">${esc(diff.limitations.join(";") || "差异不可用")}</div>`;
  const summary = diff.summary;
  if (summary === null)
    return '<div class="empty" data-testid="diff-unavailable">差异摘要缺失</div>';
  const changes = diff.changes
    .map((change) => {
      const where =
        change.locations.length > 0 ? locationText(change.locations[0]) : "";
      return `<div class="event" data-change-status="${esc(change.status)}"><strong>${esc(change.status)}</strong> <span class="muted">${esc(change.node_kind)}</span><div class="detail">${esc(where)}</div></div>`;
    })
    .join("");
  return `<div class="cards" style="grid-template-columns:repeat(5,minmax(0,1fr))">${statCard("新增", String(summary.added))}${statCard("删除", String(summary.removed))}${statCard("修改", String(summary.changed))}${statCard("未变", String(summary.unchanged))}${statCard("未知", String(summary.unknown))}</div><div class="muted" style="font-size:11px;margin:8px 0">覆盖:${esc(diff.coverage?.status ?? "—")}${diff.limitations.length > 0 ? `;${esc(diff.limitations.join(";"))}` : ""}</div><div class="timeline" style="max-height:320px" data-testid="diff-changes">${changes || '<div class="empty">两运行的节点没有变化</div>'}</div>`;
};

const sourceTab = (state: UiState): string => {
  const run: UiRun | null = state.run;
  const snapshotNote =
    run?.sourceSnapshot?.format === "asar"
      ? `读取自运行快照 <span class="pill">${esc(String(run.sourceSnapshot.sha256 ?? "").slice(0, 12))}</span>(目标文件后续变化不影响本运行内容)`
      : "读取自原始目标文件(只读,随目标变化)";
  const directories = state.files
    .filter((file) => file.kind === "directory")
    .map(
      (entry) =>
        `<div class="node" tabindex="0" role="button" data-action="open-files-prefix" data-prefix="${esc(entry.path)}"><span class="node-kind">目录</span><span class="node-label">${esc(entry.name)}</span></div>`,
    )
    .join("");
  const files = state.files
    .filter((file) => file.kind === "file")
    .map(
      (file) =>
        `<div class="node" tabindex="0" role="button" data-action="pick-source-file" data-path="${esc(file.path)}"><span class="node-kind">${esc(file.extension ?? "文件")}</span><span class="node-label">${esc(file.name ?? file.path)}</span></div>`,
    )
    .join("");
  const prefix = state.filesPrefix;
  const breadcrumb =
    prefix === ""
      ? "根目录"
      : `<a href="#" data-action="open-files-prefix" data-prefix="">根目录</a> / ${prefix
          .split("/")
          .map((segment, index, all) =>
            index === all.length - 1
              ? `<strong>${esc(segment)}</strong>`
              : `<a href="#" data-action="open-files-prefix" data-prefix="${esc(all.slice(0, index + 1).join("/"))}">${esc(segment)}</a>`,
          )
          .join(" / ")}`;
  return `<div class="row"><span class="muted" style="font-size:12px">路径:</span><span style="font-size:12px" data-testid="files-breadcrumb">${breadcrumb}</span></div><div class="graph" style="height:auto;max-height:200px">${directories}${files || '<div class="empty">此目录没有文件</div>'}</div><p class="muted" style="font-size:11px">${snapshotNote}</p><pre class="code" style="min-height:220px" data-testid="source-content">${esc(state.source?.content || "点击文件名查看;工作台只读显示源码。")}</pre>`;
};

const evidenceTab = (state: UiState): string => {
  if (state.evidenceLoading)
    return '<div class="loading">Evidence 载入中…</div>';
  if (state.evidenceError !== null)
    return `<div class="empty" data-testid="evidence-unavailable">${esc(
      state.evidenceError.message,
    )}<br><span class="muted" style="font-size:11px">取消或失败的运行没有 Evidence;重试运行成功后即可查看。</span></div>`;
  return `<pre class="code" data-testid="evidence-content">${esc(state.evidence === null ? "切换到此页后加载 Evidence" : JSON.stringify(state.evidence, null, 2))}</pre>`;
};

const tabPanel = (state: UiState): string => {
  const title: Record<WorkbenchTab, string> = {
    timeline: "执行时间线",
    graph: "关系图",
    diff: "运行差异",
    source: "源码查看",
    evidence: "Evidence 详情",
  };
  const body =
    state.tab === "timeline"
      ? `<div class="timeline" data-testid="timeline">${state.events.slice().reverse().map(eventLine).join("") || '<div class="empty">还没有事件</div>'}</div>`
      : state.tab === "graph"
        ? graphTab(state)
        : state.tab === "diff"
          ? `<div class="row"><input id="diffAgainst" placeholder="对比的运行 ID" style="flex:1" aria-label="对比的运行 ID"><button data-action="run-diff">比较</button></div><div class="graph">${diffTab(state)}</div>`
          : state.tab === "source"
            ? sourceTab(state)
            : evidenceTab(state);
  return `<div class="panel"><h2>${esc(title[state.tab])}</h2><div class="panel-body">${body}</div></div>`;
};

export const runView = (state: UiState): string => {
  const run: UiRun = state.run!;
  const stats = (run as unknown as { resultSummary?: Record<string, unknown> })
    .resultSummary as Record<string, unknown> | undefined;
  const statistics =
    typeof stats?.statistics === "object" && stats.statistics !== null
      ? (stats.statistics as Record<string, unknown>)
      : {};
  const tabs: WorkbenchTab[] = [
    "timeline",
    "graph",
    "diff",
    "source",
    "evidence",
  ];
  const labels: Record<WorkbenchTab, string> = {
    timeline: "执行时间线",
    graph: "结果图",
    diff: "差异",
    source: "源码",
    evidence: "Evidence",
  };
  return `<div class="cards">${statCard("状态", statusText(run.state))}${statCard("源码文件", String(statistics.parsed_javascript_files ?? "—"))}${statCard(
    "模块",
    String(statistics.modules ?? "—"),
  )}${statCard("Evidence", run.evidenceId === null ? "尚未生成" : String(run.evidenceId).slice(0, 13) + "…")}</div>${partialResultNote(state)}<div class="tabs">${tabs
    .map(
      (tab) =>
        `<button class="${state.tab === tab ? "active" : ""}" data-action="set-tab" data-tab="${tab}">${esc(labels[tab])}</button>`,
    )
    .join(
      "",
    )}</div><div class="workspace"><div class="panel"><h2>步骤</h2><div class="steps" data-testid="steps">${stepsPanel(state)}</div></div>${tabPanel(state)}<aside class="panel"><h2>上下文</h2><div class="panel-body"><p><span class="muted">目标</span><br>${esc(state.target?.path || "—")}</p><p><span class="muted">流程</span><br>${esc(run.workflowId)} @ ${esc(run.workflowVersion)}</p><p><span class="muted">开始</span><br>${fmtTime(run.startedAt)}</p><p><span class="muted">结束</span><br>${fmtTime(run.finishedAt)}</p><p><span class="muted">结果完整性</span><br>${pill(run.resultCompleteness)}</p><p><span class="muted">清理</span><br>${pill(run.cleanupStatus)}</p>${
    run.retryOfRunId === undefined
      ? ""
      : `<p><span class="muted">重试自</span><br>${esc(run.retryOfRunId.slice(0, 8))}</p>`
  }</div></aside></div>`;
};

export const appShell = (state: UiState): string =>
  `<div class="shell">${sidebar(state)}<main class="main">${topbar(state)}<section class="content">${errorBanner(state)}${
    state.loading
      ? '<div class="loading" data-testid="loading">工作台载入中…</div>'
      : state.run
        ? runView(state)
        : homeView(state)
  }</section></main></div>`;
