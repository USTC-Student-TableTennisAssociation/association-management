from __future__ import annotations

import argparse
import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

import cold_start.cli as cli
from cold_start.document.blocks import build_document_blocks
from cold_start.document.models import ParsedDocument, ParsedPage
from cold_start.llm.base import ModelTurn, ThinkingMode


class FakeDocumentLoader:
    parser_name = "fake"

    def __init__(self, *, progress=None) -> None:
        self.progress = progress

    @staticmethod
    def accelerator_description() -> str:
        return "fake-device"

    def load(
        self,
        source_path: Path,
        *,
        raw_output_directory: Path,
    ) -> ParsedDocument:
        raw_output_directory.mkdir()
        pages = (ParsedPage(page_number=1, markdown="# 测试手册\n正文"),)
        return ParsedDocument(
            source_path=source_path.resolve(),
            title="测试手册",
            file_sha256="d" * 64,
            parser_name="fake",
            pages=pages,
            blocks=build_document_blocks(pages),
            markdown="# 测试手册\n正文",
        )


class FakeChatModel:
    def __init__(
        self,
        settings,
        *,
        progress,
        trace_directory: Path,
        show_model_stream: bool,
    ) -> None:
        self.settings = settings
        self.progress = progress
        self.trace_directory = trace_directory
        self.show_model_stream = show_model_stream
        assert (trace_directory.parent / "parsed-document.md").exists()

    async def complete(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.0,
        request_label: str = "模型",
    ) -> str:
        del system_prompt, temperature, request_label
        if "[ROUTE: document_context]" in user_prompt:
            return "这是一份测试手册。"
        raise AssertionError("出现未预期的模型调用")

    async def complete_turn(
        self,
        *,
        messages: Sequence[Mapping[str, Any]],
        tools: Sequence[Mapping[str, Any]] = (),
        tool_choice: object | None = None,
        temperature: float = 0.0,
        request_label: str = "模型",
        thinking: ThinkingMode | None = None,
    ) -> ModelTurn:
        del tools, tool_choice, temperature, request_label, thinking
        prompt = str(messages[-1]["content"])
        if "[STAGE: region_tree_root]" in prompt:
            return ModelTurn(
                content=json.dumps(
                    {
                        "action": "stop",
                        "owned_source_role": "content_source",
                        "introduction": "一页测试手册。",
                        "reason": "内容无需继续分区。",
                    },
                    ensure_ascii=False,
                )
            )
        raise AssertionError("出现未预期的区域模型调用")

    async def aclose(self) -> None:
        return None


