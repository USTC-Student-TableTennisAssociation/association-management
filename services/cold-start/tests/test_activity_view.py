from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from cold_start.activity_view import (
    ActivityPerspectiveRunner,
    create_activity_view_paths,
    open_activity_view_paths,
)
from cold_start.activity_view.models import (
    AssertionProjectionOutput,
    ObjectCardDecision,
    ParentSynthesisOutput,
    RelationDecision,
)
from cold_start.compilation.models import (
    Assertion,
    Evidence,
    FullCompilationSnapshot,
    MemoryObject,
    MemoryPackage,
    TemporalScope,
)
from cold_start.config import ActivityViewSettings
from cold_start.document.models import ParsedBlock
from cold_start.global_exploration.models import GlobalExplorationSnapshot, SourceMetadata
from cold_start.llm.base import ModelTurn, ThinkingMode
from cold_start.region_tree.models import (
    RegionNode,
    RegionTreeSnapshot,
    SourceIssue,
    SourceSegment,
)


class ActivityViewFakeModel:
    def __init__(
        self,
        *,
        break_first_object_output: bool = False,
        request_reference_review: bool = False,
        restore_omitted_guidance: bool = False,
        synthesize_parent_relation: bool = False,
        reject_parent_relation: bool = False,
        support_organization_attribute: bool = False,
        fail_parent_recovery: bool = False,
        fail_global_review: bool = False,
    ) -> None:
        self.calls: list[dict[str, object]] = []
        self.break_first_object_output = break_first_object_output
        self.request_reference_review = request_reference_review
        self.restore_omitted_guidance = restore_omitted_guidance
        self.synthesize_parent_relation = synthesize_parent_relation
        self.reject_parent_relation = reject_parent_relation
        self.support_organization_attribute = support_organization_attribute
        self.fail_parent_recovery = fail_parent_recovery
        self.fail_global_review = fail_global_review
        self.guidance_review_calls = 0

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
        self.calls.append(
            {
                "messages": messages,
                "tools": tools,
                "tool_choice": tool_choice,
                "request_label": request_label,
                "thinking": thinking,
            }
        )
        if request_label.startswith("视角边界"):
            return _turn(
                {
                    "perspective_definition_markdown": (
                        "保留具体活动、执行工作、运营指导和直接资源约束。"
                    ),
                    "included_areas": [
                        {
                            "name": "活动执行",
                            "description_markdown": "活动分类、场地申请与人员执行。",
                        }
                    ],
                    "excluded_areas": [
                        {
                            "name": "无关视觉细节",
                            "description_markdown": "不影响活动运营的存档样式。",
                        }
                    ],
                    "boundary_rules": ["组织状态只有直接构成运营条件时才保留。"],
                },
                "先从全部对象索引规划活动运营语义边界。",
            )
        if request_label.startswith("对象分类"):
            prompt = "\n".join(
                str(item.get("content", "")) for item in messages if item.get("role") == "user"
            )
            if self.break_first_object_output:
                self.break_first_object_output = False
                return _turn(
                    {
                        "decisions": [_card("region-0002/obj-1", "activity", "activity_flow")],
                    },
                    "第一次故意遗漏大部分 Object。",
                )
            candidates = [
                _card("region-0002/obj-1", "activity", "activity_flow"),
                _card("region-0002/obj-2", "activity_trait", "activity_flow"),
                _card("region-0004/obj-1", "workflow", "activity_flow"),
                (
                    _support("region-0005/obj-1")
                    if self.support_organization_attribute
                    else _card(
                        "region-0005/obj-1",
                        "organization",
                        "organization_context",
                    )
                ),
                _outside("region-0006/obj-1"),
            ]
            return _turn(
                {
                    "decisions": [
                        item
                        for item in candidates
                        if f'"object_id": "{item["object_id"]}"' in prompt
                    ],
                },
                "为已由投影带入视角的 Object 分配角色。",
            )
        if request_label.startswith("叙述投影"):
            prompt = str(messages[-1]["content"])
            output: dict[str, object] = {
                "attributes": [
                    {
                        "assertion_id": "region-0004/assert-1",
                        "object_id": "region-0004/obj-1",
                        "semantic_kind": "rule",
                        "lane_tags": ["guidance"],
                        "reason": "这是场地申请步骤的明确要求。",
                    },
                    {
                        "assertion_id": "region-0005/assert-1",
                        "object_id": "region-0005/obj-1",
                        "semantic_kind": "fact",
                        "lane_tags": ["organization_context"],
                        "reason": "这是手册编写时期的组织状态。",
                    },
                ],
                "relations": [
                    {
                        "assertion_id": "region-0002/assert-1",
                        "relation_pattern": "classification",
                        "participants": [
                            {
                                "object_id": "region-0002/obj-1",
                                "role": "subject",
                            },
                            {
                                "object_id": "region-0002/obj-2",
                                "role": "category",
                            },
                        ],
                        "semantic_kind": "fact",
                        "lane_tags": ["activity_flow"],
                        "derivation_kind": "direct_source",
                        "reason": "原文直接把继往开来杯归为大型比赛。",
                    }
                ],
                "reference_review_requests": [],
                "omitted_assertion_ids": ["region-0006/assert-1"],
            }
            if self.request_reference_review:
                output["reference_review_requests"] = [
                    {
                        "assertion_id": "region-0003/assert-1",
                        "candidate_object_ids": ["region-0004/obj-1"],
                        "intended_projection": "relation",
                        "reason": "该实践需要场地申请作为作用位置。",
                    }
                ]
            else:
                relations = output["relations"]
                assert isinstance(relations, list)
                relations.append(
                    {
                        "assertion_id": "region-0003/assert-1",
                        "relation_pattern": "guidance_application",
                        "participants": [
                            {
                                "object_id": "region-0004/obj-1",
                                "role": "anchor",
                            },
                            {
                                "object_id": "region-0002/obj-1",
                                "role": "scope",
                            },
                        ],
                        "semantic_kind": "practice",
                        "lane_tags": ["guidance"],
                        "derivation_kind": "direct_source",
                        "reason": "这是继往开来杯在场地申请位置的历史实践。",
                    }
                )
            if self.restore_omitted_guidance:
                attributes = output["attributes"]
                assert isinstance(attributes, list)
                output["attributes"] = [
                    item for item in attributes if item["assertion_id"] != "region-0004/assert-1"
                ]
                omitted = output["omitted_assertion_ids"]
                assert isinstance(omitted, list)
                omitted.append("region-0004/assert-1")
            present_ids = {
                assertion_id
                for assertion_id in (
                    "region-0002/assert-1",
                    "region-0003/assert-1",
                    "region-0004/assert-1",
                    "region-0005/assert-1",
                    "region-0006/assert-1",
                )
                if f'"assertion_id": "{assertion_id}"' in prompt
            }
            for key in ("attributes", "relations", "reference_review_requests"):
                values = output[key]
                assert isinstance(values, list)
                output[key] = [item for item in values if item["assertion_id"] in present_ids]
            output["omitted_assertion_ids"] = [
                item for item in output["omitted_assertion_ids"] if item in present_ids
            ]
            return _turn(
                output,
                "每条 Assertion 只选择属性、关系或省略之一。",
            )
        if request_label.startswith("引用复查"):
            return _turn(
                {
                    "assertion_id": "region-0003/assert-1",
                    "confirmed_object_ids": ["region-0004/obj-1"],
                    "rejected_object_ids": [],
                    "ambiguous_object_ids": [],
                    "revised_statement_template_markdown": (
                        "{{object:region-0002/obj-1}}过去通常在"
                        "{{object:region-0004/obj-1}}中申请两个场地。"
                    ),
                    "reason": "Evidence 中的场地申请明确指向已有工作步骤 Object。",
                },
                "只根据该 Assertion 的 Evidence 确认对象指认。",
            )
        if request_label.startswith("叙述重投影"):
            return _turn(
                {
                    "attributes": [],
                    "relations": [
                        {
                            "assertion_id": "region-0003/assert-1",
                            "relation_pattern": "guidance_application",
                            "participants": [
                                {
                                    "object_id": "region-0004/obj-1",
                                    "role": "anchor",
                                },
                                {
                                    "object_id": "region-0002/obj-1",
                                    "role": "scope",
                                },
                            ],
                            "semantic_kind": "practice",
                            "lane_tags": ["guidance"],
                            "derivation_kind": "direct_source",
                            "reason": "补全引用后可形成有依据的实践作用关系。",
                        }
                    ],
                    "reference_review_requests": [],
                    "omitted_assertion_ids": [],
                },
                "只重投影受引用修订影响的 Assertion。",
            )
        if request_label.startswith("父级恢复"):
            if self.fail_parent_recovery:
                return _turn(
                    {"relations": [{"relation_pattern": "unsupported"}], "issues": []},
                    "故意持续提交不合法的父节点关系。",
                )
            relations = []
            if self.synthesize_parent_relation:
                relations.append(
                    {
                        "relation_pattern": "workflow_use",
                        "participants": [
                            {
                                "object_id": "region-0002/obj-1",
                                "role": "workflow_user",
                            },
                            {"object_id": "region-0004/obj-1", "role": "workflow"},
                        ],
                        "semantic_kind": "practice",
                        "lane_tags": ["activity_flow"],
                        "proof_kind": "direct_statement",
                        "supporting_assertion_ids": ["region-0003/assert-1"],
                        "proof_evidence_ids": ["region-0003/evidence-1"],
                        "supporting_child_node_ids": ["region-0002", "region-0004"],
                        "temporal_scope": {
                            "kind": "unknown",
                            "display": "时间不明",
                            "start": None,
                            "end": None,
                            "precision": "unspecified",
                        },
                        "temporal_basis_markdown": "原文没有给出可定位时间。",
                        "reason": "同一条来源叙述同时指认活动与场地申请工作流。",
                    }
                )
            return _turn(
                {"relations": relations, "issues": []},
                "只恢复被区域切分隐藏的来源关系。",
            )
        if request_label.startswith("全局复核"):
            if self.fail_global_review:
                raise RuntimeError("模拟线路审查连接失败")
            lane = request_label.split("·")[1]
            changes = []
            admissions = []
            if lane == "activity_flow":
                candidate_ids = sorted(
                    set(
                        re.findall(
                            r'"parent_relation_key": "(parent-relation:[^"]+)"',
                            str(messages[-1]["content"]),
                        )
                    )
                )
                admissions = [
                    {
                        "candidate_id": candidate_id,
                        "status": ("reject" if self.reject_parent_relation else "accept"),
                        "reason": (
                            "共同出现不足以证明工作流使用关系。"
                            if self.reject_parent_relation
                            else "同一条 Evidence 直接支持活动使用该工作流。"
                        ),
                    }
                    for candidate_id in candidate_ids
                ]
            if lane == "guidance":
                self.guidance_review_calls += 1
                if self.restore_omitted_guidance and self.guidance_review_calls == 1:
                    changes.append(
                        {
                            "target_kind": "assertion",
                            "target_id": "region-0004/assert-1",
                            "action": "add_lane",
                            "reason": "场地申请时限会稳定影响活动执行。",
                        }
                    )
            return _turn(
                {
                    "lane": lane,
                    "parent_candidate_admissions": admissions,
                    "changes": changes,
                    "unresolved_issues": [],
                },
                "按当前线路硬合同只输出最小差异。",
            )
        if request_label.startswith("定向修复"):
            prompt = str(messages[-1]["content"])
            attributes = []
            if '"assertion_id": "region-0004/assert-1"' in prompt:
                attributes.append(
                    {
                        "assertion_id": "region-0004/assert-1",
                        "object_id": "region-0004/obj-1",
                        "semantic_kind": "rule",
                        "lane_tags": ["guidance"],
                        "reason": "这是场地申请步骤的明确要求。",
                    }
                )
            return _turn(
                {
                    "attributes": attributes,
                    "relations": [],
                    "reference_review_requests": [],
                    "omitted_assertion_ids": [],
                },
                "将全局复核恢复的 Assertion 挂回已有活动运营卡。",
            )
        raise AssertionError(f"未预期的模型调用：{request_label}")


