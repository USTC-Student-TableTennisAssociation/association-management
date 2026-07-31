from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

import pytest

from cold_start.compilation.models import (
    LeafCandidateSubgraph,
    LeafCompilationResult,
    LeafCompilationSnapshot,
)
from cold_start.compilation.parent_runner import ParentIntegrationRunner
from cold_start.config import CompilationSettings
from cold_start.document.blocks import build_document_blocks
from cold_start.document.models import ParsedPage
from cold_start.global_exploration.models import (
    GlobalExplorationSnapshot,
    SourceMetadata,
)
from cold_start.llm.base import ModelTurn, ThinkingMode
from cold_start.region_tree.models import RegionNode, RegionTreeSnapshot, SourceSegment


class ParentModel:
    def __init__(
        self,
        *,
        route: dict[str, object],
        decision: dict[str, object] | list[dict[str, object]],
    ) -> None:
        self.route = route
        self.decisions = decision if isinstance(decision, list) else [decision]
        self.decision_index = 0
        self.stages: list[str] = []

    async def complete(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.0,
        request_label: str = "模型",
    ) -> str:
        del system_prompt, user_prompt, temperature, request_label
        raise AssertionError("父节点整合不应调用 complete")

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
        if "[STAGE: parent_integration_route]" in prompt:
            self.stages.append("route")
            return ModelTurn(content=json.dumps(self.route, ensure_ascii=False))
        if "[STAGE: parent_integration_decision]" in prompt:
            self.stages.append("decision")
            system_prompt = str(messages[0]["content"])
            assert "activity_pattern：必填" in system_prompt
            assert "source_evidence 必须被至少一项" in system_prompt
            assert "informs 不是通用相关关系" in system_prompt
            decision = self.decisions[min(self.decision_index, len(self.decisions) - 1)]
            self.decision_index += 1
            return ModelTurn(content=json.dumps(decision, ensure_ascii=False))
        raise AssertionError("出现未预期的父节点模型调用")


