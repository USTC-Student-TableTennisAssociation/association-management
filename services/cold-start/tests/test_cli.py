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
    def load(self, source_path: Path) -> ParsedDocument:
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
    monkeypatch.setattr(cli, "DoclingPdfLoader", FakePdfLoader)
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
    assert list((tmp_path / "runs").glob("*/global-exploration.json"))
