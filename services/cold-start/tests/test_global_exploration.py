from __future__ import annotations

import json
from pathlib import Path

import pytest

from cold_start.config import ExplorationSettings
from cold_start.document.models import ParsedDocument, ParsedPage
from cold_start.global_exploration.graph import GlobalExplorationRunner


class RecordingProgressReporter:
    def __init__(self) -> None:
        self.events: list[tuple[str, str]] = []

    def report(self, stage: str, message: str) -> None:
        self.events.append((stage, message))


class TwoRouteFakeModel:
    def __init__(self) -> None:
        self.prompts: list[str] = []
        self.system_prompts: list[str] = []
        self.context_calls = 0

    async def complete(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.0,
        request_label: str = "模型",
    ) -> str:
        del temperature, request_label
        self.system_prompts.append(system_prompt)
        self.prompts.append(user_prompt)

        if "[ROUTE: document_context]" in user_prompt:
            self.context_calls += 1
            return (
                "这是一份面向协会成员的内部手册，用于延续协会背景、"
                f"工作事项和活动经验。已顺序阅读 {self.context_calls} 个单元。"
            )
        if "[ROUTE: macro_sections]" in user_prompt:
            return json.dumps(
                {
                    "sections": [
                        {"label": "文档背景", "start_page": 1, "end_page": 1},
                        {"label": "协会工作", "start_page": 2, "end_page": 3},
                    ]
                },
                ensure_ascii=False,
            )
        raise AssertionError(f"未处理的提示词：{user_prompt[:100]}")


def make_document() -> ParsedDocument:
    pages = (
        ParsedPage(page_number=1, markdown="# 前言\n文档目标和读者。"),
        ParsedPage(page_number=2, markdown="# 行政工作\n二课申请。"),
        ParsedPage(page_number=3, markdown="# 活动工作\n再次提及二课申请。"),
    )
    return ParsedDocument(
        source_path=Path("/tmp/乒协生存手册.pdf"),
        title="乒协生存手册",
        file_sha256="b" * 64,
        parser_name="test",
        pages=pages,
        markdown="完整手册",
    )


@pytest.mark.asyncio
async def test_two_routes_run_independently_and_join() -> None:
    model = TwoRouteFakeModel()
    progress = RecordingProgressReporter()
    snapshot = await GlobalExplorationRunner(
        model=model,
        progress=progress,
        settings=ExplorationSettings(
            context_unit_chars=1,
        ),
    ).run(make_document())

    context_prompts = [
        prompt for prompt in model.prompts if "[ROUTE: document_context]" in prompt
    ]
    section_prompts = [
        prompt for prompt in model.prompts if "[ROUTE: macro_sections]" in prompt
    ]
    assert len(context_prompts) == 3
    assert "已顺序阅读 1 个单元" in context_prompts[1]
    assert len(section_prompts) == 1
    assert all(f"〔第 {page} 页〕" in section_prompts[0] for page in (1, 2, 3))

    assert snapshot.schema_version == "global-exploration.v4"
    assert snapshot.authority == "preliminary-low-authority"
    assert snapshot.route_statistics.context_units == 3
    assert snapshot.route_statistics.macro_section_calls == 1
    assert len(snapshot.macro_sections) == 2

    stages = [stage for stage, _ in progress.events]
    assert {"规划", "文档上下文", "宏观切分", "汇总"} <= set(stages)


class RepairingSectionModel(TwoRouteFakeModel):
    def __init__(self) -> None:
        super().__init__()
        self.section_calls = 0

    async def complete(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.0,
        request_label: str = "模型",
    ) -> str:
        if "[ROUTE: macro_sections]" in user_prompt:
            self.system_prompts.append(system_prompt)
            self.prompts.append(user_prompt)
            self.section_calls += 1
            if self.section_calls == 1:
                return json.dumps(
                    {
                        "sections": [
                            {"label": "错误分区", "start_page": 2, "end_page": 3}
                        ]
                    },
                    ensure_ascii=False,
                )
            return json.dumps(
                {
                    "sections": [
                        {"label": "完整分区", "start_page": 1, "end_page": 3}
                    ]
                },
                ensure_ascii=False,
            )
        return await super().complete(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            temperature=temperature,
            request_label=request_label,
        )


@pytest.mark.asyncio
async def test_invalid_macro_page_coverage_triggers_one_repair() -> None:
    model = RepairingSectionModel()
    snapshot = await GlobalExplorationRunner(
        model=model,
        settings=ExplorationSettings(
            context_unit_chars=100,
        ),
    ).run(make_document())

    assert model.section_calls == 2
    assert snapshot.route_statistics.macro_section_calls == 2
    assert snapshot.macro_sections[0].start_page == 1
