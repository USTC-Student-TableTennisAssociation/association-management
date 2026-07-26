# 冷启动 Worker

该服务负责把单份协会手册 PDF 勘探为一份低权威的文档级阅读地图。它是后续递归局部阅读、记忆编译和图连接的前置阶段，不提取具体记忆，也不直接写入记忆层数据库。

## 当前边界

已实现：

- 使用 Docling 解析单个 PDF，保留页码、阅读顺序、表格和扫描页文本；
- 先根据目录、标题和逐页短预览形成轻量 Markdown 章节导航；
- 结构导航完成后形成另外两份产物：
  - 说明文档身份、范围、来源和整体权威边界的文档全局画像；
  - 只记录粗略记忆区域、全文级信号和原文明示章节关系的文档记忆地形；
- 多个地形阅读单元受控并发，只产生区域级增量观察，再统一去重压缩；
- 三份产物执行覆盖、证据、事实准确性和全局勘探边界校验；
- 根据校验问题定向回看指定页和指定阅读路径；
- 达到回看上限后显式携带仍未解决的全局勘探边界问题冻结；
- 分开保存精简阅读地图、原始地形观察、人工报告和 PDF 解析中间产物。

全局勘探明确不负责：具体事实提取、最小充分记忆、节点类型、记忆粒度、复用判断、图连线或局部编译问题。看到 BBS 创始帖子和成员名单时，本阶段只应留下“协会创办与发展历史”这一阅读区域。

尚未实现：

- 递归局部编译；
- 记忆卡片与图关系生成；
- 写入 Prisma/PostgreSQL；
- BGE-M3 embedding；
- 多文件合并和跨文件消歧。

## 为什么是独立 Python Worker

PDF 布局解析、OCR、LangGraph 编排和后续本地 embedding 都属于长耗时、模型依赖较重的任务。它们不进入 Next.js 请求生命周期，而作为可单独部署和扩容的批处理 worker 运行。Web 应用后续只负责提交任务、展示状态和审核结果。

## 安装

要求 Python 3.11–3.13 和 [uv](https://docs.astral.sh/uv/)。

```bash
cd services/cold-start
uv sync
```

模型通过 OpenAI 兼容的 `chat/completions` 接口调用：

```bash
export AI_API_BASE_URL="https://example.com/v1"
export AI_API_KEY="..."
export AI_MODEL="..."
export AI_READ_TIMEOUT_SECONDS="600"
export AI_MAX_RETRIES="2"
export AI_STREAM_PROGRESS_INTERVAL_SECONDS="5"
```

`AI_API_KEY` 对不要求鉴权的本地接口可以省略。

模型请求固定使用 `stream: true`。Worker 只接受 SSE `data:` 事件，并要求流以
`[DONE]` 正常结束；不会回退到普通 JSON 响应。流式片段会先完整累积，Markdown
直接使用完整文本，JSON 则在流结束后执行 Schema 校验。

`AI_READ_TIMEOUT_SECONDS` 表示连续多久没有收到新的流式数据才超时，不是整个请求的
总时限。默认 600 秒。`AI_STREAM_PROGRESS_INTERVAL_SECONDS` 控制终端报告已接收字符数
的频率，默认 5 秒。

CLI 会从当前目录和服务代码位置向上查找第一个 `.env`，因此从仓库或
`services/cold-start` 目录运行时会自动复用仓库根目录的 `.env`。系统环境变量不会
被 `.env` 覆盖，命令行参数的优先级最高。也可以显式指定：

```bash
uv run cold-start explore --env-file ../../.env --pdf "/data/手册.pdf"
```

## 运行

```bash
uv run cold-start explore \
  --pdf "/data/乒协生存手册.pdf" \
  --output "/data/cold-start-runs"
```

模型原始 SSE、已生成正文和接口返回的思考内容会在调用期间持续写入每次运行的
`model-streams/` 目录，即使请求失败也会保留。需要同时在终端查看正文与思考时：

```bash
uv run cold-start explore \
  --show-model-stream \
  --pdf "/data/乒协生存手册.pdf" \
  --output "/data/cold-start-runs"
```

只有模型接口实际返回 `reasoning_content`、`reasoning` 或 `thinking` 时，终端和
`*.reasoning.partial.txt` 才会出现思考内容。

每次运行创建不可覆盖的独立目录：

```text
<时间>-<PDF哈希>/
├── model-streams/            # 原始 SSE、正文和思考的实时调试记录
├── global-exploration.json   # 后续流程读取的低权威阅读地图
├── global-exploration.md     # 人工检查报告
├── landscape-observations.json # 合并前的区域级地形观察
├── parsed-document.md        # Docling 全文
└── parsed-pages.json         # 带页码的解析结果
```

运行期间会输出相对耗时和语义进度，包括 PDF 解析、结构扫描、画像与地形单元进度、
流式首片等待时间、SSE 事件与正文/思考字符数、地形观察合并、边界校验轮次、
定向回看的路径与页码、模型重试以及最终产物目录。结构扫描先完成，画像和地形
随后并行运行；多个地形观察受控并发，因此终端进度可能交错出现。

## 验证

```bash
uv run ruff check .
uv run pytest
```

单元测试使用假模型，不会产生外部模型调用。第一次真实解析 PDF 时，Docling 可能下载版面分析或 OCR 模型；生产环境应在镜像构建阶段预下载并固定模型缓存。
