# REA Workbench 后续开发任务与接力执行说明

本文档用于在首期 P0 闭环完成后，指导其他 AI 或开发者连续完成后续版本。执行者应先阅读：

- [REA Workbench 产品与技术设计](./rea-workbench-design.md)
- [REA Workbench 开发文档](./rea-workbench-development.md)
- `AGENTS.md`
- `docs/tool-design.md`
- `docs/testing.md`

## 当前基线

当前工作台已经具备可运行的 P0 闭环：项目和目标登记、JavaScript/Electron 静态分析、单 Worker 队列、取消、结构化步骤事件、SSE、SQLite 持久化、Evidence 查看和导出、有限关系图查询、目录源码查看、基础运行比较。

V1.1 的三个 P0.5 任务已全部完成（2026-10-13）：API 契约、幂等和断线重连验收；ASAR 源码快照与安全文件树；Evidence Bundle 和资源生命周期。所有写接口经 zod Schema 校验；统一错误封套 `{"error":{code,message,details?}}` 与错误码-状态码目录（`src/workbench/api.ts`）；`POST /api/runs` 支持 `Idempotency-Key` 幂等；SSE 订阅先于历史回放并按运行内序号去重，支持 `Last-Event-ID` / `after` 断点续传。ASAR 目标在运行启动时复制进私有快照并固定身份，`/files` 与 `/source` 提供运行快照文件树和受限文本读取。运行 Evidence 持久化为文件系统 Bundle（原子提交 + 摘要清单），数据库只保存清单身份，重启后仍可查看与导出。下一批工作是 P1（V1.2）。

启动入口是 `npm run workbench`，默认监听 `127.0.0.1:4317`。分析逻辑必须继续复用 REA 的 `analyzeJavaScriptApplication` 和 Evidence 语义，不得在 Workbench 中复制一份分析器。

## 任务总览

| 优先级 | 任务                                   | 依赖          | 目标版本 | 状态                 |
| ------ | -------------------------------------- | ------------- | -------- | -------------------- |
| P0.5   | API 契约、幂等和断线重连验收           | 当前 P0       | V1.1     | 已完成（2026-10-13） |
| P0.5   | ASAR 源码快照与安全文件树              | 当前 P0       | V1.1     | 已完成（2026-10-13） |
| P0.5   | Evidence Bundle 和资源生命周期         | 当前 P0       | V1.1     | 已完成（2026-10-13） |
| P1     | 图浏览、邻居展开和运行差异             | P0.5 API 稳定 | V1.2     | 已完成（2026-10-13） |
| P1     | 正式前端组件化                         | API 契约稳定  | V1.2     | 未开始               |
| P1     | 运行恢复、重试和崩溃恢复               | Bundle、幂等  | V1.2     | 已完成（2026-10-13） |
| P2     | 运行时观察、Ghidra 和 Agent 调查时间线 | P1 基础稳定   | V2.0     | 未开始               |
| P2     | 安装包、后台服务和部署体验             | V1.2 功能稳定 | V2.0     | 未开始               |

## 任务 A：API 契约、幂等和断线重连验收（P0.5）— 已完成

### 完成内容（2026-10-13）

1. `src/workbench/api.ts` 定义请求 Schema（项目、目标、运行、比较）与响应类型（文件、源码、图、比较、错误封套）；非法请求返回 400 `invalid_request` 并附 `details` 字段路径。
2. `POST /api/runs` 支持 `Idempotency-Key` 请求头；幂等绑定持久化在 SQLite `run_idempotency` 表，浏览器 UI 创建运行时自动生成 UUID 幂等键。
3. 统一错误结构：`src/workbench/api.ts` 的 `WorkbenchApiError` 携带错误码、HTTP 状态与详情；全部错误响应使用同一封套。
4. SSE 竞态修复：`streamRunEvents` 先订阅实时事件再回放历史，重叠事件按运行内序号去重；连接发送 `retry: 3000`。
5. 契约测试 `tests/boundary/workbench/workbenchApiContract.test.ts` 覆盖鉴权、非法请求不写部分实体、幂等重放与 409 冲突、真实分析运行的成功/失败/取消三条路径、Evidence 与导出契约；`tests/boundary/workbench/workbenchSseReconnect.test.ts` 覆盖历史回放、实时合并且不丢不重、`Last-Event-ID` 与 `after` 断点续传。