def _turn(value: dict[str, object], reasoning: str) -> ModelTurn:
    return ModelTurn(
        content=json.dumps(value, ensure_ascii=False),
        reasoning_content=reasoning,
    )


def _card(object_id: str, role: str, lane: str) -> dict[str, object]:
    return {
        "object_id": object_id,
        "status": "view_card",
        "role": role,
        "reason": "该 Object 在活动运营视角中需要持续指认。",
    }


def _outside(object_id: str) -> dict[str, object]:
    return {
        "object_id": object_id,
        "status": "outside_view",
        "role": None,
        "reason": "该 Object 只属于基础记忆，不进入活动运营视角。",
    }


def _support(object_id: str) -> dict[str, object]:
    return {
        "object_id": object_id,
        "status": "support_reference",
        "role": None,
        "reason": "保留相关 Assertion，但该 Object 不生成独立业务卡。",
    }


def _source() -> SourceMetadata:
    return SourceMetadata(
        path="handbook.pdf",
        title="测试手册",
        sha256="a" * 64,
        parser="fake",
        page_count=1,
        block_count=6,
    )


def _blocks() -> tuple[ParsedBlock, ...]:
    texts = [
        "# 测试手册",
        "继往开来杯是大型比赛。",
        "继往开来杯过去通常在场地申请中申请两个场地。",
        "场地申请必须提前完成。",
        "当前乒协核心干事约15人。",
        "BBS存档使用蓝色边框。",
    ]
    return tuple(
        ParsedBlock(
            block_id=f"p0001-b{index:04d}",
            order=index - 1,
            block_type="heading" if index == 1 else "paragraph",
            source_pages=(1,),
            heading_level=1 if index == 1 else None,
            heading_path=("测试手册",),
            markdown=text,
        )
        for index, text in enumerate(texts, 1)
    )


