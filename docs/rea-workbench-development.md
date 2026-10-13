# REA Workbench 开发文档

## 目录和职责

```text
src/workbench/
├── main.ts            # 独立启动入口，打印访问地址、凭据和 Bundle 恢复摘要
├── server.ts          # loopback HTTP API、SSE 和内嵌浏览器 UI
├── store.ts           # SQLite schema、实体查询、事件日志和状态投影
├── runManager.ts      # 单 Worker 队列、取消、REA workflow 适配和清理
├── recovery.ts        # 启动时原子投影遗留运行为 interrupted
├── sourceSnapshot.ts  # 运行级 ASAR 源码快照：固定身份、文件树、受限文本读取
├── bundleStore.ts     # Evidence Bundle：原子提交、摘要校验读取、孤儿回收
├── graphView.ts       # 图投影：分页、邻居、节点详情与跨运行差异（复用 REA 比较工作流）
├── ui/                # 浏览器前端：state/client/render/app/bootstrap 模块（轻量 TS,无框架）
├── api.ts             # API 契约：错误封套、请求 Schema、响应类型
└── types.ts           # 流程、运行、事件和步骤的共享类型
```

工作台没有复制 JavaScript 分析逻辑。`runManager.ts` 调用 REA 的 `analyzeJavaScriptApplication`，把其 `ProgressReporter` 更新映射为 `step.progress`，把返回的 Evidence 原样保存。这样 CLI、MCP 和 Workbench 使用同一条分析逻辑和 Evidence 语义。

## 本地启动

使用仓库指定的 Node 版本（`.nvmrc` 为 `24.18.0`）安装依赖并编译：

```bash
nvm use
npm ci
npm run workbench:build
npm run workbench
```

启动后终端会打印：

- `http://127.0.0.1:4317`：浏览器访问地址。
- 一次性随机访问凭据：页面已内嵌，外部 API 调用使用 `X-REA-Workbench-Token`。
- SQLite 数据库路径。

可用环境变量：

| 变量                           | 默认值                              | 作用                             |
| ------------------------------ | ----------------------------------- | -------------------------------- |
| `REA_WORKBENCH_PORT`           | `4317`                              | 监听端口                         |
| `REA_WORKBENCH_TOKEN`          | 启动时随机生成                      | 固定本地访问凭据                 |
| `REA_WORKBENCH_DATABASE`       | `~/.rea-workbench/workbench.sqlite` | SQLite 路径                      |
| `REA_WORKBENCH_RUN_TIMEOUT_MS` | `1800000`                           | 整次分析时限（毫秒，含快照准备） |

## 开发流程

1. 启动 Workbench，创建项目并登记目录或 ASAR。
2. 创建运行，确认流程版本和完整性策略。
3. 在执行时间线观察 `run.started`、步骤事件、`evidence.recorded`、`cleanup.finished` 和 `run.finished`。
4. 在结果图查看有界节点和边，在源码页查看授权目录内的只读文件，在 Evidence 页核对目标摘要、Provider、参数和限制。
5. 修改 REA 源码后启动新运行，通过两个运行的 Evidence ID、目标摘要和事件时间线进行比较。

## 状态投影规则

服务端事件才是状态来源。日志只作为诊断文本。`step.progress` 不改变完整性或清理状态；`run.finished` 只在分析调用和资源释放都有结论后写入。取消操作先写 `run.cancel_requested`，再发送 AbortSignal；只有分析调用结束并完成清理后才写 `cancelled`。

## API 契约

请求与响应契约定义在 `src/workbench/api.ts`：

