"""冷启动 worker 命令行入口。"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from cold_start.config import ExplorationSettings, ModelSettings
from cold_start.document import DoclingPdfLoader
from cold_start.global_exploration import (
    GlobalExplorationRunner,
    write_exploration_artifacts,
)
from cold_start.llm import OpenAICompatibleChatModel


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
        "--max-review-rounds",
        type=int,
        default=2,
        help="交叉校验与定向回看最多轮数",
    )
    return parser


async def _run_explore(args: argparse.Namespace) -> int:
    model_settings = ModelSettings.from_environment(
        model=args.model,
        api_base_url=args.api_base_url,
        api_key=args.api_key,
    )
    exploration_settings = ExplorationSettings(
        max_review_rounds=args.max_review_rounds,
    )

    print(f"正在解析 PDF：{args.pdf}", flush=True)
    document = await asyncio.to_thread(DoclingPdfLoader().load, args.pdf)
    print(f"已解析 {document.page_count} 页，开始三路全局勘探。", flush=True)

    model = OpenAICompatibleChatModel(model_settings)
    try:
        snapshot = await GlobalExplorationRunner(
            model=model,
            settings=exploration_settings,
        ).run(document)
    finally:
        await model.aclose()

    paths = write_exploration_artifacts(
        output_root=args.output,
        document=document,
        snapshot=snapshot,
    )
    print(f"全局勘探完成：{paths.run_directory}", flush=True)
    if snapshot.frozen_with_unresolved_issues:
        print("注意：快照因达到回看上限而带未解决问题冻结。", flush=True)
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