def _exploration() -> GlobalExplorationSnapshot:
    root = RegionNode(
        node_id="region-0001",
        parent_id=None,
        depth=0,
        label="测试手册",
        introduction="介绍活动和组织状态。",
        start_block_id="p0001-b0001",
        end_block_id="p0001-b0006",
        source_pages=[1],
        status="branch",
        owned_segments=[
            SourceSegment(
                start_block_id="p0001-b0001",
                end_block_id="p0001-b0001",
            )
        ],
        owned_source_role="structural_context",
        child_ids=[f"region-{index:04d}" for index in range(2, 7)],
    )
    leaves = [
        RegionNode(
            node_id=f"region-{index:04d}",
            parent_id="region-0001",
            depth=1,
            label=f"内容{index}",
            introduction="一个独立业务语义区域。",
            start_block_id=f"p0001-b{index:04d}",
            end_block_id=f"p0001-b{index:04d}",
            source_pages=[1],
            status="leaf",
            owned_segments=[
                SourceSegment(
                    start_block_id=f"p0001-b{index:04d}",
                    end_block_id=f"p0001-b{index:04d}",
                )
            ],
            owned_source_role="content_source",
        )
        for index in range(2, 7)
    ]
    return GlobalExplorationSnapshot(
        created_at=datetime.now(UTC),
        source=_source(),
        document_context_markdown="这是一份协会活动运营手册。",
        context_model_calls=1,
        region_tree=RegionTreeSnapshot(
            status="frozen",
            root_node_id="region-0001",
            nodes=[root, *leaves],
            leaf_node_ids=[item.node_id for item in leaves],
            content_node_ids=[item.node_id for item in leaves],
            structural_context_node_ids=["region-0001"],
        ),
    )


def _compilation(*, missing_practice_reference: bool = False) -> FullCompilationSnapshot:
    objects = [
        MemoryObject(object_id="region-0002/obj-1", label="继往开来杯", aliases=[]),
        MemoryObject(object_id="region-0002/obj-2", label="大型比赛", aliases=[]),
        MemoryObject(object_id="region-0004/obj-1", label="场地申请", aliases=[]),
        MemoryObject(object_id="region-0005/obj-1", label="乒协", aliases=[]),
        MemoryObject(object_id="region-0006/obj-1", label="蓝色边框", aliases=[]),
    ]
    values = [
        (
            "region-0002/assert-1",
            "{{object:region-0002/obj-1}}是{{object:region-0002/obj-2}}。",
        ),
        (
            "region-0003/assert-1",
            (
                "{{object:region-0002/obj-1}}过去通常在场地申请中申请两个场地。"
                if missing_practice_reference
                else "{{object:region-0002/obj-1}}过去通常在"
                "{{object:region-0004/obj-1}}中申请两个场地。"
            ),
        ),
        (
            "region-0004/assert-1",
            "{{object:region-0004/obj-1}}必须提前完成。",
        ),
        (
            "region-0005/assert-1",
            "当前{{object:region-0005/obj-1}}核心干事约15人。",
        ),
        (
            "region-0006/assert-1",
            "BBS存档使用{{object:region-0006/obj-1}}。",
        ),
    ]
    assertions = [
        Assertion(
            assertion_id=assertion_id,
            mode="record",
            statement_template_markdown=statement,
            holder_object_id=None,
            temporal_scope=TemporalScope(
                kind=("point" if assertion_id == "region-0005/assert-1" else "unknown"),
                display=("手册编写时期" if assertion_id == "region-0005/assert-1" else "时间不明"),
                start=("手册编写时期" if assertion_id == "region-0005/assert-1" else None),
                end=None,
                precision="unspecified",
            ),
            temporal_basis_markdown=(
                "原文使用“当前”，结合文档成文背景推断。"
                if assertion_id == "region-0005/assert-1"
                else "原文和上下文没有给出可定位时间。"
            ),
            uncertainty_markdown=None,
            evidence_ids=[f"region-{index:04d}/evidence-1"],
        )
        for index, (assertion_id, statement) in enumerate(values, 2)
    ]
    evidence = [
        Evidence(
            evidence_id=f"region-{index:04d}/evidence-1",
            start_block_id=f"p0001-b{index:04d}",
            end_block_id=f"p0001-b{index:04d}",
            note_markdown=None,
        )
        for index in range(2, 7)
    ]
    return FullCompilationSnapshot(
        created_at=datetime.now(UTC),
        source=_source(),
        region_tree_schema_version="continuous-region-tree.v1",
        root_node_id="region-0001",
        root_package=MemoryPackage(
            objects=objects,
            assertions=assertions,
            evidence=evidence,
        ),
        node_results=[],
        content_source_block_ids=[f"p0001-b{index:04d}" for index in range(2, 7)],
        covered_block_ids=[f"p0001-b{index:04d}" for index in range(2, 7)],
        uncovered_block_ids=[],
        structural_context_block_ids=["p0001-b0001"],
        model_calls=0,
        warnings=[],
    )


