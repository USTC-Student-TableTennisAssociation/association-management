from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

import pytest

from cold_start.config import ExplorationSettings
from cold_start.document.blocks import build_document_blocks
from cold_start.document.models import ParsedPage
from cold_start.llm.base import ModelTurn, ThinkingMode, ToolCall
from cold_start.region_tree.models import ParentPartitionError, SplitDecision
from cold_start.region_tree.runtime import BlockIndex, RegionRuntime, RegionTree


class FakeEmbedder:
    async def encode(self, texts: Sequence[str]) -> list[list[float]]:
        return [[float("二课" in text), 1.0] for text in texts]


class ToolModel:
    def __init__(self) -> None:
        self.tool_result = ""

    async def complete(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.0,
        request_label: str = "模型",
    ) -> str:
        del system_prompt, user_prompt, temperature, request_label
        raise AssertionError("不应使用普通文本修复")

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
        del temperature, request_label
        prompt = str(messages[1]["content"])
        if "节点 region-0002" in prompt:
            if messages[-1]["role"] == "user":
                assert tools and tool_choice == "auto" and thinking == "enabled"
                return ModelTurn(
                    content="",
                    reasoning_content="需要查看外部的二课申请。",
                    tool_calls=(
                        ToolCall(
                            id="call-search",
                            name="search_document",
                            arguments='{"query":"二课申请"}',
                        ),
                    ),
                )
            assert not tools and tool_choice is None
            assert messages[-2]["reasoning_content"] == "需要查看外部的二课申请。"
            self.tool_result = str(messages[-1]["content"])
            return _stop("当前区域完整说明比赛工作。")
        if "节点 region-0003" in prompt:
            return _stop("当前区域说明其他协会工作。")
        raise AssertionError(f"未处理提示词：{prompt[:100]}")


class OneNodeFailureModel(ToolModel):
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
        if "节点 region-0002" in prompt:
            return _stop("比赛工作可以整体处理。")
        raise RuntimeError("模拟单节点接口故障")


class ReasoningOnlyThenRepairModel(ToolModel):
    def __init__(self) -> None:
        super().__init__()
        self.repaired = False

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
        del tool_choice, temperature, request_label
        if thinking == "disabled":
            assert not tools
            assert any(message["role"] == "tool" for message in messages)
            self.repaired = True
            return _stop("修复后给出正式判断。")
        prompt = str(messages[1]["content"])
        if "节点 region-0002" in prompt:
            if messages[-1]["role"] == "user":
                return ModelTurn(
                    content="",
                    reasoning_content="先检索外部二课信息。",
                    tool_calls=(
                        ToolCall(
                            id="call-before-repair",
                            name="search_document",
                            arguments='{"query":"二课申请"}',
                        ),
                    ),
                )
            return ModelTurn(
                content="",
                reasoning_content="判断已经完成，但没有提交正文。",
            )
        return _stop("其他工作可以整体处理。")


def _stop(introduction: str) -> ModelTurn:
    return ModelTurn(
        content=json.dumps(
            {
                "action": "stop",
                "introduction": introduction,
                "reason": "没有更多可独立阅读的连续区域。",
            },
            ensure_ascii=False,
        )
    )


def blocks():
    return build_document_blocks(
        (
            ParsedPage(page_number=1, markdown="# 比赛工作\n\n比赛流程。"),
            ParsedPage(page_number=2, markdown="# 行政工作\n\n二课申请流程。"),
            ParsedPage(page_number=3, markdown="# 宣传工作\n\n海报审核。"),
        )
    )


def split_plan() -> SplitDecision:
    return SplitDecision.model_validate(
        {
            "action": "split",
            "introduction": "手册由比赛和其他工作组成。",
            "reason": "按标题切分。",
            "children": [
                {
                    "label": "比赛工作",
                    "introduction": "比赛执行内容。",
                    "start_block_id": "p0001-b0001",
                    "end_block_id": "p0001-b0002",
                },
                {
                    "label": "其他工作",
                    "introduction": "行政和宣传内容。",
                    "start_block_id": "p0002-b0001",
                    "end_block_id": "p0003-b0002",
                },
            ],
        }
    )