### 验收标准核验

- 非法请求不会写入部分实体：契约测试断言非法项目请求后项目列表为空。
- 同一个幂等键重复提交不会创建两个运行：契约测试断言两次提交返回同一运行且运行列表只有一条。
- SSE 断开、重连、带 `Last-Event-ID` 后，事件连续且不重复：SSE 验收测试覆盖。
- 运行完成、失败、取消三条路径都有契约测试：真实 REA 服务执行验证。
- `npm run typecheck`、`npm run check:fast`、相关测试全部通过：见交接报告。

## 任务 A：API 契约、幂等和断线重连验收（P0.5）

### 工作内容

1. 为项目、目标、运行、事件、Evidence、图和比较接口增加明确的请求/响应 Schema。
2. 为创建运行增加客户端幂等键，例如 `Idempotency-Key`，重复请求返回同一个运行。
3. 统一错误码、HTTP 状态码和错误详情结构。
4. 修正 SSE 订阅的竞态：历史事件回放与实时监听之间不能丢事件；按运行内序号去重。
5. 增加 API 契约测试和浏览器断线重连验收测试。

### 验收标准

- 非法请求不会写入部分实体。
- 同一个幂等键重复提交不会创建两个运行。
- SSE 断开、重连、带 `Last-Event-ID` 后，事件连续且不重复。
- 运行完成、失败、取消三条路径都有契约测试。
- `npm run typecheck`、`npm run check:fast`、相关测试全部通过。

## 任务 B：ASAR 源码快照与安全文件树（P0.5）— 已完成

### 完成内容（2026-10-13）

1. `src/workbench/sourceSnapshot.ts`：运行启动时经 REA 的 `AsarArtifactReader` 复制档案进私有快照（复用既有读取能力，未复制分析逻辑），固定身份 `{format:"asar", sha256, bytes}` 写入 `runs.source_snapshot_json` 并发 `artifact.available` 事件；`AsarArtifactReader` 新增只读 `snapshotIdentity` 访问器。
2. `/api/runs/:id/files` 支持 ASAR 文件树（按 `prefix` 展开直接子项，返回 `size`/`symlink` 标注）；目录目标保持实时只读列举。
3. `/api/runs/:id/source` 支持 ASAR 快照内的文本读取（js/ts/json/html/css/md/xml/yaml 等扩展名白名单），响应携带 `origin: "run-snapshot" | "target-file"` 与 `snapshot_sha256`；目录目标读取标记 `target-file`。
4. 限制：单文件 1 MB、每运行累计 32 MB（`createWorkbenchServer({ maxRunSourceBytes })` 可调）；触达上限返回 `413 source_too_large` 并在事件流记录一次 `source-read-limit` 诊断；`..`、绝对路径、`.`、空段一律 `400 invalid_path`；symlink 成员永不跟随；非文本扩展名 `400 source_not_text`。
5. UI 源码页明确区分“运行快照（sha256 前 12 位）”与“原始目标文件（随目标变化）”。
6. 测试 `tests/boundary/workbench/workbenchAsarSource.test.ts`：真实 `@electron/asar` 档案 + 完整 REA 分析，覆盖快照身份固定（覆盖目标后读取不变）、文件树与前缀展开、穿越/绝对路径/非文本/超大拒绝、读取预算与一次性诊断、目录目标 `target-file` 标注。

### 验收标准核验

- ASAR 目标可以浏览文件树和读取授权快照中的文本文件：边界测试覆盖。
- 读取内容对应运行时固定快照，不受目标文件后续变化影响：测试在运行完成后覆盖原档案并断言内容不变。
- 任意 `..`、绝对路径和越界符号链接请求均被拒绝：`..` 与绝对路径返回 `400 invalid_path`；ASAR symlink 成员读取被拒（`400 source_not_file`），目录目标的越界 symlink 由既有 `resolveAuthorizedPath` realpath 检查拒绝。
- 读取限制和限制原因会进入诊断或 Evidence limitation：`413` 时向运行事件流写入一次 `source-read-limit` 诊断。

