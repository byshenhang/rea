# REA Workbench 产品与技术设计（V1.0 实施版）

## 目标

REA Workbench 是一个本地部署、浏览器访问的分析工作台和流程调试台。它复用 REA 的 JavaScript/Electron 静态分析应用层，回答四个问题：运行到哪里、步骤为什么执行、结果依据什么、流程或源码变化后发生了什么。

首期范围固定为本地 JavaScript 应用目录和 ASAR 的静态分析。工作台不执行目标 JavaScript，不启动被分析应用，不把日志正则表达式当作状态，也不宣称静态结果能够证明目标不存在某项行为。

## 产品边界

首期闭环包括：项目和目标登记、流程版本登记、创建运行、单 Worker 执行、结构化阶段事件、SSE 实时更新、刷新后恢复、取消、历史运行、Evidence 查看、关系图分页浏览与邻居展开、跨运行图差异、目录源码查看、ASAR 运行快照文件树与文本读取、诊断和导出基础数据。Ghidra、运行时观察、Agent 调查时间线和图形化流程编辑保留为后续阶段。

执行流程与目标关系图始终分开。执行流程描述 REA 如何工作；关系图描述目标程序中的节点与边。每个运行固定目标路径解析后的身份、流程版本、参数、Evidence ID、结果完整性和清理结论。

## 架构

```text
浏览器工作台
  ├─ HTTP 查询与控制
  └─ SSE 运行事件订阅
            ↓
本地 Workbench API（loopback + 启动凭据）
  ├─ 项目、目标、流程目录
  ├─ SQLite 元数据与 RunEvent
  ├─ 目标授权和受限源码读取
  └─ Graph / Evidence 查询
            ↓
WorkbenchRunManager（单 Worker 队列）
  ├─ AbortController 取消
  ├─ 状态投影和步骤快照
  └─ ArtifactResourceScope 清理
            ↓
REA JavaScriptApplicationService
  ├─ 目标清单和快照
  ├─ JavaScript/Electron 应用图
  ├─ 语义关系图
  └─ Evidence 生成
```

`src/workbench` 只位于应用边界，不向 REA domain 层引入 HTTP、SSE 或 SQLite 类型。分析逻辑仍由 `analyzeJavaScriptApplication` 负责，工作台只负责执行控制、事件投影和持久化。

## 状态和事件

运行状态：`queued → starting → running → finalizing → succeeded`，异常路径为 `failed`、`cancelling → cancelled` 或 `interrupted`。结果完整性独立记录 `complete / partial / none / unknown`；资源清理独立记录 `complete / failed / unknown / not-required`。

RunEvent 由服务端分配运行内递增序号，先写 SQLite 再推送 SSE。浏览器保存最后序号，重连时补发缺失事件并按序号去重。高频进度经过 `ProgressReporter` 限频，步骤边界、Evidence 和清理事件不丢弃。

首期工作流版本为 `rea.javascript-electron-static@1.0.0`，步骤定义为：目标检查、建立目标快照、读取源码、源码解析、构建关系图、结果验证、保存 Evidence、释放资源。动态文件实例以进度消息聚合，不把数千个文件渲染成流程节点。

## 数据持久化

默认数据库为 `~/.rea-workbench/workbench.sqlite`，可通过 `REA_WORKBENCH_DATABASE` 指定。SQLite 表包括：

- `projects`、`targets`：用户项目和明确授权的本地目标。
- `workflows`：不可变流程定义和版本。
- `runs`：参数、状态、完整性、清理、Evidence ID、错误摘要、源码快照身份和 Bundle 清单。
- `run_events`：顺序事件日志，主键为 `(run_id, sequence)`。
- `run_idempotency`：创建运行的幂等键绑定，随运行级联删除。

运行成功后 Evidence 以文件系统 Bundle 持久化在 `<库目录>/bundles/<run-id>/`：临时目录写入、回读校验、`bundle.json` 清单与 `COMPLETE` 标记齐备后经原子 `rename` 发布，因此进程中断不会留下看似完整的 Bundle。清单绑定 Evidence ID、payload sha256、目标摘要（`root_artifact_sha256`）与工作流版本；数据库只保存清单，读取时重算摘要校验完整性。启动时清理孤儿临时目录并隔离无标记目录，清理失败保留现场并写入 `bundle-diagnostics.log`。

