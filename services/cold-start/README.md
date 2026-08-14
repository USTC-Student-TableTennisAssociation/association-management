# 冷启动 Worker

冷启动 Worker 目前负责把单份协会手册 PDF 解析为稳定原文块和连续原文区域树，并在此
基础上编译“ObjectFragment—Assertion—SourceBlock”叶子来源 IR。

旧的固定卡片数据库和 `full-basic-compilation.v5` 数据库协议已经移除，不保留兼容入口。
基础来源编译现在输出 `source-semantics-full.v9`。Atomic naming hints 会在第三阶段被吸收进
Object Fragment，不再生成长期 `SameReferentEvidence`。v9 产物可以导入来源记忆数据库，
再由增量 Global Resolver 解析为后续 Search 应消费的 Global Object Registry。Assertion 的
依据始终连接回稳定原文块。

## 整体方向

```text
单份 PDF
  → MinerU 解析
  → 带页码的稳定原文块
  ├→ 顺序阅读，形成简短文档背景
  └→ 递归切分，形成连续原文区域树
       → 编译全部 content_source 来源节点
            → Atomic 同时提取事实命题与来源明示同指称草稿
            → 只对事实命题做遗漏复核
            → Object Fragment Construction 同时完成局部名称分组与命题模板生成
       → 整份 Source 一次保守提取 Source Time 及其证据块
       → Global Resolver 将 Fragment 归并为当前 Global Object Registry
       → 活动运营视角草稿
            → 局部高召回属性与关系投影
            → 父节点跨孩子关系恢复
            → 四条硬业务线路全局复核
            → 最多五轮定向修复并收敛
```

区域树是编译顺序和上下文边界，不是知识分类。基础编译不选择固定卡片类型，不分析
对象关系，也不要求每条信息先在某个业务视角下得到解释。原文明示的对象关系仍作为
自然语言叙述忠实保留，后续再由活动运营等业务视角决定如何显式连线。

Assertion 不重复保存对象名称和 `about_object_ids`。正文使用
`{{object:对象ID}}` 引用 Object，例如 `{{object:obj-1}}过去通常申请两个场地。`；
程序直接从模板推导涉及对象，并在局部 ID 重写或父节点对象合并时同步改写引用。供人
阅读时再用对象当前的 `label` 渲染。因此修正对象规范名称只需修改 Object，不必逐条
修改 Assertion。只有“原文把某个名称写成什么”本身就是叙述内容时，该名称才作为引号
中的字面值留在模板内。

必要的年份、届次、阶段、周期、相对时间与先后关系直接保留在 Assertion 正文中，不再生成
Assertion 级 Temporal metadata。整份来源只提取一次保守的 `sourceTimeText`，连同 supporting
SourceBlock 保存在 Compilation 层。Source Time 只帮助解释来源所处的历史位置及“目前”“本届”
等相对表达；它不表示该来源中的全部 Assertion 在该时点都成立，也不是 Assertion validity，
不参与 embedding、rank 或当前性判断。

旧 `compile` / activity-view 实验仍有名为 `TemporalScope` 的另一套协议；它不属于当前
`source-semantics → global-resolution → memory importer → search` 主链，本轮不改动。

提取、覆盖复核和修复调用共享同一份严格输出协议。Object 固定使用 `object_id`、
`label`、`aliases`，不直接保存 Evidence；Evidence 固定使用 `evidence_id`、
`start_block_id`、`end_block_id`、`note_markdown`。模型不得用 `name`、
`canonical_name`、`block_id` 或 `text` 等近义字段替代。可空字段没有内容时使用 `null`，
不使用空字符串；`record` 不设置观点持有者。模型提交必须显式包含正确的
`schema_version`。每条 Assertion 至少包含一个 `{{object:对象ID}}`，不能提交没有对象的
孤立叙述；所有对象、观点持有者和 Evidence 引用都必须指向本包内已有 ID，Evidence 范围
还必须完整位于当前节点的自有原文中。每个 Object 必须连接至少一条 Assertion，其依据
通过这些 Assertion 的 Evidence 动态追溯。未被任何 Assertion 使用的 Evidence 不会阻断
产出，但会形成明确的人工复核警告。

Assertion 先经过现实语义门：只记录协会、活动、人物、角色、工作、制度、历史和真实
业务结构，不把目录、章节标题、概览、承接语、列表引导语或“本章将介绍什么”等文档
组织信息编译成记忆。相似表达若真正描述的是协会业务结构则仍然保留。只有文档导航而
没有现实命题的来源节点可以合法输出三个空数组，程序不会逼模型制造伪叙述。

当前会编译区域树中全部 `content_source` 节点：每个来源先完整提取一次，再由独立模型
调用逐块复核遗漏；之后按树深度从叶子向根节点整合。父节点只返回对象对齐、重复叙述
合并和有充分依据的纠正操作，程序无损保留其余内容，不进行业务关系分析。

## 安装