def _inputs(
    *,
    parent_text: str,
    parent_source_role: str,
    first_kind: str = "activity_pattern",
    second_kind: str = "activity_pattern",
) -> tuple[
    GlobalExplorationSnapshot,
    LeafCompilationSnapshot,
    tuple,
]:
    blocks = build_document_blocks(
        (
            ParsedPage(
                page_number=1,
                markdown=(
                    f"{parent_text}\n\n"
                    "## 孩子一\n\n第一段内容。\n\n"
                    "## 孩子二\n\n第二段内容。"
                ),
            ),
        )
    )
    source = SourceMetadata(
        path="/tmp/handbook.pdf",
        title="测试手册",
        sha256="b" * 64,
        parser="fake",
        page_count=1,
        block_count=len(blocks),
    )
    root = RegionNode(
        node_id="region-0001",
        parent_id=None,
        depth=0,
        label="测试手册",
        introduction="两个孩子由父节点统领。",
        start_block_id="p0001-b0001",
        end_block_id="p0001-b0005",
        source_pages=[1],
        status="branch",
        owned_segments=[
            SourceSegment(
                start_block_id="p0001-b0001",
                end_block_id="p0001-b0001",
            )
        ],
        owned_source_role=parent_source_role,
        decision_reason="父节点保留统领文字。",
        child_ids=["region-0002", "region-0003"],
    )
    leaves = [
        RegionNode(
            node_id=f"region-000{position}",
            parent_id="region-0001",
            depth=1,
            label=f"孩子{position - 1}",
            introduction="局部内容。",
            start_block_id=f"p0001-b{2 * position - 2:04d}",
            end_block_id=f"p0001-b{2 * position - 1:04d}",
            source_pages=[1],
            status="leaf",
            owned_segments=[
                SourceSegment(
                    start_block_id=f"p0001-b{2 * position - 2:04d}",
                    end_block_id=f"p0001-b{2 * position - 1:04d}",
                )
            ],
            owned_source_role="content_source",
            decision_reason="完整局部。",
        )
        for position in (2, 3)
    ]
    tree = RegionTreeSnapshot(
        status="frozen",
        root_node_id=root.node_id,
        nodes=[root, *leaves],
        leaf_node_ids=[item.node_id for item in leaves],
        content_node_ids=[root.node_id, *(item.node_id for item in leaves)],
        structural_context_node_ids=[],
    )
    exploration = GlobalExplorationSnapshot(
        created_at=datetime.now(UTC),
        source=source,
        document_context_markdown="测试手册。",
        context_model_calls=1,
        region_tree=tree,
    )
    def content(kind: str, title: str) -> dict[str, str]:
        if kind == "workflow":
            return {
                "goal_markdown": f"完成{title}。",
                "entry_meaning_markdown": f"{title}开始。",
            }
        return {
            "description_markdown": "长期举办的品牌赛事。",
            "recurrence_kind": "annual",
        }

    definitions = [
        (first_kind, "继往开来", content(first_kind, "继往开来")),
        (second_kind, "继往开来杯", content(second_kind, "继往开来杯")),
    ]
    leaf_results = []
    for position, (leaf, definition) in enumerate(
        zip(leaves, definitions, strict=True),
        start=1,
    ):
        kind, title, content = definition
        leaf_results.append(
            LeafCompilationResult(
                leaf_node_id=leaf.node_id,
                label=leaf.label,
                lineage=["region-0001"],
                start_block_id=leaf.start_block_id,
                end_block_id=leaf.end_block_id,
                source_pages=[1],
                status="compiled",
                model_calls=1,
                subgraph=LeafCandidateSubgraph.model_validate(
                    {
                        "new_cards": [
                            {
                                "card_id": "card-1",
                                "kind": kind,
                                "title": title,
                                "summary": f"{title}活动。",
                                "content": content,
                                "evidence_ids": ["evidence-1"],
                            }
                        ],
                        "source_evidence": [
                            {
                                "evidence_id": "evidence-1",
                                "start_block_id": leaf.start_block_id,
                                "end_block_id": leaf.end_block_id,
                                "role": "basis",
                                "note_markdown": f"孩子{position}的活动依据。",
                            }
                        ],
                    }
                ),
            )
        )
    compilation = LeafCompilationSnapshot(
        created_at=datetime.now(UTC),
        status="complete",
        source=source,
        region_tree_schema_version=tree.schema_version,
        leaf_results=leaf_results,
        deferred_content_node_ids=["region-0001"],
        model_calls=2,
    )
    return exploration, compilation, blocks


@pytest.mark.asyncio
async def test_parent_merges_same_activity_from_different_children() -> None:
    exploration, compilation, blocks = _inputs(
        parent_text="# 测试手册",
        parent_source_role="structural_context",
    )
    model = ParentModel(
        route={
            "overview": "两个孩子描述同一活动。",
            "candidate_groups": [
                {
                    "kind": "possible_duplicate",
                    "card_ids": [
                        "region-0002/card-1",
                        "region-0003/card-1",
                    ],
                    "reason": "活动名称和身份一致。",
                }
            ],
        },
        decision={
            "merge_cards": [
                {
                    "card_ids": [
                        "region-0002/card-1",
                        "region-0003/card-1",
                    ],
                    "replacement": {
                        "kind": "activity_pattern",
                        "title": "继往开来杯",
                        "summary": "乒协每年举办的品牌赛事。",
                        "content": {
                            "description_markdown": "乒协长期举办的品牌赛事。",
                            "recurrence_kind": "annual",
                        },
                        "evidence_ids": [
                            "region-0002/evidence-1",
                            "region-0003/evidence-1",
                        ],
                    },
                    "reason": "两张卡表示同一跨年份活动身份。",
                }
            ],
            "uncompiled_parent_segments": [
                {
                    "start_block_id": "p0001-b0001",
                    "end_block_id": "p0001-b0001",
                    "reason_kind": "structural_only",
                    "reason": "父标题只提供结构。",
                }
            ],
        },
    )

    snapshot = await ParentIntegrationRunner(
        model=model,
        exploration=exploration,
        leaf_compilation=compilation,
        blocks=blocks,
        settings=CompilationSettings(max_parallel_parents=2),
    ).run()

    assert snapshot.status == "complete"
    assert snapshot.root_subgraph is not None
    assert len(snapshot.root_subgraph.cards) == 1
    card = snapshot.root_subgraph.cards[0]
    assert card.title == "继往开来杯"
    assert len(card.origin_card_ids) == 2
    assert model.stages == ["route", "decision"]