目标路径按真实路径登记；ASAR 目标在运行启动时复制进私有快照并固定 `{format, sha256, bytes}` 身份（`runs.source_snapshot_json`），文件树和文本读取只来自该快照；目录目标保持授权根目录内实时只读。单文件读取上限 1 MB，每运行累计文本读取上限 32 MB；symlink 成员永不跟随，路径穿越和绝对路径一律拒绝。

## API 基线

所有 API 默认只监听 `127.0.0.1`，写操作和查询需要 `X-REA-Workbench-Token` 或 Bearer 凭据。

| 方法     | 路径                            | 用途                                 |
| -------- | ------------------------------- | ------------------------------------ |
| GET      | `/api/workflows`                | 流程目录和版本                       |
| GET      | `/api/providers`                | Provider 可用性                      |
| GET/POST | `/api/projects`                 | 项目列表、创建项目                   |
| GET/POST | `/api/projects/:id/targets`     | 目标列表、登记目标                   |
| GET/POST | `/api/runs`                     | 运行列表、创建运行                   |
| GET      | `/api/runs/:id`                 | 运行摘要                             |
| GET      | `/api/runs/:id/events`          | SSE 事件；`format=json` 返回历史事件 |
| GET      | `/api/runs/:id/steps`           | 步骤状态投影                         |
| POST     | `/api/runs/:id/cancel`          | 请求取消                             |
| POST     | `/api/runs/:id/retry`           | 新运行重试，支持幂等键               |
| GET      | `/api/diagnostics`              | 队列、Worker、启动恢复和数据路径     |
| GET      | `/api/runs/:id/graph`           | 有界关系图子集                       |
| GET      | `/api/runs/:id/evidence`        | 完整 Evidence                        |
| GET      | `/api/runs/:id/export`          | 下载带 Evidence 身份的 JSON          |
| GET      | `/api/runs/:id/files`           | 授权根目录下的文件列表               |
| GET      | `/api/runs/:id/source?path=...` | 只读源码内容                         |
| POST     | `/api/comparisons`              | 比较两个运行的配置、执行和图统计     |

接口只接受服务端对象 ID，源码读取不接受任意绝对路径。图查询默认最多返回 300 个节点，边只保留两端都在返回节点中的关系；分页和按邻居展开属于下一阶段。

错误响应统一为 `{"error":{"code","message","details?"}}`，错误码与 HTTP 状态码目录定义在 `src/workbench/api.ts`。请求体经 zod Schema 校验，非法请求不产生部分实体。`POST /api/runs` 支持 `Idempotency-Key` 请求头：同键同内容重放同一运行，同键不同内容返回 409。事件订阅先回放历史再合并实时事件，按运行内序号去重；客户端以 `Last-Event-ID` 或 `after` 续传。

图浏览与差异以 REA 的应用图证据为唯一来源：节点/边身份是内容摘要；分页接口（节点/边/邻居/节点详情）默认每页 100、上限 500；跨运行差异复用 REA 的 `compare_application_versions` 工作流，按匹配分层给出 unchanged/added/removed/changed/unknown 摘要与逐条回溯（运行、Evidence 链接、源码位置）。任一侧图证据缺失或两侧证据相同（同一目标内容）时差异返回 `unavailable` 并说明原因，不把缺失或同版本当作增删。

## 安全和隐私

服务默认 loopback，不绑定 `0.0.0.0`；校验 Origin；启动时生成随机访问凭据；不默认上传目标、不启用遥测、不执行目标代码。目标路径必须由用户登记，符号链接解析后仍需位于授权根目录；源码和 Evidence 以文本方式展示，不渲染目标 HTML。

Worker 进程隔离和本地访问凭据不能等同于完整安全沙箱。第三方 Provider 的许可和外部工具授权仍由部署者负责。

## 验收标准

一次成功、一次失败、一次取消运行都能在事件时间线中看到阶段边界和最终状态；刷新浏览器不丢失已持久化事件；SSE 断开后按游标补发且不重复；Evidence 的 Provider、参数、限制和目标摘要可查看；清理失败不会覆盖原始分析错误；目标代码从未被工作台执行。ASAR 目标可浏览运行快照文件树并读取授权文本文件，读取内容在目标档案被覆盖后仍保持运行时身份；`..`、绝对路径、越界符号链接请求均被拒绝，读取限制与原因进入运行事件诊断。
