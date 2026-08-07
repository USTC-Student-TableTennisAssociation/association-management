from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

import pytest

from cold_start.config import ExplorationSettings
from cold_start.document.blocks import build_document_blocks
from cold_start.document.models import ParsedPage
from cold_start.llm.base import ModelTurn, ThinkingMode, ToolCall
from cold_start.region_tree.models import (
    KeepDecision,
    ParentPartitionError,
    SourceIssue,
    SplitDecision,
    StopDecision,
)
from cold_start.region_tree.prompts import (
    REGION_TREE_SYSTEM_PROMPT,
    STRUCTURE_REPAIR_SYSTEM_PROMPT,
)
from cold_start.region_tree.runtime import (
    BlockIndex,
    RegionRuntime,
    RegionTree,
    _parse_region,
)


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


class KeepStructureRepairModel(ToolModel):
    def __init__(self) -> None:
        super().__init__()
        self.structure_calls = 0

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
        if "[STAGE: region_tree_structure_repair]" in prompt:
            self.structure_calls += 1
            assert "内部标题" not in prompt
            return ModelTurn(
                content=json.dumps(
                    {
                        "action": "keep",
                        "reason": "编号来自文档排版，现有区域关系正确。",
                        "source_issues": [
                            {
                                "block_ids": ["p0002-b0001"],
                                "reason": "标题编号与实际语义位置不一致。",
                            }
                        ],
                    },
                    ensure_ascii=False,
                )
            )
        return _stop("当前区域可以整体处理。")