@pytest.mark.asyncio
async def test_parent_owned_source_can_create_upper_workflow_and_edges() -> None:
    exploration, compilation, blocks = _inputs(
        parent_text="大型赛事运营包括行政合规和物资保障两个模块。",
        parent_source_role="content_source",
        first_kind="workflow",
        second_kind="workflow",
    )
    model = ParentModel(
        route={
            "overview": "父节点说明两个孩子共同组成一个上层工作结构。",
            "candidate_groups": [
                {
                    "kind": "possible_parent_source_link",
                    "card_ids": [
                        "region-0002/card-1",
                        "region-0003/card-1",
                    ],
                    "reason": "父节点原文同时统领两个孩子。",
                }
            ],
        },
        decision={
            "new_cards": [
                {
                    "card_id": "card-1",
                    "definition": {
                        "kind": "workflow",
                        "title": "大型赛事运营",
                        "summary": "由两个模块组成的大型赛事运营工作流。",
                        "content": {
                            "goal_markdown": "完成大型赛事运营。",
                            "entry_meaning_markdown": "大型赛事开始筹备。",
                        },
                        "evidence_ids": ["evidence-1"],
                    },
                }
            ],
            "add_edges": [
                {
                    "edge_id": "edge-1",
                    "from_card_id": "card-1",
                    "to_card_id": "region-0002/card-1",
                    "relation_type": "contains",
                    "evidence_ids": ["evidence-1"],
                },
                {
                    "edge_id": "edge-2",
                    "from_card_id": "card-1",
                    "to_card_id": "region-0003/card-1",
                    "relation_type": "contains",
                    "evidence_ids": ["evidence-1"],
                },
            ],
            "source_evidence": [
                {
                    "evidence_id": "evidence-1",
                    "start_block_id": "p0001-b0001",
                    "end_block_id": "p0001-b0001",
                    "role": "basis",
                    "note_markdown": "父节点原文说明两个模块属于同一上层结构。",
                }
            ],
        },
    )

    snapshot = await ParentIntegrationRunner(
        model=model,
        exploration=exploration,
        leaf_compilation=compilation,
        blocks=blocks,
    ).run()

    assert snapshot.status == "complete"
    assert snapshot.root_subgraph is not None
    assert len(snapshot.root_subgraph.cards) == 3
    assert len(snapshot.root_subgraph.edges) == 2
    assert any(card.title == "大型赛事运营" for card in snapshot.root_subgraph.cards)


@pytest.mark.asyncio
async def test_parent_without_candidates_skips_decision_call() -> None:
    exploration, compilation, blocks = _inputs(
        parent_text="# 测试手册",
        parent_source_role="structural_context",
    )
    model = ParentModel(
        route={
            "overview": "两个孩子没有需要在这一层处理的关系。",
            "candidate_groups": [],
        },
        decision={},
    )

    snapshot = await ParentIntegrationRunner(
        model=model,
        exploration=exploration,
        leaf_compilation=compilation,
        blocks=blocks,
    ).run()

    assert snapshot.status == "complete"
    assert snapshot.root_subgraph is not None
    assert len(snapshot.root_subgraph.cards) == 2
    assert snapshot.model_calls == 1
    assert model.stages == ["route"]


def _structural_parent_coverage() -> list[dict[str, str]]:
    return [
        {
            "start_block_id": "p0001-b0001",
            "end_block_id": "p0001-b0001",
            "reason_kind": "structural_only",
            "reason": "父节点原文只提供结构背景。",
        }
    ]


