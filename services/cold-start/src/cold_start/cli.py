"""冷启动 worker 命令行入口。"""

from __future__ import annotations

import argparse
import asyncio
import shutil
import sys
import time
from pathlib import Path

from cold_start.compilation import (
    LeafCompilationRunner,
    ParentIntegrationRunner,
    create_compilation_directory,
    create_parent_integration_directory,
    load_exploration_inputs,
    load_parent_integration_inputs,
    write_compilation_artifacts,
    write_parent_integration_artifacts,
)
from cold_start.compilation.parent_runner import write_parent_integration_checkpoint
from cold_start.compilation.runner import write_compilation_checkpoint
from cold_start.config import CompilationSettings, ExplorationSettings, ModelSettings
from cold_start.document import DoclingPdfLoader
from cold_start.environment import load_environment_file
from cold_start.global_exploration import (
    GlobalExplorationRunner,
    create_exploration_run_directory,
    write_exploration_artifacts,
)
from cold_start.llm import OpenAICompatibleChatModel
from cold_start.progress import ConsoleProgressReporter


def _add_model_arguments(command: argparse.ArgumentParser) -> None:
    command.add_argument("--model", help="覆盖 AI_MODEL")
    command.add_argument("--api-base-url", help="覆盖 AI_API_BASE_URL")
    command.add_argument("--api-key", help="覆盖 AI_API_KEY")
    command.add_argument(
        "--env-file",
        type=Path,
        help="显式指定环境文件；不指定时从当前目录向上查找 .env",
    )
    command.add_argument(
        "--read-timeout-seconds",
        type=float,
        help="覆盖 AI_READ_TIMEOUT_SECONDS，表示流中断后最多等待秒数",
    )
    command.add_argument(
        "--max-model-retries",
        type=int,
        help="覆盖 AI_MAX_RETRIES，表示流式请求最大尝试次数",
    )
    command.add_argument(
        "--show-model-stream",
        action="store_true",
        help="在终端分段显示接口返回的正文和思考内容",
    )


def _add_pdf_arguments(command: argparse.ArgumentParser) -> None:
    command.add_argument("--pdf", type=Path, required=True, help="待处理 PDF 路径")
    command.add_argument(
        "--output",
        type=Path,
        default=Path(".cold-start/runs"),
        help="运行产物根目录",
    )
    command.add_argument(
        "--embedding-model",
        help=(
            "本地 BGE-M3 目录或 Hugging Face 模型名；"
            "覆盖 COLD_START_EMBEDDING_MODEL"
        ),
    )