def _settings() -> ActivityViewSettings:
    return ActivityViewSettings(
        max_parallel_groups=1,
        max_objects_per_group=20,
        max_assertions_per_group=20,
    )


@pytest.mark.asyncio
async def test_builds_only_object_cards_and_projects_each_assertion_once(
    tmp_path: Path,
) -> None:
    compilation_path = tmp_path / "basic-compilation.json"
    compilation_path.write_text(_compilation().model_dump_json(), encoding="utf-8")
    paths = create_activity_view_paths(compilation_path)
    model = ActivityViewFakeModel()
    snapshot = await ActivityPerspectiveRunner(
        model=model,
        source_compilation_path=compilation_path,
        compilation=_compilation(),
        exploration=_exploration(),
        blocks=_blocks(),
        paths=paths,
        settings=_settings(),
    ).run()

    assert snapshot.schema_version == "activity-operations-perspective.v10"
    assert len(snapshot.object_cards) == 4
    assert all(item.card_id.startswith("object:") for item in snapshot.object_cards)
    assert {item.role for item in snapshot.object_cards} == {
        "activity",
        "activity_trait",
        "workflow",
        "organization",
    }
    assert len(snapshot.attributes) == 2
    assert len(snapshot.relations) == 2
    assert snapshot.relations[0].relation_pattern == "classification"
    assert snapshot.relations[0].source_assertion.assertion_id == "region-0002/assert-1"
    assert snapshot.omitted_object_ids == ["region-0006/obj-1"]
    assert snapshot.support_reference_object_ids == []
    assert snapshot.outside_view_object_ids == ["region-0006/obj-1"]
    assert snapshot.omitted_assertion_ids == ["region-0006/assert-1"]
    projected = {
        *[item.source_assertion.assertion_id for item in snapshot.attributes],
        *[item.source_assertion.assertion_id for item in snapshot.relations],
        *snapshot.omitted_assertion_ids,
    }
    assert projected == {item.assertion_id for item in _compilation().root_package.assertions}
    assert snapshot.model_calls == 11
    assert all(call["thinking"] == "enabled" for call in model.calls)
    assert all(call["tools"] == () for call in model.calls)
    assert str(model.calls[0]["request_label"]).startswith("视角边界")
    assert str(model.calls[-1]["request_label"]).startswith("全局复核")
    projection_prompts = "\n".join(
        str(item["messages"][-1]["content"])
        for item in model.calls
        if str(item["request_label"]).startswith("叙述投影")
    )
    assert '"graph_component_id": "component-0001"' in projection_prompts
    assert '"graph_component_id": "component-0002"' in projection_prompts
    first_projection_call = next(
        item for item in model.calls if str(item["request_label"]).startswith("叙述投影")
    )
    assert "不要为了“保留”次要 Object 而把" in str(first_projection_call["messages"][0]["content"])
    object_calls = [
        item for item in model.calls if str(item["request_label"]).startswith("对象分类")
    ]
    object_prompt = "\n".join(str(item["messages"][-1]["content"]) for item in object_calls)
    assert len(object_calls) == 2
    assert all(
        "Workflow 再递归包含子 Workflow" in str(item["messages"][0]["content"])
        for item in object_calls
    )
    assert "assertion_samples" not in object_prompt
    assert "这些 Object 在前一阶段形成的属性或关系投影" not in object_prompt
    assert "region-0006/assert-1" not in object_prompt
    assert "region-0005/assert-1" in object_prompt
    parent_call = next(
        item for item in model.calls if str(item["request_label"]).startswith("父级恢复")
    )
    parent_system_prompt = str(parent_call["messages"][0]["content"])
    parent_user_prompt = str(parent_call["messages"][-1]["content"])
    assert "`workflow_user`=activity/activity_trait" in parent_system_prompt
    assert "`dependency` 可为 workflow、work_step" in parent_system_prompt
    assert "允许多个原子 Assertion 联合覆盖端点" in parent_system_prompt
    assert "region-0003/evidence-1" in parent_user_prompt
    assert "region-0005/evidence-1" not in parent_user_prompt
    assert "region-0006/evidence-1" not in parent_user_prompt
    assert paths.snapshot_json.is_file()
    assert paths.boundary_plan_json.is_file()
    assert paths.cards_json.is_file()
    assert paths.reference_reviews_json.is_file()
    assert paths.reference_amendments_json.is_file()
    assert paths.attributes_json.is_file()
    assert paths.relations_json.is_file()
    assert paths.parent_recovery_json.is_file()
    assert paths.review_rounds_json.is_file()
    assert paths.omissions_json.is_file()
    checkpoints = list(paths.group_checkpoints.glob("*.json"))
    assert len(checkpoints) == 11
    assert any(item.name.startswith("recover_parent_relations-") for item in checkpoints)
    assert len(list(paths.group_checkpoints.glob("review_lane-*.json"))) == 4


@pytest.mark.asyncio
async def test_parent_recovery_requires_lane_admission_and_keeps_provenance(
    tmp_path: Path,
) -> None:
    compilation = _compilation()
    compilation_path = tmp_path / "basic-compilation.json"
    compilation_path.write_text(compilation.model_dump_json(), encoding="utf-8")

    snapshot = await ActivityPerspectiveRunner(
        model=ActivityViewFakeModel(synthesize_parent_relation=True),
        source_compilation_path=compilation_path,
        compilation=compilation,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=create_activity_view_paths(compilation_path),
        settings=_settings(),
    ).run()

    relation = next(
        item for item in snapshot.relations if item.derivation_kind == "parent_recovery"
    )
    assert relation.source_assertion is None
    assert {item.assertion_id for item in relation.supporting_assertions} == {
        "region-0003/assert-1",
    }
    assert relation.source_region_node_ids == [
        "region-0001",
        "region-0002",
        "region-0004",
    ]
    assert relation.parent_proof_kind == "direct_statement"
    assert relation.proof_evidence_ids == ["region-0003/evidence-1"]
    assert relation.synthesized_temporal_scope is not None
    assert relation.synthesized_temporal_scope.kind == "unknown"
    assert "没有给出可定位时间" in relation.synthesized_temporal_basis_markdown