@pytest.mark.asyncio
async def test_parent_can_repair_two_consecutive_validation_errors() -> None:
    exploration, compilation, blocks = _inputs(
        parent_text="# 测试手册",
        parent_source_role="structural_context",
    )
    model = ParentModel(
        route={
            "overview": "需要检查第一张卡片。",
            "candidate_groups": [
                {
                    "kind": "possible_correction",
                    "card_ids": ["region-0002/card-1"],
                    "reason": "检查内容字段和父节点依据。",
                }
            ],
        },
        decision=[
            {
                "new_cards": [
                    {
                        "card_id": "card-1",
                        "definition": {
                            "kind": "principle",
                            "title": "非法字段示例",
                            "summary": "第一次输出包含非法字段。",
                            "content": {
                                "statement_markdown": "测试。",
                                "rationale_markdown": "测试。",
                                "scope_markdown": "非法字段。",
                            },
                            "evidence_ids": ["evidence-1"],
                        },
                    }
                ],
                "source_evidence": [
                    {
                        "evidence_id": "evidence-1",
                        "start_block_id": "p0001-b0001",
                        "end_block_id": "p0001-b0001",
                        "role": "basis",
                        "note_markdown": "测试依据。",
                    }
                ],
            },
            {
                "source_evidence": [
                    {
                        "evidence_id": "evidence-1",
                        "start_block_id": "p0001-b0001",
                        "end_block_id": "p0001-b0001",
                        "role": "context",
                        "note_markdown": "未被任何操作引用的背景。",
                    }
                ]
            },
            {"uncompiled_parent_segments": _structural_parent_coverage()},
        ],
    )

    snapshot = await ParentIntegrationRunner(
        model=model,
        exploration=exploration,
        leaf_compilation=compilation,
        blocks=blocks,
    ).run()

    assert snapshot.status == "complete"
    assert snapshot.model_calls == 4
    assert model.stages == ["route", "decision", "decision", "decision"]


@pytest.mark.asyncio
async def test_read_only_neighbor_cannot_be_used_as_new_edge_endpoint() -> None:
    exploration, compilation, blocks = _inputs(
        parent_text="# 测试手册",
        parent_source_role="structural_context",
        second_kind="workflow",
    )
    model = ParentModel(
        route={
            "overview": "只展开第一张卡片。",
            "candidate_groups": [
                {
                    "kind": "possible_correction",
                    "card_ids": ["region-0002/card-1"],
                    "reason": "只检查第一张卡片。",
                }
            ],
        },
        decision=[
            {
                "add_edges": [
                    {
                        "edge_id": "edge-1",
                        "from_card_id": "region-0002/card-1",
                        "to_card_id": "region-0003/card-1",
                        "relation_type": "uses",
                        "evidence_ids": ["region-0002/evidence-1"],
                    }
                ],
                "uncompiled_parent_segments": _structural_parent_coverage(),
            },
            {"uncompiled_parent_segments": _structural_parent_coverage()},
        ],
    )

    snapshot = await ParentIntegrationRunner(
        model=model,
        exploration=exploration,
        leaf_compilation=compilation,
        blocks=blocks,
    ).run()

    assert snapshot.status == "complete"
    assert snapshot.root_subgraph is not None
    assert snapshot.root_subgraph.edges == []
    assert model.stages == ["route", "decision", "decision"]


@pytest.mark.asyncio
async def test_invalid_relation_endpoint_kinds_trigger_repair() -> None:
    exploration, compilation, blocks = _inputs(
        parent_text="# 测试手册",
        parent_source_role="structural_context",
    )
    selected = ["region-0002/card-1", "region-0003/card-1"]
    model = ParentModel(
        route={
            "overview": "检查两张活动卡片之间的关系。",
            "candidate_groups": [
                {
                    "kind": "possible_cross_child_link",
                    "card_ids": selected,
                    "reason": "检查是否存在关系。",
                }
            ],
        },
        decision=[
            {
                "add_edges": [
                    {
                        "edge_id": "edge-1",
                        "from_card_id": selected[0],
                        "to_card_id": selected[1],
                        "relation_type": "contains",
                        "evidence_ids": [
                            "region-0002/evidence-1",
                            "region-0003/evidence-1",
                        ],
                    }
                ],
                "uncompiled_parent_segments": _structural_parent_coverage(),
            },
            {"uncompiled_parent_segments": _structural_parent_coverage()},
        ],
    )

    snapshot = await ParentIntegrationRunner(
        model=model,
        exploration=exploration,
        leaf_compilation=compilation,
        blocks=blocks,
    ).run()

    assert snapshot.status == "complete"
    assert snapshot.root_subgraph is not None
    assert snapshot.root_subgraph.edges == []
    assert model.stages == ["route", "decision", "decision"]