def _add_compilation_parallel_arguments(command: argparse.ArgumentParser) -> None:
    command.add_argument(
        "--max-parallel-leaves",
        type=int,
        help="覆盖 COLD_START_MAX_PARALLEL_COMPILATIONS",
    )
    command.add_argument(
        "--max-parallel-parents",
        type=int,
        help="覆盖 COLD_START_MAX_PARALLEL_PARENT_INTEGRATIONS",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cold-start",
        description="把单份协会手册 PDF 编译为候选长期记忆图",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    run = subparsers.add_parser("run", help="从单个 PDF 运行完整冷启动流程")
    _add_pdf_arguments(run)
    _add_model_arguments(run)
    _add_compilation_parallel_arguments(run)

    explore = subparsers.add_parser("explore", help="运行单 PDF 全局勘探")
    _add_pdf_arguments(explore)
    _add_model_arguments(explore)

    compile_leaves = subparsers.add_parser(
        "compile-leaves",
        help="把已有区域树的内容叶子编译为局部候选子图",
    )
    compile_leaves.add_argument(
        "--run",
        type=Path,
        required=True,
        help="包含 global-exploration.json 的勘探运行目录",
    )
    _add_model_arguments(compile_leaves)
    compile_leaves.add_argument(
        "--max-parallel-leaves",
        type=int,
        help="覆盖 COLD_START_MAX_PARALLEL_COMPILATIONS",
    )

    integrate_parents = subparsers.add_parser(
        "integrate-parents",
        help="从叶子向根节点逐层整合候选记忆子图",
    )
    integrate_parents.add_argument(
        "--compilation",
        type=Path,
        required=True,
        help="包含 leaf-compilation.json 的叶子编译目录",
    )
    _add_model_arguments(integrate_parents)
    integrate_parents.add_argument(
        "--max-parallel-parents",
        type=int,
        help="覆盖 COLD_START_MAX_PARALLEL_PARENT_INTEGRATIONS",
    )

    import_db = subparsers.add_parser(
        "import-db",
        help="把父节点整合结果作为草稿写入记忆层数据库",
    )
    import_db.add_argument(
        "--integration",
        type=Path,
        required=True,
        help="parent-integration.json 文件或其所在目录",
    )
    import_db.add_argument(
        "--env-file",
        type=Path,
        help="显式指定环境文件；不指定时从当前目录向上查找 .env",
    )
    return parser


def _report_environment(
    args: argparse.Namespace,
    progress: ConsoleProgressReporter,
) -> None:
    environment_file = load_environment_file(args.env_file)
    if environment_file:
        progress.report("环境", f"已加载 {environment_file}（不覆盖系统环境变量）")
    else:
        progress.report("环境", "未找到 .env，使用系统环境变量和命令行参数")


async def _execute_explore(
    args: argparse.Namespace,
    progress: ConsoleProgressReporter,
) -> tuple[Path, bool]:
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
            f"最多尝试 {model_settings.max_retries} 次；"
            f"区域树并发上限 {exploration_settings.max_parallel_regions}"
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
    return paths.run_directory, snapshot.region_tree.status == "frozen"


async def _run_explore(args: argparse.Namespace) -> int:
    progress = ConsoleProgressReporter()
    _report_environment(args, progress)
    await _execute_explore(args, progress)
    return 0


async def _execute_compile_leaves(
    args: argparse.Namespace,
    progress: ConsoleProgressReporter,
    run_directory: Path,
) -> tuple[Path, bool]:
    model_settings = ModelSettings.from_environment(
        model=args.model,
        api_base_url=args.api_base_url,
        api_key=args.api_key,
        read_timeout_seconds=args.read_timeout_seconds,
        max_retries=args.max_model_retries,
    )
    compilation_settings = CompilationSettings.from_environment(
        max_parallel_leaves=args.max_parallel_leaves,
    )
    exploration, blocks = load_exploration_inputs(run_directory)
    paths = create_compilation_directory(run_directory)
    progress.report(
        "模型",
        (
            f"使用模型 {model_settings.model}，接口 {model_settings.api_base_url}；"
            f"纯流式，读取超时 {model_settings.read_timeout_seconds:g} 秒，"
            f"最多尝试 {model_settings.max_retries} 次；"
            f"叶子编译并发上限 {compilation_settings.max_parallel_leaves}"
        ),
    )
    progress.report("产物", f"已创建叶子编译目录 {paths.directory}")
    progress.report("模型", f"模型输入、正文和思考将实时保存到 {paths.model_streams}")

    model = OpenAICompatibleChatModel(
        model_settings,
        progress=progress,
        trace_directory=paths.model_streams,
        show_model_stream=args.show_model_stream,
    )
    try:
        snapshot = await LeafCompilationRunner(
            model=model,
            exploration=exploration,
            blocks=blocks,
            settings=compilation_settings,
            progress=progress,
            checkpoint=lambda current: write_compilation_checkpoint(paths, current),
        ).run()
    finally:
        await model.aclose()

    write_compilation_artifacts(
        paths=paths,
        snapshot=snapshot,
        blocks=blocks,
    )
    progress.report("完成", f"叶子编译产物：{paths.directory}")
    return paths.directory, snapshot.status == "complete"


async def _run_compile_leaves(args: argparse.Namespace) -> int:
    progress = ConsoleProgressReporter()
    _report_environment(args, progress)
    _, complete = await _execute_compile_leaves(args, progress, args.run)
    return 0 if complete else 2


async def _execute_integrate_parents(
    args: argparse.Namespace,
    progress: ConsoleProgressReporter,
    compilation_directory: Path,
) -> tuple[Path, bool]:
    model_settings = ModelSettings.from_environment(
        model=args.model,
        api_base_url=args.api_base_url,
        api_key=args.api_key,
        read_timeout_seconds=args.read_timeout_seconds,
        max_retries=args.max_model_retries,
    )
    compilation_settings = CompilationSettings.from_environment(
        max_parallel_parents=args.max_parallel_parents,
    )
    exploration, leaf_compilation, blocks = load_parent_integration_inputs(
        compilation_directory
    )
    paths = create_parent_integration_directory(compilation_directory)
    progress.report(
        "模型",
        (
            f"使用模型 {model_settings.model}，接口 {model_settings.api_base_url}；"
            f"纯流式，读取超时 {model_settings.read_timeout_seconds:g} 秒，"
            f"最多尝试 {model_settings.max_retries} 次；"
            f"父节点整合并发上限 {compilation_settings.max_parallel_parents}"
        ),
    )
    progress.report("产物", f"已创建父节点整合目录 {paths.directory}")
    progress.report("模型", f"模型输入、正文和思考将实时保存到 {paths.model_streams}")

    model = OpenAICompatibleChatModel(
        model_settings,
        progress=progress,
        trace_directory=paths.model_streams,
        show_model_stream=args.show_model_stream,
    )
    try:
        snapshot = await ParentIntegrationRunner(
            model=model,
            exploration=exploration,
            leaf_compilation=leaf_compilation,
            blocks=blocks,
            settings=compilation_settings,
            progress=progress,
            checkpoint=lambda current: write_parent_integration_checkpoint(
                paths,
                current,
            ),
        ).run()
    finally:
        await model.aclose()

    write_parent_integration_artifacts(paths=paths, snapshot=snapshot)
    progress.report("完成", f"父节点整合产物：{paths.directory}")
    return paths.directory, snapshot.status == "complete"


async def _run_integrate_parents(args: argparse.Namespace) -> int:
    progress = ConsoleProgressReporter()
    _report_environment(args, progress)
    _, complete = await _execute_integrate_parents(
        args,
        progress,
        args.compilation,
    )
    return 0 if complete else 2


def _repository_root() -> Path:
    for directory in Path(__file__).resolve().parents:
        if (directory / "package.json").is_file() and (
            directory / "prisma" / "import-cold-start.ts"
        ).is_file():
            return directory
    raise FileNotFoundError("无法定位包含数据库导入模块的仓库根目录")


def _integration_json(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    return resolved / "parent-integration.json" if resolved.is_dir() else resolved


async def _execute_database_import(
    integration: Path,
    progress: ConsoleProgressReporter,
) -> Path:
    input_path = _integration_json(integration)
    if not input_path.is_file():
        raise FileNotFoundError(f"父节点整合文件不存在：{input_path}")
    pnpm = shutil.which("pnpm")
    if pnpm is None:
        raise FileNotFoundError("找不到 pnpm，无法运行 Prisma 数据库导入模块")
    repository_root = _repository_root()
    progress.report("数据库", f"开始导入 {input_path}")
    process = await asyncio.create_subprocess_exec(
        pnpm,
        "run",
        "memory:import-cold-start",
        "--input",
        str(input_path),
        cwd=repository_root,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    assert process.stdout is not None
    async for raw_line in process.stdout:
        line = raw_line.decode(errors="replace").rstrip()
        if line:
            progress.report("数据库", line)
    return_code = await process.wait()
    if return_code != 0:
        raise RuntimeError(f"数据库导入进程退出状态为 {return_code}")
    report = input_path.parent / "database-import.json"
    if not report.is_file():
        raise RuntimeError("数据库事务已结束，但没有生成 database-import.json")
    return report


async def _run_import_db(args: argparse.Namespace) -> int:
    progress = ConsoleProgressReporter()
    _report_environment(args, progress)
    report = await _execute_database_import(args.integration, progress)
    progress.report("完成", f"数据库导入报告：{report}")
    return 0


def _duration(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.1f} 秒"
    return f"{seconds / 60:.1f} 分钟（{seconds:.1f} 秒）"


async def _run_pipeline(args: argparse.Namespace) -> int:
    progress = ConsoleProgressReporter()
    _report_environment(args, progress)
    total_started = time.perf_counter()

    stage_started = time.perf_counter()
    progress.report("全流程", "开始阶段 1/4：全局勘探")
    run_directory, exploration_complete = await _execute_explore(args, progress)
    progress.report(
        "全流程",
        f"阶段 1/4 结束，耗时 {_duration(time.perf_counter() - stage_started)}",
    )
    if not exploration_complete:
        progress.report(
            "全流程",
            f"区域树尚未冻结，停止后续阶段；已有产物：{run_directory}",
        )
        return 2

    stage_started = time.perf_counter()
    progress.report("全流程", "开始阶段 2/4：内容叶子编译")
    compilation_directory, compilation_complete = await _execute_compile_leaves(
        args,
        progress,
        run_directory,
    )
    progress.report(
        "全流程",
        f"阶段 2/4 结束，耗时 {_duration(time.perf_counter() - stage_started)}",
    )
    if not compilation_complete:
        progress.report(
            "全流程",
            f"叶子编译未全部成功，停止父节点整合；已有产物：{compilation_directory}",
        )
        return 2

    stage_started = time.perf_counter()
    progress.report("全流程", "开始阶段 3/4：父节点逐层整合")
    integration_directory, integration_complete = await _execute_integrate_parents(
        args,
        progress,
        compilation_directory,
    )
    progress.report(
        "全流程",
        f"阶段 3/4 结束，耗时 {_duration(time.perf_counter() - stage_started)}",
    )
    total_elapsed = time.perf_counter() - total_started
    if not integration_complete:
        progress.report(
            "全流程",
            (
                f"父节点整合未全部成功，总耗时 {_duration(total_elapsed)}；"
                f"已有产物：{integration_directory}"
            ),
        )
        return 2

    stage_started = time.perf_counter()
    progress.report("全流程", "开始阶段 4/4：写入记忆层数据库")
    import_report = await _execute_database_import(integration_directory, progress)
    progress.report(
        "全流程",
        f"阶段 4/4 结束，耗时 {_duration(time.perf_counter() - stage_started)}",
    )
    total_elapsed = time.perf_counter() - total_started
    progress.report(
        "全流程",
        (
            f"全部完成，总耗时 {_duration(total_elapsed)}；"
            f"数据库导入报告：{import_report}"
        ),
    )
    return 0


def main() -> None:
    args = build_parser().parse_args()
    try:
        if args.command == "run":
            raise SystemExit(asyncio.run(_run_pipeline(args)))
        if args.command == "explore":
            raise SystemExit(asyncio.run(_run_explore(args)))
        if args.command == "compile-leaves":
            raise SystemExit(asyncio.run(_run_compile_leaves(args)))
        if args.command == "integrate-parents":
            raise SystemExit(asyncio.run(_run_integrate_parents(args)))
        if args.command == "import-db":
            raise SystemExit(asyncio.run(_run_import_db(args)))
    except KeyboardInterrupt:
        print("任务已取消。", file=sys.stderr)
        raise SystemExit(130) from None
    except Exception as error:
        print(f"冷启动任务失败：{error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