- **请求校验**：创建项目、目标、运行和比较的请求体经 zod Schema 校验。校验失败返回 `400 invalid_request`，`details` 列出字段路径与原因；请求体不是 JSON 对象返回 `400 malformed_body`；超过 256 KiB 返回 `413 body_too_large`。校验先于任何写入，非法请求不会产生部分实体。
- **错误封套**：所有错误响应统一为 `{"error":{"code":"...","message":"...","details?":[...]}}`。错误码与 HTTP 状态码的目录见 `src/workbench/api.ts` 的 `WORKBENCH_ERROR_STATUS`，例如 `run_not_found`→404、`idempotency_key_conflict`→409、`source_too_large`→413、`internal_error`→500。
- **幂等创建运行**：`POST /api/runs` 接受 `Idempotency-Key` 请求头（空白或超过 200 字符返回 400）。同键且请求内容一致时重放同一运行（响应头 `Idempotency-Replayed: true`）；同键不同内容返回 `409 idempotency_key_conflict`。绑定持久化在 `run_idempotency` 表并随运行级联删除。浏览器 UI 创建运行时自动生成 UUID 幂等键。
- **事件游标**：`GET /api/runs/:id/events?format=json` 支持 `after` 参数，只返回序号大于 `after` 的事件；未知运行统一返回 `404 run_not_found`。

### SSE 行为

`GET /api/runs/:id/events` 的服务端实现保证不丢不重：

1. 连接建立后先订阅实时事件（重叠到达的事件进入缓冲），再回放历史，最后按运行内序号（`sequence`）去重冲刷缓冲。
2. 每帧携带 `id: <sequence>`；客户端断线后以 `Last-Event-ID` 头或 `after` 查询参数续传，服务端只发送序号更大的事件。
3. 连接空闲时每 15 秒发送心跳注释；服务端发送 `retry: 3000` 提示浏览器自动重连间隔。

## 运行恢复、重试和诊断（V1.2）

- 启动先取得监听端口，恢复期间返回 `503 service_starting`；随后扫描 `queued/starting/running/finalizing/cancelling` 遗留运行。每个运行的状态修改与 `run.interrupted`、`run.finished` 事件在同一 SQLite 事务中提交，事件只在提交后推送。运行终态为 `interrupted`，完整性与清理状态均为 `unknown`，错误码为 `process_interrupted`；已有取消事件与 Evidence/Bundle 保留。启动摘要打印恢复数量。不尝试断点续跑。
- `POST /api/runs/:id/retry`（请求体 `{}`）仅允许 `failed/cancelled/interrupted` 且工作流声明 `capabilities.retry: true` 的运行；其他状态返回 `409 retry_not_allowed`。重试剥离旧 `input_path`，通过登记目标重新解析路径，并保留其余调用参数。创建新 run-id、新 Bundle，`run.created.payload.retry_of_run_id` 链接原运行，历史记录不变。支持 `Idempotency-Key`，同键重放同一新运行，即使目标后来不可读也可重放。事件级 `attemptId` 保持 null，运行链表达本版本的重试身份。
- 用户取消终态为 `cancelled`、错误码 `user_cancelled`；服务端超时终态为 `failed`、错误码 `analysis_timeout`，最终事件携带 `cause: "timeout"`；进程中断为 `interrupted/process_interrupted`。没有保留可用 Evidence 时完整性为 `none`，不因取消而宣称有 partial 结果。UI 上下文展示错误码与消息，并提供失败/取消/中断运行的重试按钮。
- 分析时限默认 30 分钟，嵌入调用可用 `createWorkbenchServer({ runTimeoutMs })` 调整。超时通过 AbortController 与分析 Promise 竞速触发，并等待分析响应取消后再关闭资源或启动下一任务。时间戳检查覆盖进度边界与结果发布前；不能硬抢占当前进程中的同步 JavaScript 阶段，清理所需时间也可能超过时限。调用者的 `analysis_timeout_ms` 仍原样传给 REA（它是解析 Worker 的预算，与工作台整次时限不同）。
- `GET /api/diagnostics` 需要凭据，返回 `queueLength`、`queuedRunIds`、`active {runId, step, startedAt}`、`lastStartupRecovery {recoveredRunIds, reasonCounts}`、`runTimeoutMs`、`databasePath` 和 `bundleRoot`，不修改内部状态。
- 关闭服务先停止 HTTP 连接，取消待执行与活动分析并等待其完成，然后释放快照、重试失败资源的清理，最后关闭数据库。清理失败的资源保持由管理器持有。