@pytest.mark.asyncio
async def test_every_child_is_judged_and_reasoning_is_preserved_across_tools() -> None:
    model = ToolModel()
    runtime = RegionRuntime(
        model=model,
        blocks=blocks(),
        context="协会内部手册。",
        settings=ExplorationSettings(max_tool_calls_per_region=1),
        embedder=FakeEmbedder(),
    )
    snapshot = await runtime.run(
        title="测试手册",
        root_decision=split_plan(),
        root_model_calls=1,
    )

    assert snapshot.status == "frozen"
    assert snapshot.model_calls == 4
    assert snapshot.tool_calls == 1
    assert len(snapshot.leaf_node_ids) == 2
    assert "二课申请流程" in model.tool_result


@pytest.mark.asyncio
async def test_one_technical_failure_keeps_parent_and_successful_sibling() -> None:
    runtime = RegionRuntime(
        model=OneNodeFailureModel(),
        blocks=blocks(),
        context="协会内部手册。",
        settings=ExplorationSettings(),
        embedder=FakeEmbedder(),
    )
    snapshot = await runtime.run(
        title="测试手册",
        root_decision=split_plan(),
        root_model_calls=1,
    )

    nodes = {node.node_id: node for node in snapshot.nodes}
    assert snapshot.status == "needs_review"
    assert nodes["region-0001"].status == "branch"
    assert nodes["region-0001"].child_ids == ["region-0002", "region-0003"]
    assert nodes["region-0002"].status == "leaf"
    assert nodes["region-0003"].status == "failed"
    assert snapshot.model_calls == 3


@pytest.mark.asyncio
async def test_reasoning_only_turn_uses_non_thinking_json_repair() -> None:
    model = ReasoningOnlyThenRepairModel()
    runtime = RegionRuntime(
        model=model,
        blocks=blocks(),
        context="协会内部手册。",
        settings=ExplorationSettings(),
        embedder=FakeEmbedder(),
    )
    snapshot = await runtime.run(
        title="测试手册",
        root_decision=split_plan(),
        root_model_calls=1,
    )

    assert snapshot.status == "frozen"
    assert model.repaired is True
    assert snapshot.model_calls == 5
    assert snapshot.tool_calls == 1
    assert len(snapshot.leaf_node_ids) == 2


def test_parent_can_reopen_once_then_keeps_revised_children_for_review() -> None:
    index = BlockIndex(blocks())
    tree = RegionTree(index, max_depth=5)
    tree.initialize(title="测试手册", decision=split_plan())
    report = ParentPartitionError(
        action="parent_partition_error",
        problem_kind="missing_intermediate_region",
        related_node_ids=["region-0002", "region-0003"],
        reason="两个孩子应先组成共同区域。",
    )
    assert tree.check_parent_error("region-0002", report) == "region-0001"

    revised = split_plan().model_copy(update={"introduction": "第一次重切。"})
    tree.reopen("region-0001", revised)
    assert tree.nodes["region-0001"].revised is True
    assert "region-0002" not in tree.nodes
    revised_children = list(tree.nodes["region-0001"].child_ids)

    tree.reopen("region-0001", revised)
    snapshot = tree.snapshot()
    assert snapshot.status == "needs_review"
    assert tree.nodes["region-0001"].child_ids == revised_children
    assert all(node_id in tree.nodes for node_id in revised_children)
    assert "已自动重切一次" in snapshot.issues[0]


def test_program_rejects_child_range_gap() -> None:
    invalid = split_plan().model_copy(
        update={
            "children": [
                split_plan().children[0].model_copy(
                    update={"end_block_id": "p0001-b0001"}
                ),
                split_plan().children[1],
            ]
        }
    )
    with pytest.raises(ValueError, match="应从 p0001-b0002 开始"):
        RegionTree(BlockIndex(blocks()), max_depth=5).initialize(
            title="测试手册",
            decision=invalid,
        )