@pytest.mark.asyncio
async def test_rejected_parent_candidate_never_enters_formal_graph(tmp_path: Path) -> None:
    compilation = _compilation()
    compilation_path = tmp_path / "basic-compilation.json"
    compilation_path.write_text(compilation.model_dump_json(), encoding="utf-8")

    snapshot = await ActivityPerspectiveRunner(
        model=ActivityViewFakeModel(
            synthesize_parent_relation=True,
            reject_parent_relation=True,
        ),
        source_compilation_path=compilation_path,
        compilation=compilation,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=create_activity_view_paths(compilation_path),
        settings=_settings(),
    ).run()

    assert all(item.derivation_kind != "parent_recovery" for item in snapshot.relations)
    assert any(item.kind == "insufficient_support" for item in snapshot.parent_recovery_issues)


@pytest.mark.asyncio
async def test_parent_failure_is_recorded_without_aborting_snapshot(tmp_path: Path) -> None:
    compilation = _compilation()
    compilation_path = tmp_path / "basic-compilation.json"
    compilation_path.write_text(compilation.model_dump_json(), encoding="utf-8")
    paths = create_activity_view_paths(compilation_path)

    snapshot = await ActivityPerspectiveRunner(
        model=ActivityViewFakeModel(fail_parent_recovery=True),
        source_compilation_path=compilation_path,
        compilation=compilation,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=paths,
        settings=_settings(),
    ).run()

    failure = next(
        item for item in snapshot.parent_recovery_issues if item.kind == "synthesis_failure"
    )
    assert "父节点恢复未通过协议校验" in failure.reason
    assert paths.snapshot_json.is_file()
    assert not list(paths.group_checkpoints.glob("recover_parent_relations-*.json"))


@pytest.mark.asyncio
async def test_parent_checkpoint_is_reused_on_resume(tmp_path: Path) -> None:
    compilation = _compilation()
    compilation_path = tmp_path / "basic-compilation.json"
    compilation_path.write_text(compilation.model_dump_json(), encoding="utf-8")
    paths = create_activity_view_paths(compilation_path)

    first_model = ActivityViewFakeModel(synthesize_parent_relation=True)
    await ActivityPerspectiveRunner(
        model=first_model,
        source_compilation_path=compilation_path,
        compilation=compilation,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=paths,
        settings=_settings(),
    ).run()
    assert any(str(item["request_label"]).startswith("父级恢复") for item in first_model.calls)
    assert list(paths.group_checkpoints.glob("recover_parent_relations-*.json"))

    resumed_model = ActivityViewFakeModel(synthesize_parent_relation=True)
    await ActivityPerspectiveRunner(
        model=resumed_model,
        source_compilation_path=compilation_path,
        compilation=compilation,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=paths,
        settings=_settings(),
    ).run()

    assert not any(
        str(item["request_label"]).startswith("父级恢复") for item in resumed_model.calls
    )


def test_object_card_lanes_are_derived_from_accepted_projections() -> None:
    lane_map = ActivityPerspectiveRunner._derive_object_lanes(
        attributes=[],
        relations=[
            RelationDecision.model_validate(
                {
                    "assertion_id": "assert-1",
                    "relation_pattern": "classification",
                    "participants": [
                        {"object_id": "obj-1", "role": "subject"},
                        {"object_id": "obj-2", "role": "category"},
                    ],
                    "semantic_kind": "fact",
                    "lane_tags": ["activity_flow"],
                    "derivation_kind": "direct_source",
                    "reason": "测试",
                }
            )
        ],
    )

    assert lane_map == {
        "obj-1": ["activity_flow"],
        "obj-2": ["activity_flow"],
    }


@pytest.mark.asyncio
async def test_resume_reuses_validated_group_checkpoints(tmp_path: Path) -> None:
    compilation = _compilation()
    compilation_path = tmp_path / "basic-compilation.json"
    compilation_path.write_text(compilation.model_dump_json(), encoding="utf-8")
    paths = create_activity_view_paths(compilation_path)
    first_model = ActivityViewFakeModel()
    await ActivityPerspectiveRunner(
        model=first_model,
        source_compilation_path=compilation_path,
        compilation=compilation,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=paths,
        settings=_settings(),
    ).run()

    paths.snapshot_json.unlink()
    resumed_paths = open_activity_view_paths(paths.directory)
    resumed_model = ActivityViewFakeModel()
    snapshot = await ActivityPerspectiveRunner(
        model=resumed_model,
        source_compilation_path=compilation_path,
        compilation=compilation,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=resumed_paths,
        settings=_settings(),
    ).run()

    assert len(resumed_model.calls) == 0
    assert not any(
        str(item["request_label"]).startswith("父级恢复") for item in resumed_model.calls
    )
    assert snapshot.model_calls == 11
    assert resumed_paths.snapshot_json.is_file()


@pytest.mark.asyncio
async def test_global_audit_can_restore_locally_omitted_guidance(
    tmp_path: Path,
) -> None:
    compilation = _compilation()
    compilation_path = tmp_path / "basic-compilation.json"
    compilation_path.write_text(compilation.model_dump_json(), encoding="utf-8")
    model = ActivityViewFakeModel(restore_omitted_guidance=True)

    snapshot = await ActivityPerspectiveRunner(
        model=model,
        source_compilation_path=compilation_path,
        compilation=compilation,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=create_activity_view_paths(compilation_path),
        settings=_settings(),
    ).run()

    guidance_change = next(
        change
        for review in snapshot.review_rounds[0].lane_reviews
        if review.lane == "guidance"
        for change in review.changes
    )
    assert guidance_change.target_id == "region-0004/assert-1"
    assert guidance_change.action == "add_lane"
    restored = next(
        item
        for item in snapshot.attributes
        if item.source_assertion.assertion_id == "region-0004/assert-1"
    )
    assert restored.semantic_kind == "rule"
    assert "region-0004/assert-1" not in snapshot.omitted_assertion_ids
    assert snapshot.model_calls == 17
    repair_call = next(
        item for item in model.calls if str(item["request_label"]).startswith("定向修复")
    )
    repair_system_prompt = str(repair_call["messages"][0]["content"])
    assert '"object_id": "该 Assertion 已明确引用的主体 Object ID"' in repair_system_prompt
    assert "不得输出 `projection_kind`" in repair_system_prompt
    assert "输入中的每个 assertion_id 必须且只能" in repair_system_prompt