## 任务 C：Evidence Bundle 和资源生命周期（P0.5）— 已完成

### 完成内容（2026-10-13）

1. `src/workbench/bundleStore.ts`：运行级 Bundle 目录 `<库目录>/bundles/<run-id>/`；提交协议为临时目录写入 → 回读校验 → 写入 `bundle.json` 清单与 `COMPLETE` 完成标记 → 原子 `rename` 发布；中断进程不可能留下"看起来成功但内容不完整"的 Bundle。
2. 清单绑定 Evidence ID、payload sha256、目标摘要（`root_artifact_sha256`）与工作流 ID/版本，四者可互相追溯；每次读取都重算摘要，篡改返回 `500 bundle_integrity_failed` 而非伪造证据。
3. 数据库只保存清单（`runs.bundle_json`）；`evidence_json` 仅作为 Bundle 提交失败时的降级通道，降级发生时记录一次 `evidence-bundle` 诊断且不覆盖分析结果（运行仍为 succeeded、error 为 null）。
4. 启动时（`listenWorkbenchServer`）扫描：`.tmp-*` 孤儿临时目录删除；无完成标记的目录隔离为 `.incomplete-*`；删除失败保留现场并追加 `bundle-diagnostics.log`，启动摘要打印到终端。
5. `/evidence`、`/export`、`/graph`、`/api/comparisons` 全部改为 Bundle 优先、内联降级，对外契约不变；重启服务后已完成运行仍可查看与导出。
6. 测试 `tests/boundary/workbench/workbenchEvidenceBundle.test.ts`：真实分析后核对磁盘 Bundle/清单/摘要/数据库分离；同库同 Bundle 目录重启后 evidence/export/graph/comparisons 可用；孤儿临时目录与无标记目录的启动回收；篡改 payload 的完整性报错；只读 Bundle 根下提交失败降级且诊断落事件流。

### 验收标准核验

- 进程中断不会产生"看起来成功但内容不完整"的 Bundle：发布仅经原子 rename，无标记目录启动时被隔离（测试覆盖）。
- Evidence ID、Bundle digest、目标摘要和工作流版本可互相追溯：清单字段逐一断言（测试覆盖）。
- 清理失败不会覆盖原始分析错误：失败运行路径既有测试 + 提交失败降级路径测试（error 保持 null、诊断入事件流）。
- 重启服务后已完成运行仍可查看和导出：同库同 Bundle 目录重启测试（覆盖）。

## 任务 D：图浏览和运行差异（P1）— 已完成

### 完成内容（2026-10-13）

1. `src/workbench/graphView.ts`：经 REA 应用层的 `parseApplicationGraphEvidence` 载入经认证的应用图（类型化节点/边），图差异完全复用 `compareApplicationVersionsEvidence` 工作流——匹配分层、unknown 处理、覆盖合并语义全部归 REA 所有，工作台只做分页与投影。
2. 新增只读接口（全部游标分页，默认 100、上限 500）：`GET /api/runs/:id/graph/nodes`（`kind` 筛选 + `search` 子串搜索）、`/graph/edges`（`relation` 筛选）、`/graph/neighbors`（`node_id` + `direction=in|out|both` + 截断标志）、`/graph/nodes/:nodeId`（完整节点 + 入/出度）、`/graph/diff?against=<runId>`（`change=added|removed|changed|all`、`kind=node|edge|all`）。
3. 节点与变更条目携带类型、标签、观察数、来源位置（observation evidence location）与 Evidence 引用（observation 级为空时回退引用运行图证据）；`POST /api/comparisons` 接受可选 `include_graph_diff`，响应在 `result.graph_diff` 附摘要与覆盖。
4. 覆盖守卫：任一侧缺少可用的应用图证据时 diff 返回 `status:"unavailable"`、空 changes 与限制说明，不把缺失当作删除；两次运行持有同一份内容摘要 Evidence（相同目标内容）时同样返回 unavailable 并说明无版本差异。
5. 浏览器 UI：图页支持搜索、类型筛选、分页加载（“加载更多”），节点点击显示入/出度与源码位置并可展开邻居；新增“差异”页（“只看变化”列表：新增/删除/修改计数 + 按运行与源码位置回溯），原“比较”按钮切换到该页。
6. 测试 `tests/boundary/workbench/workbenchGraphDiff.test.ts`（7 个）：同目标两运行判定为同版本、跨目标增删条目回溯到运行/Evidence/源码位置、失败运行覆盖守卫、limit=1 游标翻页完整性、搜索与边筛选、邻居展开与节点详情、`include_graph_diff` 契约。