## Evidence Bundle

- 运行成功后，Evidence 写入 `<库目录>/bundles/<run-id>/`（`createWorkbenchServer({ bundleRoot })` 可改）：临时目录写入 `evidence.json` → 回读校验 → 写 `bundle.json` 清单与 `COMPLETE` 标记 → 原子 `rename` 发布；`bundle.json` 绑定 Evidence ID、payload sha256、目标摘要与工作流版本。
- 数据库 `runs.bundle_json` 只保存清单；`evidence_json` 仅在 Bundle 提交失败时降级使用，降级会记录一次 `evidence-bundle` 诊断且不改变运行结论。
- 每次读取 Bundle 都重算 sha256，不匹配返回 `500 bundle_integrity_failed`；启动时删除 `.tmp-*` 孤儿、把无标记目录隔离为 `.incomplete-*`，删除失败保留现场并追加 `bundle-diagnostics.log`。
- `/evidence`、`/export`、`/graph`、`/api/comparisons` 读取时 Bundle 优先、内联降级，契约不变。

## 浏览器前端（src/workbench/ui）

- 组件化采用轻量 TypeScript 模板路线:`state.ts` 定义类型化 UiState 与纯迁移(mergeEvents 去重、状态分类);`client.ts` 是类型化 API 客户端,把服务端错误封套解析为 `UiFailure`;`render.ts` 输出纯 HTML 字符串组件;`app.ts` 持有状态并处理事件委托与 SSE;`bootstrap.ts` 在运行时把编译产物拼接为经典脚本注入页面。构建链仍是 tsc,无前端框架。
- 状态只来自服务端 API 与 RunEvent;刷新后经 `sessionStorage`(`rea-workbench:run-id` / `rea-workbench:event-cursor`)恢复当前运行,并以 `Last-Event-ID` 续传事件。
- 错误封套(code/message/details)渲染为页面横幅;partial 完整性与 failed/unknown 清理状态有专门提示条。
- 真实浏览器验收用 playwright-core 驱动本机 Chrome(`REA_BROWSER_EXECUTABLE` 可覆盖,默认按 Playwright 缓存与系统 Chrome 解析),覆盖创建项目→登记目标→运行→取消→Evidence→刷新重连。

## 图浏览与运行差异

- 图证据经 REA 应用层 `parseApplicationGraphEvidence` 认证后投影；`node_id`/`edge_id` 是内容摘要（`jag_node_*`/`jag_edge_*`），同一内容跨运行稳定。
- 分页接口（默认 100、上限 500，`cursor` 为偏移游标）：`/graph/nodes`（`kind`、`search`）、`/graph/edges`（`relation`）、`/graph/neighbors`（`node_id`、`direction`、截断标志）、`/graph/nodes/:nodeId`（入/出度）。
- `/graph/diff?against=<runId>` 复用 `compareApplicationVersionsEvidence`：返回匹配分层摘要（unchanged/added/removed/changed/unknown）、覆盖状态与变更条目（含运行、Evidence 链接与源码位置）。任一侧图证据缺失或两次运行证据相同（内容摘要相同）时返回 `status:"unavailable"`，不把缺失或同版本当作增删。
- `POST /api/comparisons` 可选 `include_graph_diff: true` 在 `result.graph_diff` 返回同一摘要。

## 源码快照与读取限制