@pytest.mark.asyncio
async def test_review_repair_and_lane_checkpoints_are_reused_on_resume(
    tmp_path: Path,
) -> None:
    compilation = _compilation()
    compilation_path = tmp_path / "basic-compilation.json"
    compilation_path.write_text(compilation.model_dump_json(), encoding="utf-8")
    paths = create_activity_view_paths(compilation_path)

    await ActivityPerspectiveRunner(
        model=ActivityViewFakeModel(restore_omitted_guidance=True),
        source_compilation_path=compilation_path,
        compilation=compilation,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=paths,
        settings=_settings(),
    ).run()
    assert list(paths.group_checkpoints.glob("repair_review_issues-*.json"))
    assert list(paths.group_checkpoints.glob("review_lane-*.json"))

    paths.snapshot_json.unlink()
    resumed_model = ActivityViewFakeModel(restore_omitted_guidance=True)
    snapshot = await ActivityPerspectiveRunner(
        model=resumed_model,
        source_compilation_path=compilation_path,
        compilation=compilation,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=open_activity_view_paths(paths.directory),
        settings=_settings(),
    ).run()

    assert resumed_model.calls == []
    assert snapshot.model_calls == 17


@pytest.mark.asyncio
async def test_global_lane_failure_is_recorded_without_aborting_snapshot(
    tmp_path: Path,
) -> None:
    compilation = _compilation()
    compilation_path = tmp_path / "basic-compilation.json"
    compilation_path.write_text(compilation.model_dump_json(), encoding="utf-8")
    paths = create_activity_view_paths(compilation_path)

    snapshot = await ActivityPerspectiveRunner(
        model=ActivityViewFakeModel(fail_global_review=True),
        source_compilation_path=compilation_path,
        compilation=compilation,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=paths,
        settings=_settings(),
    ).run()

    failures = [
        item
        for item in snapshot.unresolved_review_issues
        if item.issue_key.startswith("global-review-failure-")
    ]
    assert len(failures) == 4
    assert paths.snapshot_json.is_file()
    assert not list(paths.group_checkpoints.glob("review_lane-*.json"))


@pytest.mark.asyncio
async def test_review_round_limit_is_reported_as_unresolved(tmp_path: Path) -> None:
    compilation = _compilation()
    compilation_path = tmp_path / "basic-compilation.json"
    compilation_path.write_text(compilation.model_dump_json(), encoding="utf-8")

    snapshot = await ActivityPerspectiveRunner(
        model=ActivityViewFakeModel(restore_omitted_guidance=True),
        source_compilation_path=compilation_path,
        compilation=compilation,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=create_activity_view_paths(compilation_path),
        settings=ActivityViewSettings(
            max_parallel_groups=1,
            max_objects_per_group=20,
            max_assertions_per_group=20,
            max_review_rounds=1,
        ),
    ).run()

    assert len(snapshot.review_rounds) == 1
    assert snapshot.review_rounds[0].state_changed is True
    assert any(item.issue_key == "review-round-limit" for item in snapshot.unresolved_review_issues)


@pytest.mark.asyncio
async def test_retained_attribute_keeps_all_referenced_objects(tmp_path: Path) -> None:
    compilation = _compilation()
    organization_assertion = next(
        item
        for item in compilation.root_package.assertions
        if item.assertion_id == "region-0005/assert-1"
    )
    organization_assertion.statement_template_markdown = (
        "当前{{object:region-0005/obj-1}}把{{object:region-0006/obj-1}}作为统一视觉标识。"
    )
    compilation_path = tmp_path / "basic-compilation.json"
    compilation_path.write_text(compilation.model_dump_json(), encoding="utf-8")

    snapshot = await ActivityPerspectiveRunner(
        model=ActivityViewFakeModel(),
        source_compilation_path=compilation_path,
        compilation=compilation,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=create_activity_view_paths(compilation_path),
        settings=_settings(),
    ).run()

    assert all(item.object_id != "region-0006/obj-1" for item in snapshot.object_cards)
    assert snapshot.omitted_assertion_ids == ["region-0006/assert-1"]
    assert snapshot.support_reference_object_ids == ["region-0006/obj-1"]
    assert snapshot.outside_view_object_ids == []
    assert snapshot.omitted_object_ids == ["region-0006/obj-1"]


@pytest.mark.asyncio
async def test_support_reference_can_carry_retained_attribute(tmp_path: Path) -> None:
    compilation = _compilation()
    compilation_path = tmp_path / "basic-compilation.json"
    compilation_path.write_text(compilation.model_dump_json(), encoding="utf-8")

    snapshot = await ActivityPerspectiveRunner(
        model=ActivityViewFakeModel(support_organization_attribute=True),
        source_compilation_path=compilation_path,
        compilation=compilation,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=create_activity_view_paths(compilation_path),
        settings=_settings(),
    ).run()

    assert all(item.object_id != "region-0005/obj-1" for item in snapshot.object_cards)
    attribute = next(
        item
        for item in snapshot.attributes
        if item.source_assertion.assertion_id == "region-0005/assert-1"
    )
    assert attribute.subject_object_id == "region-0005/obj-1"
    assert "region-0005/obj-1" in snapshot.support_reference_object_ids
    assert "region-0005/assert-1" not in snapshot.omitted_assertion_ids


@pytest.mark.parametrize(
    "role",
    [
        "system",
        "funding_scheme",
        "communication_channel",
        "standard",
        "document",
        "venue",
        "resource",
    ],
)
def test_supporting_object_roles_are_valid(role: str) -> None:
    decision = ObjectCardDecision(
        object_id="region-0001/obj-1",
        status="view_card",
        role=role,
        reason="该支撑对象承载已保留的活动运营 Assertion。",
    )

    assert decision.role == role