def _stop(introduction: str) -> ModelTurn:
    return ModelTurn(
        content=json.dumps(
            {
                "action": "stop",
                "owned_source_role": "content_source",
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
            "owned_source_role": None,
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


def test_parent_owns_blocks_not_delegated_to_children() -> None:
    decision = SplitDecision.model_validate(
        {
            "action": "split",
            "owned_source_role": "content_source",
            "introduction": "手册以比赛原则统领两个工作领域。",
            "reason": "第一页由父节点保留，行政和宣传分别成为孩子。",
            "children": [
                {
                    "label": "行政工作",
                    "introduction": "行政事项。",
                    "start_block_id": "p0002-b0001",
                    "end_block_id": "p0002-b0002",
                },
                {
                    "label": "宣传工作",
                    "introduction": "宣传事项。",
                    "start_block_id": "p0003-b0001",
                    "end_block_id": "p0003-b0002",
                },
            ],
        }
    )
    tree = RegionTree(BlockIndex(blocks()), max_depth=5)
    tree.initialize(title="测试手册", decision=decision)
    for child_id in tree.nodes["region-0001"].child_ids:
        tree.apply(
            child_id,
            StopDecision(
                action="stop",
                owned_source_role="content_source",
                introduction="完整内容。",
                reason="无需再分。",
            ),
        )

    snapshot = tree.snapshot()
    root = tree.nodes["region-0001"]
    assert root.status == "branch"
    assert [
        (item.start_block_id, item.end_block_id) for item in root.owned_segments
    ] == [("p0001-b0001", "p0001-b0002")]
    assert snapshot.content_node_ids == [
        "region-0001",
        "region-0002",
        "region-0003",
    ]


def test_source_role_is_semantic_instead_of_inferred_from_block_type() -> None:
    tree = RegionTree(BlockIndex(blocks()), max_depth=5)
    tree.initialize(
        title="测试手册",
        decision=StopDecision(
            action="stop",
            owned_source_role="structural_context",
            introduction="由模型根据语义判定来源角色。",
            reason="块类型本身不能替代语义判断。",
        ),
    )

    snapshot = tree.snapshot()
    assert snapshot.status == "frozen"
    assert snapshot.structural_context_node_ids == ["region-0001"]


def test_source_diagnostics_never_block_a_valid_tree_decision() -> None:
    raw_issues = [
        {
            "block_ids": [f"p{9000 + index:04d}-b0001"],
            "reason": f"第 {index} 条来源解析诊断。",
        }
        for index in range(1, 6)
    ]
    raw_issues.extend(
        [
            {"block_ids": [], "reason": "缺少定位的坏诊断。"},
            {"block_ids": ["not-a-block"], "reason": "块编号格式错误。"},
        ]
    )
    decision = _parse_region(
        json.dumps(
            {
                "action": "stop",
                "owned_source_role": "content_source",
                "introduction": "这是一段完整内容。",
                "reason": "无需继续切分。",
                "source_issues": raw_issues,
            },
            ensure_ascii=False,
        )
    )

    tree = RegionTree(BlockIndex(blocks()), max_depth=5)
    tree.initialize(title="测试手册", decision=decision)
    snapshot = tree.snapshot()

    assert snapshot.status == "frozen"
    assert len(snapshot.source_issues) == 5
    assert snapshot.source_issues[0].block_ids == ["p9001-b0001"]


def test_source_diagnostic_sanitizer_preserves_parent_partition_error() -> None:
    decision = _parse_region(
        json.dumps(
            {
                "action": "parent_partition_error",
                "problem_kind": "missing_intermediate_region",
                "related_node_ids": ["region-0002", "region-0003"],
                "reason": "两个节点需要一个共同父区域。",
                "source_issues": [{"unexpected": "诊断字段不能破坏主判断"}],
            },
            ensure_ascii=False,
        )
    )

    assert isinstance(decision, ParentPartitionError)


def test_structural_heading_can_be_owned_by_branch_without_becoming_leaf() -> None:
    source = build_document_blocks(
        (
            ParsedPage(page_number=1, markdown="# 工作分类"),
            ParsedPage(page_number=2, markdown="# 行政工作\n\n二课申请。"),
            ParsedPage(page_number=3, markdown="# 宣传工作\n\n海报审核。"),
        )
    )
    tree = RegionTree(BlockIndex(source), max_depth=5)
    tree.initialize(
        title="测试手册",
        decision=SplitDecision.model_validate(
            {
                "action": "split",
                "owned_source_role": "structural_context",
                "introduction": "工作分类包含行政和宣传。",
                "reason": "父标题留在当前节点。",
                "children": [
                    {
                        "label": "行政工作",
                        "introduction": "行政事项。",
                        "start_block_id": "p0002-b0001",
                        "end_block_id": "p0002-b0002",
                    },
                    {
                        "label": "宣传工作",
                        "introduction": "宣传事项。",
                        "start_block_id": "p0003-b0001",
                        "end_block_id": "p0003-b0002",
                    },
                ],
            }
        ),
    )
    for child_id in tree.nodes["region-0001"].child_ids:
        tree.apply(
            child_id,
            StopDecision(
                action="stop",
                owned_source_role="content_source",
                introduction="完整内容。",
                reason="无需再分。",
            ),
        )

    snapshot = tree.snapshot()
    assert snapshot.structural_context_node_ids == ["region-0001"]
    assert "region-0001" not in snapshot.leaf_node_ids


def test_numbered_heading_check_only_flags_broken_ancestry() -> None:
    source = build_document_blocks(
        (
            ParsedPage(page_number=1, markdown="## 7.1 大型赛事\n\n总体说明。"),
            ParsedPage(page_number=2, markdown="### 7.1.1行政\n\n申请流程。"),
        )
    )
    index = BlockIndex(source)
    incorrect = RegionTree(index, max_depth=5)
    incorrect.initialize(
        title="测试手册",
        decision=SplitDecision.model_validate(
            {
                "action": "split",
                "owned_source_role": None,
                "introduction": "大型赛事与行政被错误拆成兄弟。",
                "reason": "构造结构检查样例。",
                "children": [
                    {
                        "label": "大型赛事",
                        "introduction": "总体说明。",
                        "start_block_id": "p0001-b0001",
                        "end_block_id": "p0001-b0002",
                    },
                    {
                        "label": "行政",
                        "introduction": "申请流程。",
                        "start_block_id": "p0002-b0001",
                        "end_block_id": "p0002-b0002",
                    },
                ],
            }
        ),
    )
    for child_id in incorrect.nodes["region-0001"].child_ids:
        incorrect.apply(
            child_id,
            StopDecision(
                action="stop",
                owned_source_role="content_source",
                introduction="完整内容。",
                reason="无需再分。",
            ),
        )

    issues = incorrect.detect_structure_issues()
    assert len(issues) == 1
    assert issues[0].target_node_id == "region-0001"
    assert issues[0].block_ids == ["p0002-b0001"]
    assert "标题 7.1.1" in issues[0].reason

    correct = RegionTree(index, max_depth=5)
    groups = correct.initialize(
        title="测试手册",
        decision=SplitDecision.model_validate(
            {
                "action": "split",
                "owned_source_role": "content_source",
                "introduction": "大型赛事统领行政子节。",
                "reason": "7.1 留在父节点，7.1.1 成为孩子。",
                "children": [
                    {
                        "label": "行政",
                        "introduction": "申请流程。",
                        "start_block_id": "p0002-b0001",
                        "end_block_id": "p0002-b0002",
                    }
                ],
            }
        ),
    )
    correct.apply(
        groups[0][1][0],
        StopDecision(
            action="stop",
            owned_source_role="content_source",
            introduction="完整内容。",
            reason="无需再分。",
        ),
    )
    assert correct.detect_structure_issues() == []


@pytest.mark.asyncio
async def test_structure_check_can_dismiss_a_confirmed_false_positive() -> None:
    source = build_document_blocks(
        (
            ParsedPage(page_number=1, markdown="## 9.1.2 隐性知识\n\n决策逻辑。"),
            ParsedPage(page_number=2, markdown="## 9.3.1\n\n事故复盘。"),
            ParsedPage(page_number=3, markdown="## 9.3 交接\n\n换届交接。"),
        )
    )
    decision = SplitDecision.model_validate(
        {
            "action": "split",
            "owned_source_role": None,
            "introduction": "隐性知识与交接是两个区域。",
            "reason": "异常标题按实际语义归入隐性知识。",
            "children": [
                {
                    "label": "9.1.2 隐性知识",
                    "introduction": "包括决策逻辑和事故复盘。",
                    "start_block_id": "p0001-b0001",
                    "end_block_id": "p0002-b0002",
                },
                {
                    "label": "9.3 交接",
                    "introduction": "换届交接。",
                    "start_block_id": "p0003-b0001",
                    "end_block_id": "p0003-b0002",
                },
            ],
        }
    )
    model = KeepStructureRepairModel()
    runtime = RegionRuntime(
        model=model,
        blocks=source,
        context="协会内部手册。",
        settings=ExplorationSettings(),
        embedder=FakeEmbedder(),
    )
    await runtime.run(
        title="测试手册",
        root_decision=decision,
        root_model_calls=1,
    )
    await runtime.calibrate_structure()

    snapshot = runtime.tree.snapshot()
    assert snapshot.status == "frozen"
    assert len(snapshot.structure_check.initial_issues) == 1
    assert snapshot.structure_check.remaining_issues == []
    assert snapshot.source_issues[0].block_ids == ["p0002-b0001"]
    assert snapshot.model_calls == 4
    assert model.structure_calls == 1

    known_model = KeepStructureRepairModel()
    known_runtime = RegionRuntime(
        model=known_model,
        blocks=source,
        context="协会内部手册。",
        settings=ExplorationSettings(),
        embedder=FakeEmbedder(),
    )
    await known_runtime.run(
        title="测试手册",
        root_decision=decision.model_copy(
            update={
                "source_issues": [
                    SourceIssue(
                        block_ids=["p0002-b0001"],
                        reason="标题编号与实际语义位置不一致。",
                    )
                ]
            }
        ),
        root_model_calls=1,
    )
    await known_runtime.calibrate_structure()

    known_snapshot = known_runtime.tree.snapshot()
    assert known_snapshot.status == "frozen"
    assert len(known_snapshot.structure_check.initial_issues) == 1
    assert known_snapshot.structure_check.remaining_issues == []
    assert known_model.structure_calls == 0


def test_calibration_can_reject_a_false_positive_without_changing_tree() -> None:
    tree = RegionTree(BlockIndex(blocks()), max_depth=5)
    tree.initialize(title="测试手册", decision=split_plan())
    original_children = tree.nodes["region-0001"].child_ids.copy()

    groups = tree.calibrate(
        "region-0001",
        KeepDecision(action="keep", reason="两个直接孩子的边界已经正确。"),
    )

    assert groups == []
    assert tree.nodes["region-0001"].child_ids == original_children
    assert tree.nodes["region-0001"].decision_reason == "两个直接孩子的边界已经正确。"


def test_all_tree_prompts_share_local_compilation_stop_condition() -> None:
    tree_prompt = "".join(REGION_TREE_SYSTEM_PROMPT.split())
    repair_prompt = "".join(STRUCTURE_REPAIR_SYSTEM_PROMPT.split())

    assert "所有未被孩子覆盖的块自动成为当前节点直接拥有的原文" in tree_prompt
    assert "一次局部子图编译所需的最小连续原文区域" in tree_prompt
    assert "一张叶子后续可以生成多张记忆卡片及其连线" in tree_prompt
    assert "多个独立活动、多个职责对象不同的角色" in tree_prompt
    assert "表头、字段说明与依赖它们解释的表体" in tree_prompt
    assert "同一对象的标题与依赖该标题才能确定主体" in tree_prompt
    assert "完整且有实质内容的章节或小节" in tree_prompt
    assert "单个block内混有别节文字时，不能返回parent_partition_error" in tree_prompt
    assert "一次局部子图编译所需的最小连续原文区域" in repair_prompt
    assert "必须返回keep，并把异常写入source_issues" in repair_prompt