### 验收标准核验

- 大图不会一次性加载到浏览器：节点/边/变更全部游标分页（测试以 limit=1 翻页验证完整性），UI 每页 100 条。
- 节点和边的变化可以回溯到运行、Evidence 和源码位置：变更条目断言 `right_run_id`、`evidence_links`、`locations` 含 `extra.js` 路径。
- 对不完整结果不把缺失当作删除：覆盖守卫测试断言 unavailable + 空 changes + 限制说明。

## 任务 E：正式前端组件化（P1）

技术路线已确定：先采用轻量 TypeScript 模板组件与类型化状态模块，复用现有构建链，不新增 React/Vite；其他验收要求不变。

### 工作内容

1. 将当前内嵌 HTML UI 拆为正式前端工程或仓库允许的前端包。
2. 保留项目、目标、运行、时间线、图、源码、Evidence、比较等页面信息架构。
3. 把状态来源固定为服务端 API 和 RunEvent，不从日志推断状态。
4. 增加加载、空状态、错误、取消中、部分结果和清理失败状态。
5. 增加键盘操作、窄屏布局和长文本可读性。

### 验收标准

- 页面刷新后可以恢复当前运行和事件游标。
- API 错误、部分结果和限制信息可以被用户理解。
- UI 测试覆盖创建项目、登记目标、运行、取消、Evidence 和重连。

## 任务 F：运行恢复、重试和崩溃恢复（P1）— 已完成

### 完成内容与验收核验（2026-10-13）

- `recovery.ts` 在启动时将丢失的队列/Worker 状态原子投影为 `interrupted`，保留历史与 Bundle，完整性和清理保持 `unknown`。恢复是幂等的。
- `/api/runs/:id/retry` 创建新运行，通过 `retry_of_run_id` 关联旧运行，重新解析目标，支持幂等重放和工作流重试守卫。
- 整次分析超时与用户取消、进程中断拥有不同原因码；`/api/diagnostics` 显示队列、活动 Worker、时限、路径和启动恢复摘要。
- `tests/boundary/workbench/workbenchRunRecovery.test.ts` 使用真实 loopback/API/REA：覆盖全部五种遗留状态、同库重启、重试守卫与幂等、目标修复后重试、旧 Bundle 逐字节不变、超时、排队/活动用户取消；真实子进程在 `running` 时被 SIGKILL，同库重启并成功重试。此测试不模拟 Provider。
- 同步 JavaScript 不可硬抢占，取消会等待拥有者结算与清理；已明确记录在开发文档，未宣称强制硬时限。

### 工作内容

1. 启动时把上次遗留的 `starting/running/finalizing/cancelling` 运行标记为 `interrupted`，并记录原因。
2. 按工作流能力声明实现安全重试，禁止重复写入同一 Evidence Bundle。
3. 为运行增加资源预算、超时和取消原因。
4. 对队列和 Worker 状态增加诊断接口。

### 验收标准

- 服务异常退出后数据库状态可解释、可恢复。
- 重试会创建新的运行尝试或明确的 attempt ID，不覆盖历史事件。
- 超时、用户取消、进程中断在 UI 和 Evidence 中可区分。

## 任务 G：运行时、Ghidra 和 Agent 调查（P2）

这些能力必须在 P1 API、Evidence 和事件模型稳定后接入：

- 运行时观察和进程生命周期事件。
- Ghidra 等外部工具的 Provider 能力和授权检查。
- Agent 调查时间线、工具调用、证据引用和人工确认点。
- 不同分析方法之间的 Evidence 关联和覆盖差异。

接入时仍须遵守 REA 的 Provider 能力边界、Evidence 语义和未知状态约束。

## 任务 H：安装和部署体验（P2）