@pytest.mark.asyncio
async def test_protocol_repair_keeps_thinking_enabled(tmp_path: Path) -> None:
    compilation_path = tmp_path / "basic-compilation.json"
    compilation_path.write_text(_compilation().model_dump_json(), encoding="utf-8")
    model = ActivityViewFakeModel(break_first_object_output=True)
    snapshot = await ActivityPerspectiveRunner(
        model=model,
        source_compilation_path=compilation_path,
        compilation=_compilation(),
        exploration=_exploration(),
        blocks=_blocks(),
        paths=create_activity_view_paths(compilation_path),
        settings=_settings(),
    ).run()

    assert snapshot.model_calls == 12
    assert all(call["thinking"] == "enabled" for call in model.calls)
    object_calls = [
        item for item in model.calls if str(item["request_label"]).startswith("对象分类")
    ]
    repaired_messages = object_calls[1]["messages"]
    assert "必须完整覆盖输入" in str(repaired_messages[-1]["content"])


@pytest.mark.asyncio
async def test_projection_can_request_scoped_reference_review(tmp_path: Path) -> None:
    compilation = _compilation(missing_practice_reference=True)
    compilation_path = tmp_path / "basic-compilation.json"
    compilation_path.write_text(compilation.model_dump_json(), encoding="utf-8")
    paths = create_activity_view_paths(compilation_path)
    model = ActivityViewFakeModel(request_reference_review=True)

    snapshot = await ActivityPerspectiveRunner(
        model=model,
        source_compilation_path=compilation_path,
        compilation=compilation,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=paths,
        settings=_settings(),
    ).run()

    assert snapshot.model_calls == 14
    assert len(snapshot.reference_reviews) == 1
    assert snapshot.reference_reviews[0].confirmed_object_ids == ["region-0004/obj-1"]
    assert len(snapshot.reference_amendments) == 1
    amendment = snapshot.reference_amendments[0]
    assert amendment.assertion_id == "region-0003/assert-1"
    assert amendment.added_object_ids == ["region-0004/obj-1"]
    practice_relation = next(
        item
        for item in snapshot.relations
        if item.source_assertion.assertion_id == "region-0003/assert-1"
    )
    assert practice_relation.source_assertion.referenced_object_ids == [
        "region-0002/obj-1",
        "region-0004/obj-1",
    ]
    review_call = next(
        item for item in model.calls if str(item["request_label"]).startswith("引用复查")
    )
    review_prompt = str(review_call["messages"][-1]["content"])
    assert "继往开来杯过去通常在场地申请中申请两个场地" in review_prompt
    assert "possible_missing_object_references" in review_prompt
    assert paths.reference_reviews_json.is_file()
    assert paths.reference_amendments_json.is_file()


def test_assertion_cannot_be_attribute_and_relation_at_once() -> None:
    with pytest.raises(ValueError, match="只能选择属性、关系、引用复查或省略之一"):
        AssertionProjectionOutput.model_validate(
            {
                "attributes": [
                    {
                        "assertion_id": "assert-1",
                        "object_id": "obj-1",
                        "semantic_kind": "fact",
                        "lane_tags": ["activity_flow"],
                        "reason": "属性",
                    }
                ],
                "relations": [
                    {
                        "assertion_id": "assert-1",
                        "relation_pattern": "composition",
                        "participants": [
                            {"object_id": "obj-1", "role": "whole"},
                            {"object_id": "obj-2", "role": "part"},
                        ],
                        "semantic_kind": "fact",
                        "lane_tags": ["activity_flow"],
                        "derivation_kind": "direct_source",
                        "reason": "关系",
                    }
                ],
                "omitted_assertion_ids": [],
            }
        )


def test_relation_pattern_must_include_its_business_lane() -> None:
    with pytest.raises(ValueError, match="必须属于 guidance 线路"):
        RelationDecision.model_validate(
            {
                "assertion_id": "assert-1",
                "relation_pattern": "guidance_application",
                "participants": [
                    {"object_id": "obj-1", "role": "anchor"},
                    {"object_id": "obj-2", "role": "scope"},
                ],
                "semantic_kind": "practice",
                "lane_tags": ["activity_flow"],
                "derivation_kind": "direct_source",
                "reason": "测试错误线路。",
            }
        )


def test_composition_rejects_organization_and_activity_role_migration() -> None:
    relation = RelationDecision.model_validate(
        {
            "assertion_id": "assert-1",
            "relation_pattern": "composition",
            "participants": [
                {"object_id": "obj-organization", "role": "whole"},
                {"object_id": "obj-activity", "role": "part"},
            ],
            "semantic_kind": "fact",
            "lane_tags": ["activity_flow"],
            "derivation_kind": "direct_source",
            "reason": "错误地把组织与活动塞入工作流组成关系。",
        }
    )

    with pytest.raises(ValueError, match=r"composition\.whole 不接受"):
        ActivityPerspectiveRunner._validate_relation_object_roles(
            relation.relation_pattern,
            relation.participants,
            {
                "obj-organization": "organization",
                "obj-activity": "activity",
            },
        )


def test_composition_accepts_nested_workflow() -> None:
    relation = RelationDecision.model_validate(
        {
            "assertion_id": "assert-1",
            "relation_pattern": "composition",
            "participants": [
                {"object_id": "workflow-parent", "role": "whole"},
                {"object_id": "workflow-child", "role": "part"},
            ],
            "semantic_kind": "fact",
            "lane_tags": ["activity_flow"],
            "derivation_kind": "direct_source",
            "reason": "父工作流包含子工作流。",
        }
    )

    ActivityPerspectiveRunner._validate_relation_object_roles(
        relation.relation_pattern,
        relation.participants,
        {
            "workflow-parent": "workflow",
            "workflow-child": "workflow",
        },
    )


def test_object_relation_component_respects_expanded_character_limit(
    tmp_path: Path,
) -> None:
    compilation = _compilation()
    runner = ActivityPerspectiveRunner(
        model=ActivityViewFakeModel(),
        source_compilation_path=tmp_path / "basic-compilation.json",
        compilation=compilation,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=create_activity_view_paths(tmp_path / "basic-compilation.json"),
        settings=ActivityViewSettings(
            max_parallel_groups=1,
            max_objects_per_group=20,
            max_object_group_chars=1,
            max_assertions_per_group=20,
        ),
    )
    relation = RelationDecision.model_validate(
        {
            "assertion_id": "region-0002/assert-1",
            "relation_pattern": "classification",
            "participants": [
                {"object_id": "region-0002/obj-1", "role": "subject"},
                {"object_id": "region-0002/obj-2", "role": "category"},
            ],
            "semantic_kind": "fact",
            "lane_tags": ["activity_flow"],
            "derivation_kind": "direct_source",
            "reason": "原文直接给出活动分类。",
        }
    )

    groups = runner._object_projection_groups(
        ["region-0002/obj-1", "region-0002/obj-2"],
        [relation],
    )

    assert [list(item.item_ids) for item in groups] == [
        ["region-0002/obj-1"],
        ["region-0002/obj-2"],
    ]


