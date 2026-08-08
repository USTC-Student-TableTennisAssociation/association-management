# MinerU 独立解析基准

这个小服务保留为 MinerU 的独立解析与回归基准。生产冷启动流程已经直接接入 MinerU；
这里不导入数据库、不建立区域树，适合单独比较解析参数和检查原始输出质量。

```text
PDF
  → MinerU 3.4.4 原始产物（完整保留）
  → 薄适配器读取稳定的 content_list.json
  → echo-document.json（页码、阅读顺序、类型、bbox、文字/资源）
  → 非阻塞回归检查报告
```

## Windows 4070 安装

使用独立环境，避免 MinerU、Docling、Transformers 和 Torch 相互影响：

```bat
cd services\mineru-parser
uv sync --python 3.11 --extra mineru
uv run --extra mineru echo-mineru doctor
```

这里安装的是 MinerU 的 `core` 能力，已经包含本地 `hybrid-engine` 所需的 VLM、Pipeline
和 Transformers 依赖；不安装 `all` 中额外的 LMDeploy、vLLM 和对象存储组件。它们不是
本次单机解析所需依赖，而且 LMDeploy 当前的 Windows 依赖会错误请求仅 Linux 提供的 NCCL。

项目已在 Windows 为 `torch` 和 `torchvision` 指向 PyTorch CUDA 12.8 索引。`doctor`
必须看到：

```text
CUDA available: True
GPU: NVIDIA GeForce RTX 4070 Laptop GPU
```

如果模型从 Hugging Face 下载较慢，可在当前 PowerShell 中设置：

```powershell
$env:MINERU_MODEL_SOURCE = "modelscope"
```

第一次运行会下载模型。MinerU 官方给本地 Hybrid/VLM 的最低要求是 8 GB 显存、16 GB
内存和约 20 GB 磁盘；4070 Laptop 常见的 8 GB 显存处在最低边界，先使用默认的
`hybrid-engine + medium`，不要同时运行 Docling VLM 或 BGE-M3。

## 解析乒协手册

在 `services\mineru-parser` 中运行：

```bat
uv run --extra mineru echo-mineru parse ^
  --pdf "..\..\docs\architecture\USTC_TTA_乒协生存手册.pdf" ^
  --output "..\..\.cold-start\mineru-runs" ^
  --profile ".\benchmarks\ustc-tta-manual.json"
```

PowerShell 请把续行符 `^` 换成反引号，或直接写成一行。默认参数为：

- `--backend hybrid-engine`
- `--effort medium`
- `--method auto`
- 不显式覆盖 MinerU 的 image analysis 行为

需要最高精度对照时可以另跑一个新目录：

```bat
uv run --extra mineru echo-mineru parse ^
  --pdf "..\..\docs\architecture\USTC_TTA_乒协生存手册.pdf" ^
  --output "..\..\.cold-start\mineru-runs" ^
  --profile ".\benchmarks\ustc-tta-manual.json" ^
  --effort high ^
  --image-analysis
```

`medium` 是第一轮主候选；`high` 只用于质量明显不足后的第二轮对照。

## 每次运行的产物

```text
.cold-start/mineru-runs/<时间-文件哈希>/
  run.json                 运行状态、参数和最终统计
  mineru.log               MinerU 完整终端输出
  mineru-raw/              MinerU 的全部原始 Markdown、JSON、图片和调试 PDF
  parsed-document.md       复制出的 MinerU 主 Markdown，方便直接阅读
  echo-document.json       Echo 薄适配结果
  benchmark-report.json    机器可读检查结果
  benchmark-report.md      人工可读检查结果
```

`echo-document.json` 只依赖 MinerU 官方稳定的 `content_list.json`，不绑定仍标记为开发版的
`content_list_v2.json`。每个块保留从 1 开始的页码、全局阅读顺序、内容类型、0–1000 bbox 和资源
路径。MinerU 原始产物始终完整保留；适配失败也不会删除它们。

手册回归配置会自动检查 35 页、附录 B 八位会长、12.2 节关键片段的阅读顺序、最低表格
数量、BBS 截图是否仍作为带 bbox 的视觉证据存在，以及 `QQ群` 是否再次被误拆成单独的
`## QQ` 标题。检查默认非阻塞：解析成功但某项未通过时仍返回成功并写完整报告。只有显式
添加 `--strict` 才会因检查失败返回状态码 2。

## 本地开发验证

不安装 MinerU 大模型依赖也能测试 Echo 适配器：

```bash
uv run pytest
uv run ruff check .
```

uv run --extra mineru echo-mineru parse --pdf "..\..\docs\architecture\USTC_TTA_乒协生存手册.pdf" --output "..\..\.cold-start\mineru-runs" --profile ".\benchmarks\ustc-tta-manual.json" --effort high --image-analysis
