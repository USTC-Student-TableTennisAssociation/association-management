"""冷启动 worker 命令行入口。"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from cold_start.config import ExplorationSettings, ModelSettings
from cold_start.document import DoclingPdfLoader
from cold_start.environment import load_environment_file
from cold_start.global_exploration import (
    GlobalExplorationRunner,
    create_exploration_run_directory,
    write_exploration_artifacts,
)
from cold_start.llm import OpenAICompatibleChatModel
from cold_start.progress import ConsoleProgressReporter


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cold-start",
        description="生成单份协会手册的文档背景和递归连续区域树",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    explore = subparsers.add_parser("explore", help="运行单 PDF 全局勘探")
    explore.add_argument("--pdf", type=Path, required=True, help="待处理 PDF 路径")
    explore.add_argument(
        "--output",
        type=Path,
        default=Path(".cold-start/runs"),
        help="运行产物根目录",
    )
    explore.add_argument("--model", help="覆盖 AI_MODEL")
    explore.add_argument("--api-base-url", help="覆盖 AI_API_BASE_URL")
    explore.add_argument("--api-key", help="覆盖 AI_API_KEY")
    explore.add_argument(
        "--env-file",
        type=Path,
        help="显式指定环境文件；不指定时从当前目录向上查找 .env",
    )
    explore.add_argument(
        "--read-timeout-seconds",
        type=float,
        help="覆盖 AI_READ_TIMEOUT_SECONDS，表示流中断后最多等待秒数",
    )
    explore.add_argument(
        "--max-model-retries",
        type=int,
        help="覆盖 AI_MAX_RETRIES，表示流式请求最大尝试次数",
    )
    explore.add_argument(
        "--show-model-stream",
        action="store_true",
        help="在终端分段显示接口返回的正文和思考内容",
    )
    explore.add_argument(
        "--embedding-model",
        help=(
            "本地 BGE-M3 目录或 Hugging Face 模型名；"
            "覆盖 COLD_START_EMBEDDING_MODEL"
        ),
    )
    return parser


async def _run_explore(args: argparse.Namespace) -> int:
    progress = ConsoleProgressReporter()
    environment_file = load_environment_file(args.env_file)
    if environment_file:
        progress.report("环境", f"已加载 {environment_file}（不覆盖系统环境变量）")
    else:
        progress.report("环境", "未找到 .env，使用系统环境变量和命令行参数")

    model_settings = ModelSettings.from_environment(
        model=args.model,
        api_base_url=args.api_base_url,
        api_key=args.api_key,
        read_timeout_seconds=args.read_timeout_seconds,
        max_retries=args.max_model_retries,
    )
    exploration_settings = ExplorationSettings.from_environment(
        embedding_model=args.embedding_model,
    )
    progress.report(
        "模型",
        (
            f"使用模型 {model_settings.model}，接口 {model_settings.api_base_url}；"
            f"纯流式，读取超时 {model_settings.read_timeout_seconds:g} 秒，"
            f"最多尝试 {model_settings.max_retries} 次"
        ),
    )

    progress.report("PDF", f"开始解析 {args.pdf}")
    document = await asyncio.to_thread(DoclingPdfLoader().load, args.pdf)
    nonempty_pages = sum(bool(page.markdown.strip()) for page in document.pages)
    progress.report(
        "PDF",
        (
            f"解析完成：{nonempty_pages}/{document.page_count} 页非空，"
            f"全文 {len(document.markdown)} 字符，{len(document.blocks)} 个稳定块"
        ),
    )

    run_directory = create_exploration_run_directory(
        output_root=args.output,
        document=document,
    )
    model_stream_directory = run_directory / "model-streams"
    progress.report("产物", f"已创建运行目录 {run_directory}")
    progress.report("模型", f"模型输入、正文和思考将实时保存到 {model_stream_directory}")
    progress.report(
        "检索",
        (
            f"按需使用 BGE-M3（{exploration_settings.embedding_model}）；"
            "只有模型调用 search_document 时才加载向量模型"
        ),
    )

    model = OpenAICompatibleChatModel(
        model_settings,
        progress=progress,
        trace_directory=model_stream_directory,
        show_model_stream=args.show_model_stream,
    )
    try:
        snapshot = await GlobalExplorationRunner(
            model=model,
            settings=exploration_settings,
            progress=progress,
            run_directory=run_directory,
        ).run(document)
    finally:
        await model.aclose()

    progress.report("产物", f"正在写入 {run_directory}")
    paths = write_exploration_artifacts(
        run_directory=run_directory,
        document=document,
        snapshot=snapshot,
    )
    progress.report("完成", f"全局勘探产物：{paths.run_directory}")
    return 0


def main() -> None:
    args = build_parser().parse_args()
    try:
        if args.command == "explore":
            raise SystemExit(asyncio.run(_run_explore(args)))
    except KeyboardInterrupt:
        print("任务已取消。", file=sys.stderr)
        raise SystemExit(130) from None
    except Exception as error:
        print(f"冷启动任务失败：{error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