def test_parent_dependency_accepts_distributed_atomic_support(tmp_path: Path) -> None:
    compilation = _compilation()
    runner = ActivityPerspectiveRunner(
        model=ActivityViewFakeModel(),
        source_compilation_path=tmp_path / "basic-compilation.json",
        compilation=compilation,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=create_activity_view_paths(tmp_path / "basic-compilation.json"),
        settings=_settings(),
    )
    output = ParentSynthesisOutput.model_validate(
        {
            "relations": [
                {
                    "relation_pattern": "dependency",
                    "participants": [
                        {"object_id": "region-0002/obj-1", "role": "dependent"},
                        {"object_id": "region-0004/obj-1", "role": "dependency"},
                    ],
                    "semantic_kind": "fact",
                    "lane_tags": ["activity_flow"],
                    "proof_kind": "necessary_normalization",
                    "supporting_assertion_ids": [
                        "region-0002/assert-1",
                        "region-0004/assert-1",
                    ],
                    "proof_evidence_ids": [
                        "region-0002/evidence-1",
                        "region-0004/evidence-1",
                    ],
                    "supporting_child_node_ids": ["region-0002", "region-0004"],
                    "temporal_scope": {
                        "kind": "unknown",
                        "display": "时间不明",
                        "start": None,
                        "end": None,
                        "precision": "unspecified",
                    },
                    "temporal_basis_markdown": "两条来源没有共同时间。",
                    "reason": "两项工作主题相关，但没有桥接命题。",
                }
            ],
            "issues": [],
        }
    )

    runner._validate_parent_synthesis(
        runner.nodes[runner.root_id],
        output,
        {
            "region-0002/obj-1": "workflow",
            "region-0004/obj-1": "workflow",
        },
        {item.assertion_id for item in compilation.root_package.assertions},
    )


def test_parent_direct_statement_still_requires_one_bridge_assertion(
    tmp_path: Path,
) -> None:
    compilation = _compilation()
    runner = ActivityPerspectiveRunner(
        model=ActivityViewFakeModel(),
        source_compilation_path=tmp_path / "basic-compilation.json",
        compilation=compilation,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=create_activity_view_paths(tmp_path / "basic-compilation.json"),
        settings=_settings(),
    )
    output = ParentSynthesisOutput.model_validate(
        {
            "relations": [
                {
                    "relation_pattern": "dependency",
                    "participants": [
                        {"object_id": "region-0002/obj-1", "role": "dependent"},
                        {"object_id": "region-0004/obj-1", "role": "dependency"},
                    ],
                    "semantic_kind": "fact",
                    "lane_tags": ["activity_flow"],
                    "proof_kind": "direct_statement",
                    "supporting_assertion_ids": [
                        "region-0002/assert-1",
                        "region-0004/assert-1",
                    ],
                    "proof_evidence_ids": [
                        "region-0002/evidence-1",
                        "region-0004/evidence-1",
                    ],
                    "supporting_child_node_ids": ["region-0002", "region-0004"],
                    "temporal_scope": {
                        "kind": "unknown",
                        "display": "时间不明",
                        "start": None,
                        "end": None,
                        "precision": "unspecified",
                    },
                    "temporal_basis_markdown": "两条来源没有共同时间。",
                    "reason": "两条来源分别介绍端点，没有直接桥接命题。",
                }
            ],
            "issues": [],
        }
    )

    with pytest.raises(ValueError, match="direct_statement 必须至少有一条 Assertion"):
        runner._validate_parent_synthesis(
            runner.nodes[runner.root_id],
            output,
            {
                "region-0002/obj-1": "workflow",
                "region-0004/obj-1": "workflow",
            },
            {item.assertion_id for item in compilation.root_package.assertions},
        )


def test_parent_recovery_rejects_proof_touched_by_source_conflict(
    tmp_path: Path,
) -> None:
    exploration = _exploration()
    exploration = exploration.model_copy(
        update={
            "region_tree": exploration.region_tree.model_copy(
                update={
                    "source_issues": [
                        SourceIssue(
                            block_ids=["p0001-b0003"],
                            reason="原文数量表述与后续结构不符。",
                        )
                    ]
                }
            )
        }
    )
    compilation = _compilation()
    runner = ActivityPerspectiveRunner(
        model=ActivityViewFakeModel(),
        source_compilation_path=tmp_path / "basic-compilation.json",
        compilation=compilation,
        exploration=exploration,
        blocks=_blocks(),
        paths=create_activity_view_paths(tmp_path / "basic-compilation.json"),
        settings=_settings(),
    )
    output = ParentSynthesisOutput.model_validate(
        {
            "relations": [
                {
                    "relation_pattern": "workflow_use",
                    "participants": [
                        {
                            "object_id": "region-0002/obj-1",
                            "role": "workflow_user",
                        },
                        {"object_id": "region-0004/obj-1", "role": "workflow"},
                    ],
                    "semantic_kind": "practice",
                    "lane_tags": ["activity_flow"],
                    "proof_kind": "direct_statement",
                    "supporting_assertion_ids": ["region-0003/assert-1"],
                    "proof_evidence_ids": ["region-0003/evidence-1"],
                    "supporting_child_node_ids": ["region-0002", "region-0004"],
                    "temporal_scope": {
                        "kind": "unknown",
                        "display": "时间不明",
                        "start": None,
                        "end": None,
                        "precision": "unspecified",
                    },
                    "temporal_basis_markdown": "原文没有可定位时间。",
                    "reason": "尝试从受冲突警告影响的 Evidence 恢复关系。",
                }
            ],
            "issues": [],
        }
    )

    with pytest.raises(ValueError, match="触及来源冲突"):
        runner._validate_parent_synthesis(
            runner.nodes[runner.root_id],
            output,
            {
                "region-0002/obj-1": "activity",
                "region-0004/obj-1": "workflow",
            },
            {"region-0003/assert-1"},
        )
