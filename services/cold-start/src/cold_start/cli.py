"""冷启动 worker 命令行入口。"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from cold_start.activity_view import (
    ActivityPerspectiveRunner,
    create_activity_view_paths,
    load_activity_view_inputs,
    open_activity_view_paths,
)
from cold_start.compilation import (
    FullBasicCompilationRunner,
    LeafBasicCompiler,
    create_full_artifact_paths,
    create_leaf_artifact_paths,
    load_exploration_inputs,
    open_full_artifact_paths,
    write_leaf_artifact,
)
from cold_start.compilation.source_semantics import (
    FullSourceSemanticRunner,
    SourceSemanticCompiler,
    create_full_source_semantic_paths,
    create_source_semantic_paths,
    open_full_source_semantic_paths,
    open_source_semantic_paths,
)
from cold_start.config import (
    ActivityViewSettings,
    CompilationSettings,
    ExplorationSettings,
    ModelSettings,
)
from cold_start.document import MinerUPdfLoader
from cold_start.embedding_server import serve_embeddings
from cold_start.environment import load_environment_file
from cold_start.global_exploration import (
    GlobalExplorationRunner,
    create_exploration_run_directory,
    write_exploration_artifacts,
    write_parsing_artifacts,
)
from cold_start.global_resolution import (
    GlobalObjectCandidateRetriever,
    GlobalObjectResolverRunner,
    create_global_resolution_paths,
    finalize_existing_global_resolution,
    initial_registry,
    load_source_compilation,
    load_working_registry,
    open_global_resolution_paths,
    write_working_registry,
)
from cold_start.llm import OpenAICompatibleChatModel
from cold_start.progress import ConsoleProgressReporter
from cold_start.region_tree.runtime import BgeM3Embedder


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
        "--requests-per-minute",
        type=int,
        help="覆盖 AI_REQUESTS_PER_MINUTE，限制整个进程每分钟发起的模型请求数",
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
        help=("本地 BGE-M3 目录或 Hugging Face 模型名；覆盖 COLD_START_EMBEDDING_MODEL"),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cold-start",
        description="解析单份协会手册 PDF 并建立连续原文区域树",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    explore = subparsers.add_parser("explore", help="运行单 PDF 全局勘探")
    _add_pdf_arguments(explore)
    _add_model_arguments(explore)

    compile_leaf = subparsers.add_parser(
        "compile-leaf",
        help="完整提取一个内容叶子的对象、叙述和依据",
    )
    compile_leaf.add_argument(
        "--run",
        type=Path,
        required=True,
        help="包含 global-exploration.json 的勘探运行目录",
    )
    compile_leaf.add_argument(
        "--leaf-id",
        required=True,
        help="需要编译的内容叶子节点 ID，例如 region-0063",
    )
    _add_model_arguments(compile_leaf)

    compile_full = subparsers.add_parser(
        "compile",
        help="从全部内容来源节点逐层编译到区域树根节点",
    )
    compile_full.add_argument(
        "--run",
        type=Path,
        required=True,
        help="包含 global-exploration.json 的勘探运行目录",
    )
    compile_full.add_argument(
        "--max-parallel-sources",
        type=int,
        help="覆盖 COLD_START_MAX_PARALLEL_COMPILATIONS",
    )
    compile_full.add_argument(
        "--resume",
        type=Path,
        help="继续已有的未完成完整基础编译目录，复用已写入 sources 的结果",
    )
    compile_full.add_argument(
        "--max-parallel-parents",
        type=int,
        help="覆盖 COLD_START_MAX_PARALLEL_PARENT_INTEGRATIONS",
    )
    _add_model_arguments(compile_full)

    compile_source = subparsers.add_parser(
        "compile-source",
        help="分四遍编译一个来源节点的 Atomic 语义、Object Fragment 和时间标注",
    )
    compile_source.add_argument(
        "--run",
        type=Path,
        required=True,
        help="包含 global-exploration.json 的勘探运行目录",
    )
    compile_source.add_argument(
        "--source-id",
        required=True,
        help="拥有 content_source 自有原文的节点 ID，例如 region-0063",
    )
    compile_source.add_argument(
        "--resume",
        type=Path,
        help="继续已有来源语义编译目录，复用已经成功写入的阶段断点",
    )
    _add_model_arguments(compile_source)

    compile_sources = subparsers.add_parser(
        "compile-sources",
        help="并行编译区域树中的全部内容来源，逐阶段保存断点",
    )
    compile_sources.add_argument(
        "--run",
        type=Path,
        required=True,
        help="包含 global-exploration.json 的勘探运行目录",
    )
    compile_sources.add_argument(
        "--max-parallel-sources",
        type=int,
        help="覆盖 COLD_START_MAX_PARALLEL_COMPILATIONS",
    )
    compile_sources.add_argument(
        "--source-id",
        action="append",
        help=("只编译指定 content_source 节点；可重复传入，不传时编译全部来源"),
    )
    compile_sources.add_argument(
        "--resume",
        type=Path,
        help="继续已有全部来源语义编译目录，按来源和阶段复用断点",
    )
    _add_model_arguments(compile_sources)

    resolve_objects = subparsers.add_parser(
        "resolve-objects",
        help="按 SourceRegion 把本地 ObjectFragment 解析为 Global Object Registry",
    )
    resolve_objects.add_argument(
        "--compilation",
        type=Path,
        required=True,
        help="完整来源语义目录或 source-semantics-full.json",
    )
    resolve_objects.add_argument(
        "--resume",
        type=Path,
        help="继续已有 Global Resolution 目录中的 working.json",
    )
    resolve_objects.add_argument(
        "--embedding-model",
        help="本地 BGE-M3 目录或 Hugging Face 模型名",
    )
    resolve_objects.add_argument(
        "--no-bge",
        action="store_true",
        help="只使用词面召回；仍由模型判断 identity",
    )
    resolve_objects.add_argument(
        "--candidate-limit",
        type=int,
        default=8,
        help="每个 incoming Fragment 最多提交给模型的普通候选数；精确词面候选强制保留",
    )
    resolve_objects.add_argument(
        "--stop-after",
        type=int,
        help="本次最多继续处理多少个 SourceRegion；用于人工小批量验证",
    )
    _add_model_arguments(resolve_objects)

    finalize_assertions = subparsers.add_parser(
        "finalize-assertions",
        help="把已完成 Global Resolution 物化为只引用 Global Object 的 Assertions",
    )
    finalize_assertions.add_argument(
        "--resolution",
        type=Path,
        required=True,
        help="已完成的 Global Resolution 目录或 global-resolution.json",
    )

    map_activity = subparsers.add_parser(
        "map-activity",
        help="把完整基础编译映射为隔离的活动运营视角草稿",
    )
    map_activity.add_argument(
        "--compilation",
        type=Path,
        required=True,
        help="完整基础编译目录或其中的 basic-compilation.json",
    )
    map_activity.add_argument(
        "--max-parallel-groups",
        type=int,
        help="覆盖 COLD_START_MAX_PARALLEL_PERSPECTIVE_GROUPS",
    )
    map_activity.add_argument(
        "--resume",
        type=Path,
        help="继续未完成的活动视角草稿目录，复用已校验通过的分组结果",
    )
    _add_model_arguments(map_activity)

    embedding_server = subparsers.add_parser(
        "serve-embeddings",
        help="启动供离线索引和在线搜索复用的常驻 BGE-M3 服务",
    )
    embedding_server.add_argument("--host", default="127.0.0.1")
    embedding_server.add_argument("--port", type=int, default=8765)
    embedding_server.add_argument(
        "--embedding-model",
        help="本地 BGE-M3 目录或 Hugging Face 模型名",
    )
    embedding_server.add_argument(
        "--model-revision",
        help="写入数据库和 Locate Trace 的模型修订标识",
    )
    embedding_server.add_argument(
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
        requests_per_minute=args.requests_per_minute,
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
            f"全局 RPM {model_settings.requests_per_minute}；"
            f"区域树并发上限 {exploration_settings.max_parallel_regions}"
        ),
    )

    run_directory = create_exploration_run_directory(
        output_root=args.output,
        source_path=args.pdf,
    )
    model_stream_directory = run_directory / "model-streams"
    progress.report("产物", f"已创建运行目录 {run_directory}")

    pdf_loader = MinerUPdfLoader(progress=lambda message: progress.report("PDF", message))
    progress.report(
        "PDF",
        (
            f"开始解析 {args.pdf}；{pdf_loader.parser_name}，"
            f"计算设备 {pdf_loader.accelerator_description()}"
        ),
    )
    document = await asyncio.to_thread(
        pdf_loader.load,
        args.pdf,
        raw_output_directory=run_directory / "mineru-raw",
    )
    nonempty_pages = sum(bool(page.markdown.strip()) for page in document.pages)
    progress.report(
        "PDF",
        (
            f"解析完成：{nonempty_pages}/{document.page_count} 页非空，"
            f"全文 {len(document.markdown)} 字符，{len(document.blocks)} 个稳定块；"
            f"{document.parser_name}"
        ),
    )
    parsing_paths = write_parsing_artifacts(
        run_directory=run_directory,
        document=document,
    )
    progress.report(
        "产物",
        f"PDF 解析产物已提前写入 {parsing_paths.parsed_document_markdown}",
    )
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


async def _run_compile_leaf(args: argparse.Namespace) -> int:
    progress = ConsoleProgressReporter()
    _report_environment(args, progress)
    model_settings = ModelSettings.from_environment(
        model=args.model,
        api_base_url=args.api_base_url,
        api_key=args.api_key,
        read_timeout_seconds=args.read_timeout_seconds,
        max_retries=args.max_model_retries,
        requests_per_minute=args.requests_per_minute,
    )
    exploration, blocks = load_exploration_inputs(args.run)
    paths = create_leaf_artifact_paths(args.run, args.leaf_id)
    progress.report(
        "模型",
        (
            f"使用模型 {model_settings.model}，接口 {model_settings.api_base_url}；"
            f"全局 RPM {model_settings.requests_per_minute}；"
            "提取、覆盖复核和校验修复均启用思考并返回正文 JSON"
        ),
    )
    progress.report("产物", f"已创建单叶子编译目录 {paths.directory}")
    progress.report("模型", f"模型输入、正文和思考将实时保存到 {paths.model_streams}")
    model = OpenAICompatibleChatModel(
        model_settings,
        progress=progress,
        trace_directory=paths.model_streams,
        show_model_stream=args.show_model_stream,
    )
    try:
        artifact = await LeafBasicCompiler(
            model=model,
            exploration=exploration,
            blocks=blocks,
            progress=progress,
        ).compile(args.leaf_id)
    finally:
        await model.aclose()
    write_leaf_artifact(paths, artifact, blocks)
    progress.report("完成", f"基础编译产物：{paths.directory}")
    return 0


async def _run_compile_full(args: argparse.Namespace) -> int:
    progress = ConsoleProgressReporter()
    _report_environment(args, progress)
    model_settings = ModelSettings.from_environment(
        model=args.model,
        api_base_url=args.api_base_url,
        api_key=args.api_key,
        read_timeout_seconds=args.read_timeout_seconds,
        max_retries=args.max_model_retries,
        requests_per_minute=args.requests_per_minute,
    )
    compilation_settings = CompilationSettings.from_environment(
        max_parallel_sources=args.max_parallel_sources,
        max_parallel_parents=args.max_parallel_parents,
    )
    exploration, blocks = load_exploration_inputs(args.run)
    paths = (
        open_full_artifact_paths(args.resume)
        if args.resume
        else create_full_artifact_paths(args.run)
    )
    progress.report(
        "模型",
        (
            f"使用模型 {model_settings.model}，接口 {model_settings.api_base_url}；"
            f"全局 RPM {model_settings.requests_per_minute}；"
            "来源提取、覆盖复核、父节点整合和校验修复均启用思考并返回正文 JSON"
        ),
    )
    progress.report(
        "产物",
        (
            f"继续完整基础编译目录 {paths.directory}"
            if args.resume
            else f"已创建完整基础编译目录 {paths.directory}"
        ),
    )
    progress.report("模型", f"模型输入、正文和思考将实时保存到 {paths.model_streams}")
    model = OpenAICompatibleChatModel(
        model_settings,
        progress=progress,
        trace_directory=paths.model_streams,
        show_model_stream=args.show_model_stream,
    )
    try:
        await FullBasicCompilationRunner(
            model=model,
            exploration=exploration,
            blocks=blocks,
            paths=paths,
            settings=compilation_settings,
            progress=progress,
        ).run()
    finally:
        await model.aclose()
    progress.report("完成", f"完整基础编译产物：{paths.directory}")
    return 0


async def _run_compile_source(args: argparse.Namespace) -> int:
    progress = ConsoleProgressReporter()
    _report_environment(args, progress)
    model_settings = ModelSettings.from_environment(
        model=args.model,
        api_base_url=args.api_base_url,
        api_key=args.api_key,
        read_timeout_seconds=args.read_timeout_seconds,
        max_retries=args.max_model_retries,
        requests_per_minute=args.requests_per_minute,
    )
    exploration, blocks = load_exploration_inputs(args.run)
    paths = (
        open_source_semantic_paths(args.resume)
        if args.resume
        else create_source_semantic_paths(args.run, args.source_id)
    )
    progress.report(
        "模型",
        (
            f"使用模型 {model_settings.model}，接口 {model_settings.api_base_url}；"
            f"全局 RPM {model_settings.requests_per_minute}；"
            "Atomic 来源语义、遗漏扫描、Object Fragment Construction 和时间标注"
            "分别调用模型；Atomic naming hints 在 Fragment Construction 中作为硬分组提示"
        ),
    )
    progress.report(
        "产物",
        (
            f"继续来源语义编译目录 {paths.directory}"
            if args.resume
            else f"已创建来源语义编译目录 {paths.directory}"
        ),
    )
    progress.report("模型", f"模型输入、正文和思考将实时保存到 {paths.model_streams}")
    model = OpenAICompatibleChatModel(
        model_settings,
        progress=progress,
        trace_directory=paths.model_streams,
        show_model_stream=args.show_model_stream,
    )
    try:
        await SourceSemanticCompiler(
            model=model,
            exploration=exploration,
            blocks=blocks,
            paths=paths,
            progress=progress,
        ).compile(args.source_id)
    finally:
        await model.aclose()
    progress.report("完成", f"来源语义编译产物：{paths.directory}")
    return 0


async def _run_compile_sources(args: argparse.Namespace) -> int:
    progress = ConsoleProgressReporter()
    _report_environment(args, progress)
    model_settings = ModelSettings.from_environment(
        model=args.model,
        api_base_url=args.api_base_url,
        api_key=args.api_key,
        read_timeout_seconds=args.read_timeout_seconds,
        max_retries=args.max_model_retries,
        requests_per_minute=args.requests_per_minute,
    )
    compilation_settings = CompilationSettings.from_environment(
        max_parallel_sources=args.max_parallel_sources,
    )
    exploration, blocks = load_exploration_inputs(args.run)
    paths = (
        open_full_source_semantic_paths(args.resume)
        if args.resume
        else create_full_source_semantic_paths(args.run)
    )
    progress.report(
        "模型",
        (
            f"使用模型 {model_settings.model}，接口 {model_settings.api_base_url}；"
            f"全局 RPM {model_settings.requests_per_minute}；"
            f"来源并发 {compilation_settings.max_parallel_sources}；"
            "每个来源依次执行 Atomic 来源语义、遗漏扫描、Object Fragment Construction "
            "和时间标注；Atomic naming hints 在 Fragment Construction 中作为硬分组提示"
        ),
    )
    progress.report(
        "产物",
        (
            f"继续全部来源语义编译目录 {paths.directory}"
            if args.resume
            else f"已创建全部来源语义编译目录 {paths.directory}"
        ),
    )
    progress.report("模型", f"模型输入、工具参数和思考将实时保存到 {paths.model_streams}")
    model = OpenAICompatibleChatModel(
        model_settings,
        progress=progress,
        trace_directory=paths.model_streams,
        show_model_stream=args.show_model_stream,
    )
    try:
        await FullSourceSemanticRunner(
            model=model,
            exploration=exploration,
            blocks=blocks,
            paths=paths,
            max_parallel_sources=compilation_settings.max_parallel_sources,
            source_node_ids=args.source_id,
            progress=progress,
        ).run()
    finally:
        await model.aclose()
    progress.report("完成", f"全部来源语义编译产物：{paths.directory}")
    return 0


async def _run_map_activity(args: argparse.Namespace) -> int:
    progress = ConsoleProgressReporter()
    _report_environment(args, progress)
    model_settings = ModelSettings.from_environment(
        model=args.model,
        api_base_url=args.api_base_url,
        api_key=args.api_key,
        read_timeout_seconds=args.read_timeout_seconds,
        max_retries=args.max_model_retries,
        requests_per_minute=args.requests_per_minute,
    )
    view_settings = ActivityViewSettings.from_environment(
        max_parallel_groups=args.max_parallel_groups,
    )
    source_path, compilation, exploration, blocks = load_activity_view_inputs(args.compilation)
    paths = (
        open_activity_view_paths(args.resume)
        if args.resume
        else create_activity_view_paths(args.compilation)
    )
    progress.report(
        "模型",
        (
            f"使用模型 {model_settings.model}，接口 {model_settings.api_base_url}；"
            f"全局 RPM {model_settings.requests_per_minute}；"
            f"父级语义分组并发上限 {view_settings.max_parallel_groups}；"
            "全部业务判断和协议修复启用思考"
        ),
    )
    progress.report(
        "视角",
        (
            "先规划全局语义边界，再做局部 Assertion 高召回投影与 Object 二次校正；"
            "对象三态确定后由父节点恢复跨孩子关系，四条线路全局复核，"
            f"并最多进行 {view_settings.max_review_rounds} 轮定向修复；"
            "Object 可成为视角卡、支撑引用或视角外对象；"
            "本阶段不重新读取原文，也不使用 BGE-M3 补造关系"
        ),
    )
    progress.report(
        "产物",
        (
            f"继续活动运营视角草稿目录 {paths.directory}"
            if args.resume
            else f"已创建活动运营视角草稿目录 {paths.directory}"
        ),
    )
    progress.report("模型", f"模型输入、正文和思考将实时保存到 {paths.model_streams}")
    model = OpenAICompatibleChatModel(
        model_settings,
        progress=progress,
        trace_directory=paths.model_streams,
        show_model_stream=args.show_model_stream,
    )
    try:
        await ActivityPerspectiveRunner(
            model=model,
            source_compilation_path=source_path,
            compilation=compilation,
            exploration=exploration,
            blocks=blocks,
            paths=paths,
            settings=view_settings,
            progress=progress,
        ).run()
    finally:
        await model.aclose()
    progress.report("完成", f"活动运营视角草稿：{paths.directory}")
    return 0


async def _run_resolve_objects(args: argparse.Namespace) -> int:
    progress = ConsoleProgressReporter()
    _report_environment(args, progress)
    if args.candidate_limit < 1:
        raise ValueError("candidate-limit 必须大于 0")
    if args.stop_after is not None and args.stop_after < 1:
        raise ValueError("stop-after 必须大于 0")
    model_settings = ModelSettings.from_environment(
        model=args.model,
        api_base_url=args.api_base_url,
        api_key=args.api_key,
        read_timeout_seconds=args.read_timeout_seconds,
        max_retries=args.max_model_retries,
        requests_per_minute=args.requests_per_minute,
    )
    exploration_settings = ExplorationSettings.from_environment(
        embedding_model=args.embedding_model,
    )
    dataset = load_source_compilation(args.compilation)
    paths = (
        open_global_resolution_paths(args.resume)
        if args.resume
        else create_global_resolution_paths(dataset.directory)
    )
    state = load_working_registry(paths, dataset) if args.resume else initial_registry(dataset)
    if not args.resume:
        write_working_registry(paths, dataset, state)
    progress.report(
        "产物",
        (
            f"继续 Global Resolution 目录 {paths.directory}"
            if args.resume
            else f"已创建 Global Resolution 目录 {paths.directory}"
        ),
    )
    progress.report("模型", f"模型输入、原始 SSE、正文和思考将实时保存到 {paths.model_streams}")
    progress.report(
        "全局对象",
        (
            f"Source {dataset.source_sha256[:12]}；"
            f"从 Region {state.next_source_region_ordinal}/{len(dataset.regions)} 继续；"
            f"每 Fragment 候选上限 {args.candidate_limit}；"
            + (
                "词面召回"
                if args.no_bge
                else f"词面 + BGE-M3（{exploration_settings.embedding_model}）召回"
            )
        ),
    )
    embedder = (
        None if args.no_bge else BgeM3Embedder(exploration_settings.embedding_model, progress)
    )
    model = OpenAICompatibleChatModel(
        model_settings,
        progress=progress,
        trace_directory=paths.model_streams,
        show_model_stream=args.show_model_stream,
    )
    try:
        state = await GlobalObjectResolverRunner(
            model=model,
            dataset=dataset,
            paths=paths,
            state=state,
            retriever=GlobalObjectCandidateRetriever(
                embedder=embedder,
                candidate_limit=args.candidate_limit,
            ),
            progress=progress,
        ).run_all(stop_after=args.stop_after)
    finally:
        await model.aclose()
    if state.next_source_region_ordinal < len(dataset.regions):
        progress.report(
            "暂停",
            f"已处理 {state.next_source_region_ordinal}/{len(dataset.regions)} 个 SourceRegion；"
            f"使用 --resume {paths.directory} 继续",
        )
    else:
        progress.report(
            "完成",
            f"Global Resolution：{len(state.objects)} 个 Object；{paths.artifact_json}",
        )
    return 0


def _run_finalize_assertions(args: argparse.Namespace) -> int:
    output, artifact = finalize_existing_global_resolution(args.resolution)
    print(
        f"Global Assertions 已完成：{artifact.total_assertions} 条 Assertion，"
        f"{artifact.total_source_reference_atoms} 个来源 reference atom，"
        f"新增 {artifact.total_literal_reference_atoms} 个字符串 reference atom；{output}"
    )
    return 0


def main() -> None:
    args = build_parser().parse_args()
    try:
        if args.command == "serve-embeddings":
            _report_environment(args, ConsoleProgressReporter())
            settings = ExplorationSettings.from_environment(
                embedding_model=args.embedding_model,
            )
            serve_embeddings(
                host=args.host,
                port=args.port,
                model_name=settings.embedding_model,
                model_revision=(
                    args.model_revision
                    or os.getenv("COLD_START_EMBEDDING_MODEL_REVISION")
                    or "local"
                ),
            )
            return
        if args.command == "explore":
            raise SystemExit(asyncio.run(_run_explore(args)))
        if args.command == "compile-leaf":
            raise SystemExit(asyncio.run(_run_compile_leaf(args)))
        if args.command == "compile":
            raise SystemExit(asyncio.run(_run_compile_full(args)))
        if args.command == "compile-source":
            raise SystemExit(asyncio.run(_run_compile_source(args)))
        if args.command == "compile-sources":
            raise SystemExit(asyncio.run(_run_compile_sources(args)))
        if args.command == "resolve-objects":
            raise SystemExit(asyncio.run(_run_resolve_objects(args)))
        if args.command == "finalize-assertions":
            raise SystemExit(_run_finalize_assertions(args))
        if args.command == "map-activity":
            raise SystemExit(asyncio.run(_run_map_activity(args)))
    except KeyboardInterrupt:
        print("任务已取消。", file=sys.stderr)
        raise SystemExit(130) from None
    except Exception as error:
        print(f"冷启动任务失败：{error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
