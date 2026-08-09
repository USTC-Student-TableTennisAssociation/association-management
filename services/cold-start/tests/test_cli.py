from __future__ import annotations

import argparse
import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import pytest

import cold_start.cli as cli
from cold_start.document.blocks import build_document_blocks
from cold_start.document.models import ParsedDocument, ParsedPage
from cold_start.llm.base import ModelTurn, ThinkingMode


class FakePdfLoader:
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
        (
            "AI_MODEL=fake-model\n"
            "AI_API_BASE_URL=http://model.test/v1\n"
            "AI_API_KEY=fake-key\n"
        ),
        encoding="utf-8",
    )
    for variable in ("AI_MODEL", "AI_API_BASE_URL", "AI_API_KEY"):
        monkeypatch.delenv(variable, raising=False)
    monkeypatch.chdir(working_directory)
    (working_directory / "handbook.pdf").write_bytes(b"pdf")
    monkeypatch.setattr(cli, "MinerUPdfLoader", FakePdfLoader)
    monkeypatch.setattr(cli, "OpenAICompatibleChatModel", FakeChatModel)

    result = await cli._run_explore(
        argparse.Namespace(
            pdf=Path("handbook.pdf"),
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


def test_cli_exposes_full_basic_compilation_command() -> None:
    args = cli.build_parser().parse_args(
        [
            "compile",
            "--run",
            "run-directory",
            "--max-parallel-sources",
            "8",
            "--max-parallel-parents",
            "4",
            "--resume",
            "existing-full-run",
            "--requests-per-minute",
            "18",
        ]
    )

    assert args.command == "compile"
    assert args.max_parallel_sources == 8
    assert args.max_parallel_parents == 4
    assert args.resume == Path("existing-full-run")
    assert args.requests_per_minute == 18


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
        ]
    )

    assert args.command == "compile-sources"
    assert args.run == Path("run-directory")
    assert args.max_parallel_sources == 8
    assert args.source_id == ["region-0095", "region-0097"]
    assert args.resume == Path("existing-full-source-run")


def test_cli_exposes_activity_operations_mapping_command() -> None:
    args = cli.build_parser().parse_args(
        [
            "map-activity",
            "--compilation",
            "basic-compilation-directory",
            "--max-parallel-groups",
            "8",
        ]
    )

    assert args.command == "map-activity"
    assert args.compilation == Path("basic-compilation-directory")
    assert args.max_parallel_groups == 8