要求 Python 3.11–3.13 和 [uv](https://docs.astral.sh/uv/)：

```bash
cd services/cold-start
uv sync --python 3.11
```

Windows 可以先安装 uv：

```powershell
winget install --id=astral-sh.uv -e
```

安装后重新打开终端，再用 `uv --version` 确认命令可用。第一次运行时，MinerU 和
BGE-M3 可能下载模型；生产环境应在镜像构建阶段预下载并固定缓存。

项目会在 Windows 从 PyTorch 官方 CUDA 12.8 索引安装 GPU 版 Torch；Linux 和 macOS
使用 PyPI 对应平台版本。Windows 更新代码后必须重新执行一次 `uv sync --python 3.11`；完成后可用
以下命令确认 4070 已被当前虚拟环境识别：

```bat
uv run python -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU')"
```

## 环境配置

在仓库根目录的 `.env` 中配置：

```dotenv
AI_API_BASE_URL=https://example.com/v1
AI_API_KEY=...
AI_MODEL=...

AI_READ_TIMEOUT_SECONDS=600
AI_MAX_RETRIES=2
AI_STREAM_PROGRESS_INTERVAL_SECONDS=5
# 所有分析、提交、修复和父节点请求共享；学校接口 RPM=20 时建议设为 18。
AI_REQUESTS_PER_MINUTE=18

COLD_START_EMBEDDING_MODEL=BAAI/bge-m3
COLD_START_EMBEDDING_DEVICE=
COLD_START_EMBEDDING_BATCH_SIZE=8
COLD_START_MINERU_BACKEND=hybrid-engine
COLD_START_MINERU_EFFORT=high
COLD_START_MINERU_METHOD=auto
COLD_START_MINERU_IMAGE_ANALYSIS=true
COLD_START_MAX_PARALLEL_REGIONS=6
COLD_START_MAX_PARALLEL_COMPILATIONS=6
COLD_START_MAX_PARALLEL_PARENT_INTEGRATIONS=3
COLD_START_MAX_PARALLEL_PERSPECTIVE_GROUPS=6
COLD_START_PERSPECTIVE_OBJECTS_PER_GROUP=40
COLD_START_PERSPECTIVE_OBJECT_GROUP_CHARS=50000
COLD_START_PERSPECTIVE_ASSERTIONS_PER_GROUP=12
COLD_START_PERSPECTIVE_MAX_REVIEW_ROUNDS=5
```

完整示例见仓库根目录的 `.env.example`。本地接口不要求鉴权时可以不设置
`AI_API_KEY`。`COLD_START_EMBEDDING_DEVICE` 留空时依次尝试 CUDA、MPS 和 CPU。

模型请求固定使用 SSE 流式响应。运行期间，模型输入、正文、思考和原始流会持续写入
本次运行目录；即使调用失败，已收到的内容也会保留。

## 运行常驻 BGE-M3 搜索服务

基础编译中的区域判断和搜索层的 Assertion 向量索引复用同一个本地 `BgeM3Embedder`。
Web 搜索需要模型跨请求常驻，因此在仓库根目录启动 HTTP 包装：

```bash
pnpm memory:serve-embeddings
```

也可以直接从本目录运行并覆盖监听地址或模型：

```bash
uv run cold-start serve-embeddings \
  --host 127.0.0.1 \
  --port 8765 \
  --embedding-model BAAI/bge-m3 \
  --model-revision huggingface-main
```

服务只监听本机、没有鉴权，提供 `GET /health` 和 `POST /embed`；不要直接暴露到公网。
`COLD_START_EMBEDDING_MODEL_REVISION`（或 `--model-revision`）是向量 profile 的稳定修订
标识；查询服务和数据库索引必须保持一致。未设置时默认使用 `huggingface-main`，不要用缓存
位置（例如 `local`）表示同一份 Hugging Face 模型。
首次 `/embed` 请求才会延迟加载模型。设备未指定时依次选择 CUDA、MPS、CPU。完成
Global Resolution 的数据库导入后，在仓库根目录运行 `pnpm memory:index-assertions` 建立或
刷新搜索派生索引。

## 运行全局勘探

从 `services/cold-start` 目录运行：

```bash
uv run cold-start explore \
  --pdf "../../docs/architecture/USTC_TTA_乒协生存手册.pdf" \
  --output "../../.cold-start/runs"
```

如需同时在终端查看模型正文和思考：

```bash
uv run cold-start explore \
  --show-model-stream \
  --pdf "../../docs/architecture/USTC_TTA_乒协生存手册.pdf" \
  --output "../../.cold-start/runs"
```

主要产物包括：

```text
model-streams/             完整提示词、原始 SSE、正文和思考
global-exploration.json    全局勘探主快照
document-context.md        后续模型使用的简短文档背景
region-tree.json           完整区域树数据
region-tree.md             供人工查看的区域树
region-tree-checks.json    结构校准结果和来源解析警告
parsed-document.md         MinerU 稳定块按页重建的全文
mineru-raw/                MinerU 的 JSON、Markdown、图片与其他原始产物
mineru.log                 MinerU 完整运行日志
parsed-pages.json          实际进入后续流程的分页原文
parsed-blocks.json         带稳定 ID、来源类型、bbox 和资源路径的原文块
```

PDF 默认使用已经在乒协手册上验证过的
`hybrid-engine + high + auto + image-analysis`。冷启动不会重新解释 MinerU 的标题层级，
也不会再用另一套解析器覆盖其结果，而是直接把稳定 `content_list.json` 映射为分页原文
和稳定来源块。表格 HTML、图片 OCR/描述、页码、原始类型、bbox 与图片路径都会保留；
`mineru-raw/` 保存完整原始产物，便于任意 Evidence 回看。

运行目录会在解析前创建，因此 MinerU 或后续模型失败时，已经产生的日志和原始文件仍会
保留。Windows 下 `cold-start` 会自动以 Python UTF-8 模式启动，无需每次手动设置
`PYTHONUTF8`。启动日志会显示当前 Torch 实际识别到的 CUDA、MPS 或 CPU 设备。

来源解析警告只作为诊断报告保存，不参与区域树的 `stop` / `split` 判断，也不会使已经
完成结构判断的区域树变为未冻结状态。单条警告格式错误时只忽略该条警告，不否决模型的
结构判断。

## 第一轮来源语义编译

批量编译区域树中全部拥有 `content_source` 自有原文的节点：

```bash
uv run cold-start compile-sources \
  --run "../../.cold-start/runs/20260808T054110Z-107ebc775f"
```

可以临时覆盖来源并发数：

```bash
uv run cold-start compile-sources \
  --run "../../.cold-start/runs/20260808T054110Z-107ebc775f" \
  --max-parallel-sources 8
```

批量运行目录在根层保存一次 Source Time，并按来源隔离三个阶段断点：

```text
source-semantic-compilations/<UTC 时间>-full/
  model-streams/
  source-time.json
  working.json
  sources/
    region-0063/
      01-initial-claims.json
      02-reviewed-claims.json
      03-object-fragments.json
      source-semantics.json
      source-semantics.md
  source-semantics-full.json
  source-semantics-full.md
```

某些来源失败时，其他来源仍会继续并保存结果。恢复同一目录后，每个来源会从自身第一个
未完成阶段继续：

```bash
uv run cold-start compile-sources \
  --run "../../.cold-start/runs/20260808T054110Z-107ebc775f" \
  --resume "../../.cold-start/runs/20260808T054110Z-107ebc775f/source-semantic-compilations/<未完成目录>-full"
```

为了单独调试某个节点，也可以对任意拥有 `content_source` 自有原文的节点运行同样的三遍
式区域编译；单节点诊断不会伪造整份 Source 的 Source Time：

```bash
uv run cold-start compile-source \
  --run "../../.cold-start/runs/20260808T054110Z-107ebc775f" \
  --source-id "region-0063"
```

三个区域阶段彼此隔离，并且模型调用都直接输出 JSON 正文：

1. 一次 Atomic 阅读同时提取有原文依据的现实命题和来源明示的同指称字面草稿。能自然、
   低成本独立化的 Claim 正常独立化；需要明显代词消解、跨句/跨 block 身份推断、省略补全或
   复杂语义重建时，保留可用表达并标记 `context_dependent=true`，后续阅读时回到所属
   SourceRegion 理解，不建立 antecedent 或 context span。`claims` 只保存 factual proposition；
   `same_referent_drafts` 只保存至少两个原文字面
   span 及其 `occurrence_index`、`supporting_block_ids`，不生成 Object ID、alias 或
   canonical label，也不根据名称相似、常识或跨来源背景推断；
2. 冻结第一次结果，只增量报告遗漏命题，不能重新输出或改写已有命题；
3. 一次 Object Fragment Construction 同时发现 reusable names、在当前 SourceRegion 内
   合并明显同指的名称，并直接为每条 frozen claim 生成 `{{fragment:F1}}` 模板。Atomic
   `same_referent_drafts` 是必须同组的 hard grouping hint；名称可以只来自 SourceRegion 的
   naming context，不要求附着在 factual claim 上。该阶段不做全局 identity、canonical label、
   Object type、Relation 或业务价值判断。

批量编译还会在所有区域开始前只调用一次模型，从整份原文保守提取 `source_time_text` 和
`source_time_supporting_block_ids`。非空时间必须能在证据块中直接找到；不使用文件元数据、
编译时间或正文事件最大年份推断。Source Time 只定位来源的历史位置，不表示其中全部
Assertion 的有效期，也不参与 embedding、搜索排序或当前性判断。

程序只负责 Strict JSON/schema、claim 全覆盖、Fragment key/引用完整性、surface form 在当前
SourceRegion、reviewed/frozen claims 或 Atomic naming hints 中的轻量来源存在性，以及 Atomic
hard grouping 校验，并把临时 `F1` 稳定化为 source-local
`fragment-1`。不再计算 Mention 坐标、机械 substring replacement 或模板反向还原：

```text
source-semantic-compilations/<UTC 时间>-<来源节点>/
  model-streams/
  01-initial-claims.json
  02-reviewed-claims.json
  03-object-fragments.json
  source-semantics.json
  source-semantics.md
```

任一后续阶段失败时，可以从该阶段恢复，不会重新执行已经成功写入断点的阶段：

```bash
uv run cold-start compile-source \
  --run "../../.cold-start/runs/20260808T054110Z-107ebc775f" \
  --source-id "region-0063" \
  --resume "../../.cold-start/runs/20260808T054110Z-107ebc775f/source-semantic-compilations/<未完成目录>"
```

Source Time 对 JSON Schema、证据块存在性、顺序及原文直接包含关系做确定性校验；失败时最多
进行一次不携带旧正文或 reasoning 的 clean retry。Atomic/Missing 断点为 `source-claims.v7`，
Fragment 断点为 `source-object-fragments.v5`，最终快照为 `source-semantics.v9` /
`source-semantics-full.v9`，working 为 v9。旧 v8 Temporal checkpoint、区域快照、批量 working
和 Global Resolution 均不会被复用，旧运行目录保持不变。

这是 Global Resolver 之前的 Leaf compiler IR：它包含 Object Fragment、引用 Fragment
语义位置的 Assertion template、原文块依据以及 source-level 时间锚点。Fragment 不是长期 Object；v9
产物导入数据库后，由 Resolver 将 surface atom 和 Assertion reference atom 解析到当前
Global Object Registry。Resolver 不修改这里的 Fragment 或 Assertion template。

## 完整基础编译

已有冻结的区域树后，从所有内容来源节点一直编译到根节点：

```bash
uv run cold-start compile \
  --run "../../.cold-start/runs/20260729T100753Z-107ebc775f"
```

如果完整编译在某个来源或模型调用处中断，可继续同一个未完成目录。程序会校验并复用
`sources/*/source-compilation.json`，只重新编译尚未成功落盘的来源，然后从父节点整合阶段
继续；已有模型流文件不会被覆盖：

```bash
uv run cold-start compile \
  --run "../../.cold-start/runs/20260729T100753Z-107ebc775f" \
  --resume "../../.cold-start/runs/20260729T100753Z-107ebc775f/basic-compilations/<未完成目录>-full"
```

也可以临时覆盖并发数量：

```bash
uv run cold-start compile \
  --run "../../.cold-start/runs/20260729T100753Z-107ebc775f" \
  --max-parallel-sources 8 \
  --max-parallel-parents 4
```

处理过程分为三个阶段：

1. 并行编译所有拥有 `content_source` 自有原文的叶子或父节点。第一次调用启用思考，
   直接输出完整 Object、Assertion、Evidence 正文 JSON；第二次调用再次启用思考，逐块
   对照原文进行覆盖复核，并输出完整替代 JSON。Assertion 按可独立判断真假的命题原子化，
   所有已经提取为 Object、且在命题中实际充当参与者的对象指认都写成对象引用模板；覆盖
   复核会专门检查不能因已有一个 Object 引用而漏掉同一命题中的其他已有 Object。标题本身
   不生成文档结构 Assertion，但标题若命名现实活动、流程或工作事项，且正文以“常规流程”
   “特殊审批”等方式省略主语，基础提取必须建立该标题 Object，并把它补回正文 Assertion。
   覆盖复核还会检查命题的核心工作锚点，不能用审批部门、负责人、地点或举例对象代替真正
   被描述的流程 Object。
2. 按深度从叶子向根节点整合。父模型只提交对象合并、重复叙述合并和必要纠正，不重新
   输出整包，因此不会因为父节点输出遗漏而删除孩子内容，也不会建立 Relation。父节点
   还会收到程序按 Object label/aliases 列出的可能漏标引用候选，在能够消除同名歧义时通过
   `assertion_revisions` 修正原模板；这仍是基础 Assertion 纠正，不是业务连线。父节点使用
   一次启用思考的正文 JSON 调用。基础提取、覆盖复核和父节点整合的每次提交若校验
   失败，最多允许连续进行 3 次最小协议修复；JSON 语法错误和字段协议错误都使用同一上限，
   即使连续发生同类错误也会继续尝试。所有修复调用都显式启用思考。
3. 每个父节点完成上述已有项整合后，再进入独立的缺失 Object 恢复。第一个模型只报告
   `MissingObjectCandidate`，不能修改基础包；第二个模型只对候选做 Evidence 复查。只有
   `accept` 候选才由程序创建父节点命名空间中的新 Object，并把 Assertion 中与规范名称
   完全相同的字面值原位替换为对象引用。程序会校验候选 Assertion、Evidence、绑定位置和
   ID，且要求替换前后的可见 Assertion 正文完全一致。reject/defer 不改变基础包。每个
   父节点的发现、复查和新建 ID 都单独写入审计文件。

完整运行目录：

```text
basic-compilations/<UTC 时间>-full/
  model-streams/             所有模型请求、原始流、正文和思考
  sources/<节点 ID>/         每个 content_source 节点的提取结果与逐块覆盖报告
  nodes/<节点 ID>.json       每个节点完成整合后的基础记忆包
  nodes/<节点 ID>.missing-objects.json  缺失 Object 候选、复查与确定性写入记录
  working.json               运行中的完成进度；中断时仍可检查已有节点
  root-package.json          根节点最终 Object、Assertion、Evidence 包
  basic-compilation.json     完整运行快照、节点统计和根包
  basic-compilation.md       供人工检查的整树汇总和根包内容
```

## 解析 Global Object Registry

Resolver 直接读取 `compile-sources` 的完整本地产物，不读写数据库。它按
`source_node_ids` 顺序消费 SourceRegion：候选召回仍按 Fragment 进行，但每个非空
SourceRegion 只发起一次 LLM 身份对齐，将该 Region 的全部 Fragments、Assertions、局部
语境和各自 candidates 一次性交给模型，再整体校验和提交 integration plan。

```bash
cd services/cold-start
uv run cold-start resolve-objects \
  --compilation "../../.cold-start/runs/<运行目录>/source-semantic-compilations/<完整编译目录>" \
  --embedding-model "BAAI/bge-m3" \
  --candidate-limit 8
```

每次新执行会在输入编译目录下自动建立一个本地运行目录：

```text
<完整来源语义目录>/global-resolutions/<UTC 时间>-full/
  model-streams/           完整 request、原始 SSE、reasoning 和 content
  working.json             当前 Registry 与 SourceRegion cursor
  global-resolution.json  全部 Region 完成后生成的最终产物
```

这些文件都不在 Resolver 中间过程写入数据库。`model-streams/` 只是本地调试 trace，
不构成 Resolution decision/history；`working.json` 仅保存当前状态，不保存 candidates、
decision archaeology 或 membership 历史。Source ObjectFragment 始终保持不可变。

词面 normalized exact、compact exact、保守 contains 与 BGE top-k 只组成候选集合；任何分数都
不会自动触发 identity 合并。模型只允许在本轮候选中选择，并提交四种局部动作：

```text
create  incoming 是新身份，建立一个 Global Object
attach  incoming 加入一个已有 Global Object
merge   多个已有 Object 同一，保留最早 UUID 并移动当前归属
split   incoming 或一个已有 Object 混合身份，保留原 UUID 并拆出新 Object
```

`create / attach / merge / split` 可以在同一 Region integration plan 中同时发生。split 不只划分
Fragment 的 `surface_forms`：程序还要求模型把 Assertion template 中每一次
Fragment 引用按真实指称完整分区；因此“二课审批 / 二课系统”可以分别成为流程和平台，同时
相关 Assertion 不会被机械复制到两个 Object。Source ObjectFragment、原 surface form 和原
Assertion template 全部保持不变。

中断后从本地 `working.json` 继续：

```bash
uv run cold-start resolve-objects \
  --compilation "../../.cold-start/runs/<运行目录>/source-semantic-compilations/<完整编译目录>" \
  --resume "<完整编译目录>/global-resolutions/<UTC 时间>-full" \
  --embedding-model "BAAI/bge-m3" \
  --candidate-limit 8
```

`--candidate-limit 8` 表示每个 Fragment 最多向该 Region 的那一次模型调用提交 8 个普通候选；
精确词面命中会强制保留。`--stop-after 10` 表示本次最多前进 10 个 SourceRegion，不是
10 个 Fragment 或 10 次必然的模型调用；没有 Fragment 的 Region 只前进 cursor。仅使用词面召回可以
增加 `--no-bge`。

第一版不执行 final closure：处理过的 SourceRegion 不会因后续 Registry 变化重新入队，未被当前
Region 内各 Fragment 召回的 Global Object 也不会被模型重新审判。Global Object 数据结构已经为 Search
提供消费边界，但本轮没有修改 Search 实现。

## 物化 Global Assertions

`resolve-objects` 完整处理全部 SourceRegion 后，会自动额外写出 `global-assertions.json`：

- 原始 Source Assertion 的 `{{fragment:fragment-x}}` 保持不变，继续作为 compiler IR 与来源锚点；
- 最终 Assertion template 中，每次 Fragment reference 按该 reference atom 的当前归属替换为
  `{{object:<Global Object UUID>}}`；
- 再使用最终 Registry 当前拥有的 surface forms 扫描普通文本，按最长、无歧义匹配补充 literal
  reference atoms；共享 surface 不自动判断 identity；
- 这个阶段不调用模型或 BGE，不创建、merge 或 split Global Object，也不保存 resolution history。

已经完成的旧 Global Resolution 不需要重跑模型，可以单独补生成：

```bash
uv run cold-start finalize-assertions \
  --resolution "../../.cold-start/runs/<运行目录>/source-semantic-compilations/<完整编译目录>/global-resolutions/<UTC 时间>-full"
```

命令会在该 Global Resolution 目录原子写入或重新生成 `global-assertions.json`。

## 导入完整 cold-start package

数据库只接受同时包含 `global-resolution.json` 与 `global-assertions.json` 的完整结果，不接受未解析的
单独 `source-semantics-full.json`。导入器会同时校验不可变 Source IR、Global Object UUID/key、
所有 source atom 的完整互斥归属，以及 Global Assertion template/literal reference spans。

先部署 Prisma migration 并生成客户端：

```bash
pnpm prisma:deploy
pnpm prisma:generate
```

只校验文件，不连接或修改数据库：

```bash
pnpm memory:import-cold-start -- \
  --input ".cold-start/runs/<运行目录>/source-semantic-compilations/<完整编译目录>/global-resolutions/<UTC 时间>-full" \
  --validate-only
```

最终一次性替换当前记忆层：

```bash
pnpm memory:import-cold-start -- \
  --input ".cold-start/runs/<运行目录>/source-semantic-compilations/<完整编译目录>/global-resolutions/<UTC 时间>-full"
```

如果数据库中已经存在正式 Business View Card 或 Proposal，导入器会在写入前明确拒绝替换，
避免旧 Compilation 上经用户批准的正式业务状态被级联删除或失去 Object 锚点。请先完成
Business View 状态到新 Compilation 的迁移，或由管理员明确清理这些状态；当前版本不会自动迁移
或删除它们。

导入后会在 Global Resolution 目录写入 `database-import.json`，记录各类最终实体和当前
atom 归属的写入数量。数据库保存原始 Source Assertion、物化后的 Global Assertion、source reference
resolution 和新增的 literal reference atoms；不保存 Resolver cursor、candidates、decision log、
模型流、successor lineage 或 membership 历史区间。

## 调试单个叶子

先从 `region-tree.md` 中选定一个 `content_source` 叶子，再运行：

```bash
uv run cold-start compile-leaf \
  --run "../../.cold-start/runs/20260729T100753Z-107ebc775f" \
  --leaf-id "region-0063"
```

这个命令只用于局部调试。第一次模型调用会收到文档背景、从根节点到该叶子的简短介绍，
以及该叶子的完整带编号原文；模型启用思考并在正文输出完整 Object、Assertion、Evidence
JSON。第二次调用重新逐块比较原文与第一次结果，贯彻 Assertion 原子化标准并输出完整
替代 JSON。覆盖复核默认保留第一次结果的 ID 和对象边界，只修正原文能够明确证明的
遗漏或错误。两个阶段都不分析 Relation；同样使用上述最多三次且全部开启思考的协议
修复规则。

每次运行创建独立产物目录：

```text
basic-compilations/<UTC 时间>-<叶子 ID>/
  model-streams/             模型请求、原始流、正文和思考
  basic-compilation.json     完整结构化基础记忆包
  basic-compilation.md       对象、叙述、依据及原文逐块覆盖报告
```

## 映射活动运营视角

第一轮修整同时加入了新的通用业务视角协议，但尚未替换下面的 v10 运行器。新协议把
Activity、Workflow、SubWorkflow（仍使用 Workflow 节点种类）、WorkStep 和支撑对象统一为
递归 `BusinessNode`，用 `BusinessTopologyEdge` 表达 uses / contains / precedes /
depends_on。`BusinessDimension.applies_to` 可指向任意节点种类及动态 `role_key`；具体值统一
写入 `DimensionAssignment.subject_node_id`，不再使用 Activity 专属赋值结构。confirmed
维度对每个适用节点必须显式给出 known、unknown、not_applicable 或 conflicting。该协议位于
`activity_view/perspective_schema.py`，当前只作为下一版运行流程的数据边界，现有
`map-activity` 仍产生 v10 草稿。

完整基础编译通过后，把其中的 Object、Assertion、Evidence 映射为隔离的
`activity_operations` 草稿：

```bash
uv run cold-start map-activity \
  --compilation "../../.cold-start/runs/20260729T100753Z-107ebc775f/basic-compilations/20260803T072128342102Z-full"
```

这个阶段不重新读取整份 PDF，也不覆盖输入的基础记忆包。程序先读取全文 Object
紧凑索引，形成一份全局活动运营语义边界；再把共享 Object 的 Assertion
组成确定性连通分量；互不连通的分量不再为了节省调用而混装，超出单组上限的分量再按原文
顺序分批处理。默认每组最多 12 条 Assertion，区域树只为当前分量补充共同父级上下文。

处理先完成一次局部高召回编译：从全文紧凑索引识别材料板块，再逐条把 Assertion 投影为
Attribute、卡片关系、引用复查或省略；随后按已投影 Relation 的连通分量组织候选 Object，
无关系 Object 只与同一来源区域中的对象合组。每组同时受 Object 数量和展开后字符数限制，
避免把行政、财务、场地和物资等跨度过大的判断塞进同一次调用。分类阶段读取候选 Object 的
全部相关 Assertion，但不再读取或保护前一阶段的临时投影，只判断 `view_card`、
`support_reference`、`outside_view` 三态和主要角色。

局部结果之后进入循环：区域树父节点自底向上读取自己的 introduction、直接孩子摘要和孩子
已有投影，只合成有结构依据的跨孩子关系；四个全局审查器再分别从 `activity_flow`、
`guidance`、`staffing`、`organization_context` 检查完整紧凑 Object—Assertion 图和当前
草稿；程序合并差异后，只重投影被点名的 Assertion，再重新做父节点关系恢复和全局审查。没有
新变更时提前收敛；后续轮次只重算受影响区域到根节点之间的父节点；相同问题在同一状态
重复时转为未解决问题；安全上限默认 5 轮，可通过
`COLD_START_PERSPECTIVE_MAX_REVIEW_ROUNDS` 调整。

活动运营边界同时包含运营主干和运营指导。后者不要求能立刻执行：预算边界、信息准确性、
舆论红线、渠道选择经验等，只要会稳定改变具体活动判断，就可以作为 Rule、Principle、
Practice 或 Insight 保留；纯组织愿景、历史评价和治理哲学仍留在基础记忆或其他视角。

四条线路是固定准入合同，不是宽泛主题标签：

```text
activity_flow          活动 → 活动特征 → Workflow；Workflow 递归包含子 Workflow/WorkStep
guidance               Rule / Principle / Practice / Insight 性质的 Assertion
staffing               Person → Role → 负责的活动或工作
organization_context   直接改变活动授权、资源、人员容量或执行能力的时期背景
```

只有 Object 能形成卡片。Fact、Rule、Principle、Practice 和 Insight 是 Assertion 的语义性质，
不会再成为与 Object 平级的节点。全局规划按来源区域组织 Object，只用每个 Object 分散抽样的
最多两条 Assertion 识别
语义板块，不作最终去留；局部语义校正仍读取候选 Object 的完整相关 Assertion 集合。每个
候选 Object 必须被分为：

```text
view_card          本视角中可独立检索和连接的卡片
support_reference  可承载保留 Attribute 或作为必要指代，但不成卡
outside_view       留在基础记忆或其他业务视角
```

`view_card` 再从现有角色中选择稳定主要角色。除 organization、activity、
activity_trait、workflow、work_step、person、role、period 外，支撑对象可使用 system、
funding_scheme、communication_channel、standard、document、venue、resource，避免把二课、
经费规范、公众号或场地区域硬塞成活动特征或工作步骤。

非联系性 Assertion 整体成为以 Object 为主体的 Attribute，不再强制填写固定属性槽位。主体
可以是 `view_card`，也可以是 `support_reference`；后者保留可检索的运营知识但不制造宽泛
业务卡。联系性 Assertion 整体成为 Relation：Relation 端点必须是 `view_card`，并保留原始
Assertion、时间、Evidence 和不确定性，只额外记录四条线路中的结构模式及参与角色。

Relation 模式与线路固定对应：

```text
activity_flow
  classification       对象归入活动或工作分类
  workflow_use         活动或活动特征使用 Workflow
  composition          Workflow 包含子 Workflow 或 WorkStep
  sequence             工作位置之间的明确先后
  dependency           工作位置之间的明确依赖

guidance
  guidance_application 指导 Assertion 的作用位置与适用范围

staffing
  role_holding         Person 担任 Role
  responsibility       Person/Role 负责活动或工作
  participation        Person/Role 参与活动或工作

organization_context
  contextualization    Organization/Period 为对象提供有来源的背景
```

Attribute 主体和每个 Relation 参与者都必须由基础 Assertion 明确引用。Attribute 主体允许
是 `view_card` 或 `support_reference`；Relation 的所有端点仍必须是 `view_card`。因此像
“经费管理建立在预算刚性与收支两条线之上”这样的运营原则可以进入 guidance，但宽泛的
“经费管理”本身不必成为业务卡。保留 Assertion 中其他被引用但不成卡的 Object 也自动成为
`support_reference`。省略和视角外判断只影响活动运营草稿，基础 Object、Assertion 和
Evidence 仍完整保留。

四线路审查对父级关系候选先显式输出 `accept`、`reject` 或 `unresolved`；只有主线路审查
接受的候选才进入正式图。对基础 Assertion 仍只输出 `add_lane`、`remove_lane`、`reproject`
三类最小差异。定向修复只能处理被点名的基础 Assertion；Attribute 主体允许是
`view_card` 或 `support_reference`，Relation 端点仍必须全部为 `view_card`。证据不足或固定对象边界无法安全修复
的问题进入未解决列表，不会靠循环猜测。

父节点不是自由知识合成器，只恢复被连续原文切分隐藏、但来源已经表达的跨区域关系。候选
使用 `derivation_kind=parent_recovery`，同时保留证明类型、桥接 Evidence、支撑 Assertion
和来源区域节点。证明类型仅允许原文直接陈述、结构恢复和条件逻辑的必要规范化；共同数据、
可能帮助、同章共现、常识推断或改革设想都不能形成正式关系。结构恢复仅允许
classification、workflow_use、composition；dependency 必须有明确前置、必要条件或“否则
无法”的 Evidence。

每种 Relation 还具有程序级 Object 角色签名。例如 composition 的 whole 必须是 Workflow，
part 只能是 Workflow/WorkStep；Organization 不能为了连接活动而伪装成 whole。若局部关系
与 Object 真实角色冲突，程序保持 Object 角色并只重投影受影响的 Assertion。父级候选关系
正文由程序按关系模式和对象名称生成，模型不能自由补写因果解释。父级恢复会读取候选
Assertion 的 Evidence 原文和区域树已有 source_issues；证明触及来源冲突时只能报告问题。
父级 `direct_statement` 仍要求至少一条 Assertion 同时引用全部端点；
`necessary_normalization` 允许多条原子 Assertion 联合覆盖端点，但 Evidence 必须以“必须”、
“否则无法”或“只有……才”等条件逻辑直接证明必要关系，不能把分别介绍两个 Object 的材料
拼成联系。

模型只判断 Attribute 的主要归属，不负责决定其他引用 Object 是否保留，也不能为了让次要
Object 成卡而制造 Relation。基础 Assertion 的 `mode=record/viewpoint` 描述来源陈述姿态；
活动视角的 `semantic_kind=fact/rule/principle/practice/insight` 描述业务语义，两者相互独立。

业务投影保留一个受限的异常分支：程序只把 Assertion 模板中按名称明示、但尚未引用的已有
Object 列为候选；只有模型判断缺少候选引用会阻碍当前 Attribute 或 Relation 时，才能请求
`reference_review_requests`。随后独立复查只读取该 Assertion 的 Evidence 原文，逐个确认、
拒绝或标记存疑。确认后只允许把原模板中的名称换成 Object 占位符，不得改变命题正文，并只
重投影受影响的 Assertion；确认新增的 Object 会随该投影自动形成卡片。拒绝或存疑不会修改
基础内容，也不得继续循环复查。

确认的修订作为本次运行的可审计 amendment 使用，使后续投影能够引用正确 Object；程序不会
悄悄覆盖输入的 `basic-compilation.json`。后续若要正式回写基础层，可以由人工审核 amendment
后进入专门发布流程。

活动运营产物只属于当前视角，并固定保持 `draft`：

```text
activity-perspectives/<UTC 时间>-draft/
  model-streams/             全部提示词、正文、思考与工具调用
  group-checkpoints/         Assertion、Object 与成功父节点结果的独立检查点
  semantic-boundary.json     全局语义边界规划
  activity-operations.json   完整视角草稿
  activity-operations.md     按对象卡整理的人类可读报告
  object-cards.json          由进入视角的 Object 形成的唯一卡片
  reference-review-results.json
                             按需 Evidence 复查的确认、拒绝与存疑结果
  assertion-reference-amendments.json
                             本次运行确认并采用的基础 Assertion 引用修订
  attribute-projections.json 以 view_card/support_reference Object 为主体的 Assertion
  relation-projections.json  作为对象卡关系的 Assertion
  parent-recovery.json       父节点关系恢复与线路准入发现的未决问题
  review-rounds.json         每轮四线路差异、收敛状态和未解决问题
  omissions.json             本视角的支撑引用、视角外 Object 与省略 Assertion ID
  working.json               全局边界、Assertion 投影与对象语义校正阶段检查点
```

模型或接口失败后，可继续同一草稿并复用已经校验的 Assertion、Object、定向修复、父节点
恢复和单线路全局复核检查点；输入发生变化的检查点会自动失效。单个父节点连续协议失败会
记录为 `synthesis_failure` 并继续处理其余节点。单条全局线路复核失败时，该线路负责的父级
候选不会准入，失败会作为未决问题写入草稿，不再中止整份结果。父节点只读取跨直接孩子或
父节点自有的 Assertion 候选；全局复核只读取程序为当前线路筛出的高召回候选子图：

```bash
uv run cold-start map-activity \
  --compilation "../../.cold-start/runs/<运行目录>/basic-compilations/<完整编译目录>" \
  --resume "../../.cold-start/runs/<运行目录>/basic-compilations/<完整编译目录>/activity-perspectives/<未完成草稿>"
```

模型流同时保存逐事件的 `*.sse.jsonl`。若思考或正文连续三次逐字重复同一长片段，程序会中止
当前单次请求、保留原始 SSE 并让该分组明确失败；不会把截断内容当成成功结果。

关系的 `derivation_kind` 区分原文直接支持的 `direct_source` 与把充分原文规范化为业务谓词
的 `perspective_interpretation`。当前版本先生成可审查文件草稿，尚未写入或发布数据库视角。

## 当前边界

当前只处理一份 PDF，并先验证《乒协生存手册》的整树基础记忆提取质量。暂不处理：

- 多文件组织、跨文件消歧和版本关系；
- 原始文件层映射；
- 活动运营视角的数据库写入、SearchCard、人工审核界面和自动发布。

## 验证

```bash
uv run ruff check .
uv run pytest
```