- **ASAR 目标**：运行启动时（目标检查步骤之后）通过 REA 的 `AsarArtifactReader` 把档案复制进私有快照目录，固定身份 `{format:"asar", sha256, bytes}` 写入运行记录并发 `artifact.available` 事件；文件树与文本读取全部来自该快照，目标档案后续变化不影响本运行内容。快照建立失败不中断分析，仅记录 `diagnostic.reported`。
- **目录目标**：不做复制，`/files` 与 `/source` 按授权根目录实时只读读取；响应 `origin` 字段区分 `run-snapshot` 与 `target-file`。
- **读取限制**：单文件上限 1 MB（快照成员按声明的成员大小先检查）；每个运行的累计文本读取上限默认 32 MB，嵌入调用可用 `createWorkbenchServer({ maxRunSourceBytes })` 调整。触达上限返回 `413 source_too_large`，并在该运行的事件流记录一次 `source-read-limit` 诊断。
- **路径规则**：`..`、`.`、空段、绝对路径与反斜杠一律 `400 invalid_path`；ASAR 内的 symlink 成员永不跟随，读取返回 `400 source_not_file`；仅允许文本扩展名（js/ts/json/html/css/md/xml/yaml 等），其余返回 `400 source_not_text`。

## 测试和检查

提交前至少运行：

```bash
npm run typecheck
npm run check:fast
npm run test:focused -- tests/boundary/workbench/workbenchApiContract.test.ts tests/boundary/workbench/workbenchSseReconnect.test.ts
npm run test:focused -- tests/boundary/workbench/workbenchAsarSource.test.ts
npm run test:focused -- tests/boundary/workbench/workbenchEvidenceBundle.test.ts
npm run test:focused -- tests/boundary/workbench/workbenchGraphDiff.test.ts
npm run test:focused -- tests/boundary/workbench/workbenchRunRecovery.test.ts
```

Workbench API 的契约与断线重连验收测试位于 `tests/boundary/workbench/`：契约测试在真实 loopback HTTP 服务器上覆盖鉴权、非法请求不写部分实体、幂等重放与冲突、真实 REA 分析的成功/失败/取消三条路径；SSE 测试用 `handle.store` 注入确定性事件，覆盖历史回放、实时合并不丢不重和 `Last-Event-ID`/`after` 续传；ASAR 测试用 `@electron/asar` 构造真实档案并跑完整分析，覆盖快照身份固定（覆盖目标后读取不变）、文件树、穿越拒绝、文本限制和读取预算。Bundle 测试覆盖原子提交、清单追溯、数据库分离、重启后读取、孤儿回收、篡改检测和提交失败降级。图差异测试覆盖同版本判定、增删回溯、覆盖守卫、游标翻页、邻居展开与 `include_graph_diff` 契约。存储模块语义（事件顺序、步骤投影、幂等绑定）的单元测试在 `src/server/workbenchStore.test.ts`。不要用模拟 Provider 宣称真实 REA Provider 已验证。

## 已知限制

- V1.2 前端下一步采用轻量 TypeScript 组件化，复用现有编译链；React/Vite 推迟到明确需要相关能力时评估。
- 数据库与 Bundle 仍按单个服务实例使用；不同端口访问同一数据库的并发实例不受支持。监听端口冲突会先于恢复失败，避免同端口重复启动修改活动运行。

- Evidence Bundle 每次读取都重算 sha256，超大规模 Bundle 的读取成本随体积线性增长。
- 图差异只比较 `analyze_javascript_application` 证据；native observations 侧通道（`left/right_native_observations`）暂未接入工作台差异。
- ASAR 快照 reader 与其私有临时目录存活到服务进程关闭（`handle.close()` 统一释放）；崩溃后残留的 `rea-asar-snapshot-*` 临时目录由操作系统临时目录策略回收。
- 累计读取预算在内存中计数，不跨服务重启保留。
- 浏览器验收测试依赖本机 Chrome 二进制;CI 环境无 Chrome 时该套件会失败,属预期（`REA_BROWSER_EXECUTABLE` 可指向任意 Chrome 系可执行文件）。
- SSE 去重按运行内序号单进程保证；跨进程多写者不在首期范围内。
