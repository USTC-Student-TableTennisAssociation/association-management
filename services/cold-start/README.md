# Cold-start Worker

Cold-start Worker 将来源文档编译为可发布到 Sydaris Shared Brain 的 Object–Assertion–Evidence 结构，并提供线上检索共用的 BGE-M3 embedding 服务。

## 输出边界

```text
source document
  → parser artifacts
  → stable Source Blocks
  → continuous Source Regions
  → Object Fragments + Assertions + Evidence
  → Global Object Resolution
  → Global Assertions
  → Shared Brain publication
```

Worker 只编译认知：

- Object 提供稳定身份；
- Assertion 保留事实性叙述和时间语境；
- Evidence 连接回原始 Source Block；
- Global Resolution 负责把各 Source Region 中的 Object Fragment 归并为稳定 Object。

Worker 不直接写入 View Card Graph。业务状态需要通过目标 View 声明的 Domain Command 建立或更新。

## 环境

要求：

- Python 3.11 或 3.12
- [uv](https://docs.astral.sh/uv/)
- MinerU 运行所需的 CPU / GPU 和模型权重
- BGE-M3 模型（Global Resolution 与 embedding server 使用）

安装：

```bash
cd services/cold-start
uv sync --python 3.11
```

验证：

```bash
uv run ruff check .
uv run pytest
uv run cold-start --help
```

CLI 会从当前目录向上查找 `.env`，也可通过 `--env-file` 显式指定。

## 主要命令

```text
explore              单文档全局勘探与连续区域树
parse-document       只执行来源解析并写入可复用缓存
compile-source       编译单个 Source Region
compile-sources      并行编译全部 Source Region
resolve-objects      归并 Global Object
finalize-assertions  物化只引用 Global Object 的 Assertion
serve-embeddings     启动 BGE-M3 HTTP 服务
```

## 1. 解析文档

对资料库中没有扩展名的内容寻址文件：

```bash
uv run cold-start parse-document \
  --source "/absolute/path/to/content-object" \
  --source-suffix pdf \
  --output "/absolute/path/to/parser-output"
```

`--source-suffix` 支持 `pdf`、`docx`、`pptx` 和 `xlsx`。

对单份文档生成勘探运行目录：

```bash
uv run cold-start explore \
  --source "/absolute/path/to/manual.pdf" \
  --output "/absolute/path/to/runs"
```

勘探产物包括稳定原文块、文档背景、连续 Source Region Tree 和可视化报告。区域树只表达编译顺序和上下文边界，不是知识分类。

`explore` 只有在区域树达到 `frozen` 时才成功退出。处理中会把文档上下文、已完成节点和待调度组写入
`region-tree-working.json`；网络或模型故障后使用 `--resume <exploration-run>` 会保留成功节点，
只重新判断 `pending/failed` 区域。`needs_review` 最终产物不能进入 Source Semantics，也不会仅因
`global-exploration.json` 已存在而被误判为完成。

## 2. 编译 Source Semantics

编译全部内容来源：

```bash
uv run cold-start compile-sources \
  --run "/absolute/path/to/exploration-run"
```

调试单个来源：

```bash
uv run cold-start compile-source \
  --run "/absolute/path/to/exploration-run" \
  --source-id region-0063
```

并行编译期间会按来源和阶段写入 checkpoint。继续已有任务：

```bash
uv run cold-start compile-sources \
  --run "/absolute/path/to/exploration-run" \
  --resume "/absolute/path/to/source-semantics-run"
```

`--resolve-progressively` 可在稳定顺序中的首个来源完成后开始 Global Object Resolution：

```bash
uv run cold-start compile-sources \
  --run "/absolute/path/to/exploration-run" \
  --resolve-progressively
```

每个 Assertion 使用 `{{fragment:<fragment-id>}}` 引用局部 Object Fragment。Evidence 使用原文块边界，不允许模型把无法定位的概括当作原文依据。

### 阶段契约

每个模型阶段只拥有一种判断权；下游可以消费上游结果，但不重新完成上游的工作：

| 阶段 | 唯一职责 | 主要产物 | 不在本阶段决定 |
| --- | --- | --- | --- |
| Parser | 保留来源结构并建立可确定的证据关系 | Source Blocks、marker → footnote 附加证据 | 文档语义与 Object |
| Document Context | 给出短而稳定的文档身份背景 | document context | 事实、区域和知识结构 |
| Region Tree | 划分可独立编译的连续上下文边界 | Source Regions | 事实、Object、内容价值 |
| Source Time | 提取来源自身明确写出的时间锚点 | source time + evidence | Assertion 有效期 |
| Assertion Discovery | 冻结原文明示的内聚知识单元和直接证据 | grounded / reference Assertions | 名称同指与 Object 身份 |
| Coverage Review | 只补第一次抽取遗漏的 Assertion | Assertion 增量 | 改写或重评已有 Assertion |
| Fragment Construction | 提取局部 referent、局部别名组并把 Assertion 改写为模板 | Object Fragments + templates | 跨 Region 身份与最终 Objecthood |
| Global Resolver | 在全局证据下裁决 Objecthood、词义和身份 | Global Object Registry | 改写 Assertion 内容 |
| Finalizer | 在已有候选间分流歧义字面引用并确定性物化模板 | Global Assertions | 创建、合并或拆分 Object |

Parser 不改变物理 block 顺序；语义编译时，被 marker 引用的脚注跟随引用它的 block，而不是跟随
物理位置相邻的标题。Fragment Construction 采用召回优先策略：当前语义支持独立 referent 时就
提交候选，边界不确定时交给 Resolver。`identity_mode_hint` 只告诉 Resolver 使用哪类证据标准：
具体人物用 `named_person`，角色类型用 `role_type`，可复用类别用 `entity_type`，其他具名实例或
稳定对象用 `named_entity`。

Global Resolver 采用精度优先策略，执行 `create/attach/reject/defer`，仅在多个 Fragment 或已有
Object 必须共同调整时执行联合 `merge/split`。Finalizer 不承担上游 Object 的补救工作。

阶段产物同时记录 `schema_version` 与 `policy_version`。前者描述数据结构，后者描述模型判断策略；
策略改变后，对应 checkpoint 和所有下游产物自动失效，未变化的上游阶段仍可复用。

## 3. Global Object Resolution

```bash
uv run cold-start resolve-objects \
  --compilation "/absolute/path/to/source-semantics-full"
```

Global Resolver 按 Source Region 更新 Registry，并在每个 Region 内并行裁决 Object Fragment。
普通 `create/attach/reject/defer` 只向模型提供当前 Fragment、相关 Assertion 和紧凑候选摘要；
Runtime 根据 `fragment_key` 确定性展开全部 Atom。只有同区 Fragment 共指、一个 Fragment 内词义
拆分或已有 Object 需要 `merge/split` 时，才把相关 Fragment 组成小组执行完整联合计划。
这样保留 Region 级一致性，同时避免把候选的完整 Atom 历史重复发送给每次普通判断。候选使用
词面和 BGE-M3 召回；不使用 BGE-M3 时可显式传入 `--no-bge`。

字面相同只用于候选召回，不直接证明两个 Fragment 属于同一身份。Resolver 可以把不形成
独立 referent 的候选标记为 `reject`，或在证据不足时标记为 `defer`；两种处置都保留原始
Assertion，只是不创建或强挂 Global Object。Registry 完成后，系统只对“同一词面拥有多个
Global Object”的 literal mention 运行按词面批量的 Sense Resolver；唯一词面仍走本地快速
路径。分流结果保存在 `literal-sense-routing.json`，并绑定 Source SHA-256 与 Registry 指纹，
续跑时可安全复用；Source Semantic 策略、Global Resolver 策略或 Object Registry 变化后会自动失效。

继续已有 Global Resolution：

```bash
uv run cold-start resolve-objects \
  --compilation "/absolute/path/to/source-semantics-full" \
  --resume "/absolute/path/to/global-resolution-run"
```

物化 Global Assertions：

```bash
uv run cold-start finalize-assertions \
  --resolution "/absolute/path/to/global-resolution-run"
```

最终 Assertion 使用 Global Object ID 作为模板引用，因此 Object 规范名称的更正不需要改写所有 Assertion 正文。

## 4. 发布到 Shared Brain

正式入口是 Sydaris Library。Runtime 会为来源创建处理记录、调用本 Worker 完成
Source Semantics 与 Global Object Resolution，再由 Shared Brain publisher 原子发布结果。

Worker 不提供另一条直接写数据库的 importer，也不把认知结果投影成任何具体 Business View。
View 需要的业务状态只能通过该 View 声明的正式 Command 建立或更新。

## 5. BGE-M3 服务

在仓库根目录启动：

```bash
pnpm memory:serve-embeddings
```

或在服务目录直接启动：

```bash
uv run cold-start serve-embeddings \
  --host 127.0.0.1 \
  --port 8765
```

健康检查：

```bash
curl http://127.0.0.1:8765/health
```

数据库中的 Assertion embedding index 和线上查询必须使用相同的模型名、revision 和向量维度。
Shared Brain 发布后会自动排队建立完整 Assertion 索引；embedding 服务临时不可用不会撤销已经发布的事实，持久化任务会在服务恢复或 Sydaris 重启后继续重试。`pnpm memory:index-assertions` 仍可用于对当前数据库立即执行一次全量补建。

## 环境参数

主要参数位于仓库根目录 `.env`：

```text
AI_API_KEY
AI_API_BASE_URL
AI_MODEL
AI_THINKING_MODE
AI_STRUCTURED_OUTPUT_MODE
COLD_START_MINERU_PROVIDER
MINERU_MODEL
MINERU_API_KEY
MINERU_API_BASE_URL
MINERU_API_FILE_PARSE_URL
MINERU_API_TIMEOUT_SECONDS
MINERU_API_REQUESTS_PER_MINUTE
MINERU_API_MAX_IN_FLIGHT
COLD_START_MINERU_BACKEND
COLD_START_MINERU_EFFORT
COLD_START_MINERU_METHOD
COLD_START_MINERU_IMAGE_ANALYSIS
COLD_START_EMBEDDING_MODEL
COLD_START_EMBEDDING_MODEL_REVISION
COLD_START_EMBEDDING_DEVICE
COLD_START_MAX_PARALLEL_COMPILATIONS
COLD_START_MAX_PARALLEL_REGIONS
COLD_START_MODEL_MAX_IN_FLIGHT
```

### MinerU Provider

`COLD_START_MINERU_PROVIDER` 支持：

- `auto`：存在 `MINERU_API_BASE_URL` 时使用 API，否则使用本地 CLI；
- `api`：必须使用 multipart `/mineru/file_parse`；
- `local`：必须使用当前 Python 环境中的 `mineru` 命令。

API Provider 会请求 Markdown、`content_list` 和图片，将响应重新落成标准 MinerU 原始产物目录，
再复用本地 Provider 相同的 `ParsedDocument` 适配代码。API Key 不会写入日志；解析缓存同时绑定
文件 SHA-256 与 Provider 配置，因此切换 Provider 或 API 端点后不会错误复用旧结果。学校 API
使用服务端默认解析引擎；`COLD_START_MINERU_BACKEND`、`EFFORT`、`METHOD` 和
`IMAGE_ANALYSIS` 只作用于本地 CLI，不会作为 multipart 字段发送给学校接口。
网页 Library worker 会在启动解析子进程前统一执行 MinerU API 的 RPM 和在途请求限速；
HTTP 429 会保留为可恢复故障，等待限速时隙后从当前文件继续，而不会伪装成“解析器无内容”。

以 `.env.example` 为实际配置入口。命令行参数优先于环境参数。