@pytest.mark.asyncio
async def test_cli_auto_loads_env_and_prints_detailed_progress(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    working_directory = tmp_path / "services" / "cold-start"
    working_directory.mkdir(parents=True)
    (tmp_path / ".env").write_text(
        ("AI_MODEL=fake-model\nAI_API_BASE_URL=http://model.test/v1\nAI_API_KEY=fake-key\n"),
        encoding="utf-8",
    )
    for variable in ("AI_MODEL", "AI_API_BASE_URL", "AI_API_KEY"):
        monkeypatch.delenv(variable, raising=False)
    monkeypatch.chdir(working_directory)
    (working_directory / "handbook.pdf").write_bytes(b"pdf")
    monkeypatch.setattr(cli, "MinerUDocumentLoader", FakeDocumentLoader)
    monkeypatch.setattr(cli, "OpenAICompatibleChatModel", FakeChatModel)

    result = await cli._run_explore(
        argparse.Namespace(
            source=Path("handbook.pdf"),
            output=tmp_path / "runs",
            model=None,
            api_base_url=None,
            api_key=None,
            env_file=None,
            read_timeout_seconds=None,
            max_model_retries=None,
            requests_per_minute=None,
            show_model_stream=False,
            embedding_model="fake-bge-m3",
        )
    )

    output = capsys.readouterr().out
    assert result == 0
    assert f"已加载 {tmp_path / '.env'}" in output
    assert "[规划] 文档背景 1 个阅读单元" in output
    assert "[文档上下文] 开始 1/1" in output
    assert "[区域树·根节点] 完成判断" in output
    assert "[汇总] 区域树状态 frozen" in output
    assert "[完成] 全局勘探产物" in output
    assert "PDF 解析产物已提前写入" in output
    assert list((tmp_path / "runs").glob("*/global-exploration.json"))


def test_cli_exposes_mineru_only_document_parsing_command() -> None:
    args = cli.build_parser().parse_args(
        [
            "parse-document",
            "--source",
            "extensionless-blob",
            "--source-suffix",
            "docx",
            "--output",
            "parse-cache",
        ]
    )

    assert args.command == "parse-document"
    assert args.source == Path("extensionless-blob")
    assert args.source_suffix == "docx"
    assert args.output == Path("parse-cache")


def test_cli_exposes_source_semantic_compilation_command() -> None:
    args = cli.build_parser().parse_args(
        [
            "compile-source",
            "--run",
            "run-directory",
            "--source-id",
            "region-0063",
            "--resume",
            "existing-source-run",
        ]
    )

    assert args.command == "compile-source"
    assert args.run == Path("run-directory")
    assert args.source_id == "region-0063"
    assert args.resume == Path("existing-source-run")


def test_cli_exposes_all_source_semantic_compilation_command() -> None:
    args = cli.build_parser().parse_args(
        [
            "compile-sources",
            "--run",
            "run-directory",
            "--max-parallel-sources",
            "8",
            "--source-id",
            "region-0095",
            "--source-id",
            "region-0097",
            "--resume",
            "existing-full-source-run",
            "--resolve-progressively",
            "--global-resume",
            "existing-global-run",
            "--candidate-limit",
            "8",
        ]
    )

    assert args.command == "compile-sources"
    assert args.run == Path("run-directory")
    assert args.max_parallel_sources == 8
    assert args.source_id == ["region-0095", "region-0097"]
    assert args.resume == Path("existing-full-source-run")
    assert args.resolve_progressively is True
    assert args.global_resume == Path("existing-global-run")
    assert args.candidate_limit == 8


def test_cli_exposes_source_region_global_object_resolver_command() -> None:
    args = cli.build_parser().parse_args(
        [
            "resolve-objects",
            "--compilation",
            "source-semantic-full-directory",
            "--candidate-limit",
            "6",
            "--stop-after",
            "10",
            "--no-bge",
        ]
    )

    assert args.command == "resolve-objects"
    assert args.compilation == Path("source-semantic-full-directory")
    assert args.resume is None
    assert args.candidate_limit == 6
    assert args.stop_after == 10
    assert args.no_bge is True


def test_cli_exposes_global_assertion_finalization_command() -> None:
    args = cli.build_parser().parse_args(
        [
            "finalize-assertions",
            "--resolution",
            "completed-global-resolution",
        ]
    )

    assert args.command == "finalize-assertions"
    assert args.resolution == Path("completed-global-resolution")


@pytest.mark.asyncio
async def test_global_object_resolver_creates_local_model_streams(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    trace_directories: list[Path] = []
    compilation_directory = tmp_path / "source-semantic-full"
    compilation_directory.mkdir()
    fake_dataset = SimpleNamespace(
        directory=compilation_directory,
        source_sha256="a" * 64,
        source_node_ids=(),
        regions=(),
    )
    fake_state = SimpleNamespace(next_source_region_ordinal=0, objects=())

    class FakeResolverModel:
        def __init__(
            self,
            settings,
            *,
            progress,
            trace_directory: Path,
            show_model_stream: bool,
        ) -> None:
            del settings, progress, show_model_stream
            assert trace_directory.is_dir()
            assert trace_directory.name == "model-streams"
            trace_directories.append(trace_directory)

        async def aclose(self) -> None:
            return None

    class FakeResolverRunner:
        def __init__(self, **kwargs: object) -> None:
            del kwargs

        async def run_all(self, *, stop_after: int | None = None) -> SimpleNamespace:
            assert stop_after == 1
            return fake_state

    monkeypatch.setenv("AI_MODEL", "fake-model")
    monkeypatch.setenv("AI_API_BASE_URL", "http://model.test/v1")
    monkeypatch.setattr(cli, "load_source_compilation", lambda path: fake_dataset)
    monkeypatch.setattr(cli, "initial_registry", lambda dataset: fake_state)
    monkeypatch.setattr(cli, "write_working_registry", lambda paths, dataset, state: None)
    monkeypatch.setattr(cli, "OpenAICompatibleChatModel", FakeResolverModel)
    monkeypatch.setattr(cli, "GlobalObjectResolverRunner", FakeResolverRunner)

    args = cli.build_parser().parse_args(
        [
            "resolve-objects",
            "--compilation",
            str(compilation_directory),
            "--no-bge",
            "--stop-after",
            "1",
        ]
    )
    result = await cli._run_resolve_objects(args)

    assert len(trace_directories) == 1
    run_directory = trace_directories[0].parent
    assert result == 0
    assert run_directory.parent == compilation_directory / "global-resolutions"
    assert run_directory.name.endswith("-full")
    assert f"已创建 Global Resolution 目录 {run_directory}" in capsys.readouterr().out


def test_embedding_server_defaults_to_stable_hugging_face_profile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}
    monkeypatch.delenv("COLD_START_EMBEDDING_MODEL_REVISION", raising=False)
    monkeypatch.setattr(cli, "_report_environment", lambda args, progress: None)
    monkeypatch.setattr(
        cli,
        "serve_embeddings",
        lambda **kwargs: captured.update(kwargs),
    )
    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["cold-start", "serve-embeddings", "--embedding-model", "BAAI/bge-m3"],
    )

    cli.main()

    assert captured["model_name"] == "BAAI/bge-m3"
    assert captured["model_revision"] == "huggingface-main"
