from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import pytest

from cold_start.config import ExplorationSettings
from cold_start.document.models import ParsedDocument, ParsedPage
from cold_start.global_exploration.graph import GlobalExplorationRunner
from cold_start.llm.base import ModelTurn, ThinkingMode


class RecordingProgressReporter:
    def __init__(self) -> None:
        self.events: list[tuple[str, str]] = []

    def report(self, stage: str, message: str) -> None:
        self.events.append((stage, message))


class FakeEmbedder:
    async def encode(self, texts: Sequence[str]) -> list[list[float]]:
        return [[float(len(text)), 1.0] for text in texts]


class TreeFakeModel:
    def __init__(self) -> None:
        self.prompts: list[str] = []
        self.context_calls = 0
        self.turn_calls = 0

    async def complete(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.0,
        request_label: str = "模型",
    ) -> str:
        del system_prompt, temperature, request_label
        self.prompts.append(user_prompt)
        if "[ROUTE: document_context]" not in user_prompt:
            raise AssertionError(f"未处理的文本模型调用：{user_prompt[:100]}")
        self.context_calls += 1
        return f"这是一份协会内部工作手册，供成员理解组织与日常工作。轮次 {self.context_calls}。"

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
        prompt = str(messages[1]["content"])
        self.prompts.append(prompt)
        self.turn_calls += 1
        if "[STAGE: region_tree_root]" in prompt:
            return ModelTurn(
                content=json.dumps(
                    {
                        "action": "split",
                        "owned_source_role": None,
                        "introduction": "完整手册由前言、行政工作和活动工作组成。",
                        "reason": "三个标题形成连续的宏观区域。",
                        "children": [
                            {
                                "label": "前言",
                                "introduction": "说明文档目标和使用对象。",
                                "start_block_id": "p0001-b0001",
                                "end_block_id": "p0001-b0002",
                            },
                            {
                                "label": "协会工作",
                                "introduction": "包含行政工作和活动工作两个相邻部分。",
                                "start_block_id": "p0002-b0001",
                                "end_block_id": "p0003-b0002",
                            },
                        ],
                    },
                    ensure_ascii=False,
                )
            )
        if "节点 region-0002" in prompt:
            return ModelTurn(
                content=json.dumps(
                    {
                        "action": "stop",
                        "owned_source_role": "content_source",
                        "introduction": "说明文档目标和使用对象。",
                        "reason": "前言是一个连续说明。",
                    },
                    ensure_ascii=False,
                )
            )
        if "节点 region-0003" in prompt:
            return ModelTurn(
                content=json.dumps(
                    {
                        "action": "split",
                        "owned_source_role": None,
                        "introduction": "协会工作由行政和活动两部分组成。",
                        "reason": "两个显式标题是直接边界。",
                        "children": [
                            {
                                "label": "行政工作",
                                "introduction": "说明协会的行政事项。",
                                "start_block_id": "p0002-b0001",
                                "end_block_id": "p0002-b0002",
                            },
                            {
                                "label": "活动工作",
                                "introduction": "说明协会的活动事项。",
                                "start_block_id": "p0003-b0001",
                                "end_block_id": "p0003-b0002",
                            },
                        ],
                    },
                    ensure_ascii=False,
                )
            )
        if "节点 region-0004" in prompt:
            return ModelTurn(
                content=json.dumps(
                    {
                        "action": "stop",
                        "owned_source_role": "content_source",
                        "introduction": "说明协会的行政事项。",
                        "reason": "当前区域只有一项连续行政说明。",
                    },
                    ensure_ascii=False,
                )
            )
        if "节点 region-0005" in prompt:
            return ModelTurn(
                content=json.dumps(
                    {
                        "action": "stop",
                        "owned_source_role": "content_source",
                        "introduction": "说明协会的活动事项。",
                        "reason": "当前区域只有一项连续活动说明。",
                    },
                    ensure_ascii=False,
                )
            )
        raise AssertionError(f"未处理的区域模型调用：{prompt[:200]}")


def make_document() -> ParsedDocument:
    pages = (
        ParsedPage(page_number=1, markdown="# 前言\n\n文档目标和读者。"),
        ParsedPage(page_number=2, markdown="# 行政工作\n\n二课申请。"),
        ParsedPage(page_number=3, markdown="# 活动工作\n\n再次提及二课申请。"),
    )
    return ParsedDocument(
        source_path=Path("/tmp/乒协生存手册.pdf"),
        title="乒协生存手册",
        file_sha256="b" * 64,
        parser_name="test",
        pages=pages,
        markdown="\n\n".join(page.markdown for page in pages),
    )


@pytest.mark.asyncio
async def test_context_and_root_start_as_parallel_routes_then_tree_recurses() -> None:
    model = TreeFakeModel()
    progress = RecordingProgressReporter()
    snapshot = await GlobalExplorationRunner(
        model=model,
        progress=progress,
        embedder=FakeEmbedder(),
        settings=ExplorationSettings(
            context_unit_chars=1,
            max_parallel_regions=2,
        ),
    ).run(make_document())

    context_prompts = [
        prompt for prompt in model.prompts if "[ROUTE: document_context]" in prompt
    ]
    root_prompts = [
        prompt for prompt in model.prompts if "[STAGE: region_tree_root]" in prompt
    ]
    node_prompts = [
        prompt for prompt in model.prompts if "[STAGE: region_tree_node]" in prompt
    ]
    assert len(context_prompts) == 3
    assert "轮次 1" in context_prompts[1]
    assert len(root_prompts) == 1
    assert "p0001-b0001" in root_prompts[0]
    assert len(node_prompts) == 4
    assert all("根节点到直接父节点" in prompt for prompt in node_prompts)

    assert snapshot.schema_version == "global-exploration.v9"
    assert snapshot.authority == "preliminary-low-authority"
    assert snapshot.region_tree.status == "frozen"
    assert max(node.depth for node in snapshot.region_tree.nodes) == 2
    assert len(snapshot.region_tree.leaf_node_ids) == 3
    assert snapshot.context_model_calls == 3
    assert snapshot.region_tree.model_calls == 5
    assert snapshot.region_tree.structure_check.initial_issues == []
    assert snapshot.region_tree.structure_check.remaining_issues == []

    leaves = {
        node.label
        for node in snapshot.region_tree.nodes
        if node.status == "leaf"
    }
    assert leaves == {"前言", "行政工作", "活动工作"}
    stages = [stage for stage, _ in progress.events]
    assert {"规划", "文档上下文", "区域树", "汇总"} <= set(stages)
