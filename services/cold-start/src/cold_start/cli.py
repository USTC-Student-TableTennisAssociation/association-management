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
    write_exploration_artifacts,
)
from cold_start.llm import OpenAICompatibleChatModel
from cold_start.progress import ConsoleProgressReporter


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cold-start",
        description="将单份协会手册 PDF 做成低权威全局勘探快照",
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
        "--max-review-rounds",
        type=int,
        default=2,
        help="交叉校验与定向回看最多轮数",
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
    exploration_settings = ExplorationSettings(
        max_review_rounds=args.max_review_rounds,
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
            f"全文 {len(document.markdown)} 字符"
        ),
    )

    model = OpenAICompatibleChatModel(model_settings, progress=progress)
    try:
        snapshot = await GlobalExplorationRunner(
            model=model,
            settings=exploration_settings,
            progress=progress,
        ).run(document)
    finally:
        await model.aclose()

    progress.report("产物", f"正在写入 {args.output}")
    paths = write_exploration_artifacts(
        output_root=args.output,
        document=document,
        snapshot=snapshot,
    )
    progress.report("完成", f"全局勘探产物：{paths.run_directory}")
    if snapshot.frozen_with_unresolved_issues:
        progress.report("注意", "快照因达到回看上限而带未解决问题冻结")
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