- 提供 macOS、Linux、Windows 的启动脚本或打包方式。
- 支持选择数据库和 Bundle 根目录。
- 提供端口占用、权限、Node 版本和依赖诊断。
- 明确本地凭据、访问范围和关闭服务方式。
- 增加从安装到首次分析的验收脚本。

## 接力开发规则

每位接力执行者必须：

1. 先阅读本文件、设计文档、开发文档、`AGENTS.md` 和相关技能说明。
2. 开始前检查 `git status`，不要覆盖已有未提交工作。
3. 一次只推进一个可验收任务，除非依赖要求顺带修改接口。
4. 复用现有 REA 分析服务和 Evidence，不复制分析逻辑。
5. 更新设计文档、开发文档、API 示例和任务状态。
6. 运行与改动匹配的类型检查、Lint、单元测试、边界测试和手工验收。
7. 在交接记录中写清：已完成、验证命令、遗留问题、下一步建议。

## 可直接交给下一位 AI 的 Goal Prompt

```text
你是 REA Workbench 的持续开发代理。请在当前工作区继续完成 REA Workbench 后续开发，当前 A、B、C、D、F 已完成，下一目标是完成 V1.2 的任务 E（轻量 TypeScript 前端组件化、状态恢复和真实浏览器验收），不要停留在方案讨论，也不要只输出计划。

工作区：/Volumes/M2E/Project/REAWeb

必须先阅读：
- docs/rea-workbench-follow-up-tasks.md
- docs/rea-workbench-design.md
- docs/rea-workbench-development.md
- AGENTS.md
- docs/tool-design.md
- docs/testing.md
- 与当前任务相关的 .agents/skills/README 或 SKILL.md

当前基线：
- src/workbench/main.ts：启动入口
- src/workbench/server.ts：loopback HTTP API、SSE 和当前浏览器 UI
- src/workbench/store.ts：SQLite 元数据和 RunEvent
- src/workbench/runManager.ts：单 Worker、取消、REA 分析适配和 Evidence 保存
- src/workbench/types.ts：运行、事件、步骤和工作流类型
- src/server/workbenchStore.test.ts：现有存储测试

执行要求：
1. 先检查 git status、Node 版本、依赖和当前测试状态。
2. 选择本文件中优先级最高且依赖满足的未完成任务；本轮从任务 E 开始。路线已确定为轻量 TypeScript 模板组件与类型化状态模块，复用现有构建链，不新增 React/Vite。完成页面刷新恢复、SSE 游标恢复、加载/空/错误/部分结果/清理失败状态、键盘与窄屏支持，以及真实浏览器验收。
3. 直接修改代码、测试和文档，直到该任务达到验收标准。
4. 不复制 REA 的分析逻辑；继续调用现有分析服务，保持 Evidence、provenance、unknown、partial 和 limitation 语义。
5. 不把日志正则表达式当作运行状态；服务端结构化事件是状态来源。
6. 不执行被分析目标代码；Workbench 默认只监听 loopback，并保持目标路径授权和读取限制。
7. 不删除或覆盖已有用户改动；发现冲突时保留已有实现并在交接记录中说明。
8. 为新增行为编写有意义的测试，优先使用真实边界和真实 REA 服务验证，避免只测试模拟实现。
9. 至少运行 npm run typecheck、npm run check:fast、相关 npm run test:local 测试和 git diff --check；文档改动时运行 npm run docs:check。
10. 完成后更新 docs/rea-workbench-follow-up-tasks.md，把已完成项标记出来，并更新 docs/rea-workbench-development.md 的启动、测试和限制说明。
11. 最后输出一份交接报告：改动文件、行为变化、验证命令和结果、尚未完成任务、下一位代理的第一步。

持续执行规则：
- 只要仍有明确可执行的后续任务，就继续推进，不因一个测试失败而停在解释阶段；定位并修复失败后重新验证。
- 只有遇到确实需要用户决定的产品取舍、外部凭据或不可逆操作时才暂停，并说明具体阻塞原因。
- 不要创建与当前目标无关的重构，不要引入新的前端框架或外部服务，除非当前任务的验收标准明确要求。
- P2 的执行、注入、修改目标或新 Provider 能力必须先满足 AGENTS.md 的维护者范围决策要求；当前授权不等于这些能力已获集成批准。
```
