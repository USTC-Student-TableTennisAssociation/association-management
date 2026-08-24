"""从合并后的 Object、Assertion 编译活动运营视角。"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections import defaultdict
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TypeVar, cast

from pydantic import BaseModel, ValidationError

from cold_start.activity_view.models import (
    RELATION_PATTERN_LANE,
    ActivityPerspectiveSnapshot,
    AssertionProjectionOutput,
    AssertionReferenceAmendment,
    AttributeDecision,
    AttributeProjection,
    LaneReviewChange,
    LaneReviewIssue,
    LaneReviewOutput,
    LaneTag,
    ObjectCard,
    ObjectCardDecision,
    ObjectRoleOutput,
    ParentRelationDecision,
    ParentSynthesisIssue,
    ParentSynthesisOutput,
    PerspectiveBoundaryPlan,
    PerspectiveGroupResult,
    PerspectiveReviewRound,
    ReferenceReviewDecision,
    ReferenceReviewRequest,
    RelationDecision,
    RelationParticipantDecision,
    RelationParticipantProjection,
    RelationProjection,
    object_card_id,
)
from cold_start.activity_view.prompts import (
    ASSERTION_PROJECTION_SYSTEM_PROMPT,
    BOUNDARY_PLAN_SYSTEM_PROMPT,
    GLOBAL_LANE_REVIEW_PROTOCOL,
    GLOBAL_LANE_REVIEW_SYSTEM_PROMPTS,
    OBJECT_ROLE_SYSTEM_PROMPT,
    PARENT_SYNTHESIS_SYSTEM_PROMPT,
    REFERENCE_REVIEW_SYSTEM_PROMPT,
    TARGETED_REPAIR_SYSTEM_PROMPT,
    assertion_projection_prompt,
    boundary_plan_prompt,
    global_lane_review_prompt,
    object_role_prompt,
    parent_synthesis_prompt,
    reference_review_prompt,
    repair_prompt,
    resolved_assertion_projection_prompt,
    targeted_repair_prompt,
)
from cold_start.compilation.leaf import MAX_PROTOCOL_REPAIRS, load_exploration_inputs
from cold_start.compilation.models import (
    Assertion,
    FullCompilationSnapshot,
    MemoryObject,
    assertion_object_ids,
    render_statement,
)
from cold_start.config import ActivityViewSettings
from cold_start.document.blocks import format_blocks
from cold_start.document.models import ParsedBlock
from cold_start.global_exploration.models import GlobalExplorationSnapshot
from cold_start.llm.base import ChatModel
from cold_start.progress import NullProgressReporter, ProgressReporter
from cold_start.region_tree.models import RegionNode
from cold_start.region_tree.runtime import BlockIndex

OutputModel = TypeVar("OutputModel", bound=BaseModel)
ASSERTION_GROUP_CHECKPOINT_SCHEMA_VERSION = "activity-view-group.v5"
OBJECT_GROUP_CHECKPOINT_SCHEMA_VERSION = "activity-view-object-group.v6"
BOUNDARY_CHECKPOINT_SCHEMA_VERSION = "activity-view-boundary.v4"
PARENT_GROUP_CHECKPOINT_SCHEMA_VERSION = "activity-view-parent-group.v1"
REPAIR_GROUP_CHECKPOINT_SCHEMA_VERSION = "activity-view-repair-group.v1"
LANE_REVIEW_CHECKPOINT_SCHEMA_VERSION = "activity-view-lane-review.v1"

RELATION_OBJECT_ROLE_SIGNATURES: dict[str, dict[str, set[str]]] = {
    "classification": {
        "subject": {"activity"},
        "category": {"activity_trait"},
    },
    "workflow_use": {
        "workflow_user": {"activity", "activity_trait"},
        "workflow": {"workflow"},
    },
    "composition": {
        "whole": {"workflow"},
        "part": {"workflow", "work_step"},
    },
    "sequence": {
        "previous": {"workflow", "work_step"},
        "next": {"workflow", "work_step"},
    },
    "dependency": {
        "dependent": {"workflow", "work_step"},
        "dependency": {
            "workflow",
            "work_step",
            "system",
            "document",
            "venue",
            "resource",
            "funding_scheme",
        },
    },
    "guidance_application": {
        "anchor": {"workflow", "work_step"},
        "scope": {"organization", "activity", "activity_trait"},
    },
    "role_holding": {
        "person": {"person"},
        "role": {"role"},
    },
    "responsibility": {
        "responsible_party": {"person", "role"},
        "responsibility_target": {"activity", "workflow", "work_step"},
    },
    "participation": {
        "participant": {"person", "role"},
        "participation_target": {"activity", "workflow", "work_step"},
    },
    "contextualization": {
        "context": {"organization", "period"},
        "contextualized_object": {"activity", "workflow", "work_step"},
    },
}


@dataclass(frozen=True)
class ActivityViewArtifactPaths:
    directory: Path
    model_streams: Path
    group_checkpoints: Path
    boundary_plan_json: Path
    snapshot_json: Path
    report_markdown: Path
    cards_json: Path
    reference_reviews_json: Path
    reference_amendments_json: Path
    attributes_json: Path
    relations_json: Path
    parent_recovery_json: Path
    review_rounds_json: Path
    omissions_json: Path
    working_json: Path


@dataclass(frozen=True)
class _SemanticGroup:
    node: RegionNode
    item_ids: tuple[str, ...]


@dataclass(frozen=True)
class _ObjectGroupResult:
    group: _SemanticGroup
    output: ObjectRoleOutput
    model_calls: int


@dataclass(frozen=True)
class _AssertionGroupResult:
    group: _SemanticGroup
    output: AssertionProjectionOutput
    model_calls: int


@dataclass(frozen=True)
class _ParentSynthesisResult:
    node: RegionNode
    output: ParentSynthesisOutput
    model_calls: int


@dataclass(frozen=True)
class _LaneReviewResult:
    output: LaneReviewOutput
    model_calls: int


class _ProtocolValidationFailure(RuntimeError):
    def __init__(self, output_name: str, calls: int, error: Exception) -> None:
        super().__init__(f"{output_name}连续 {calls} 次未通过协议校验：{error}")
        self.calls = calls


def create_activity_view_paths(compilation_path: Path) -> ActivityViewArtifactPaths:
    source = compilation_path.expanduser().resolve()
    base = source if source.is_dir() else source.parent
    directory = base / "activity-perspectives" / f"{datetime.now(UTC):%Y%m%dT%H%M%S%fZ}-draft"
    directory.mkdir(parents=True, exist_ok=False)
    model_streams = directory / "model-streams"
    group_checkpoints = directory / "group-checkpoints"
    model_streams.mkdir()
    group_checkpoints.mkdir()
    return ActivityViewArtifactPaths(
        directory=directory,
        model_streams=model_streams,
        group_checkpoints=group_checkpoints,
        boundary_plan_json=directory / "semantic-boundary.json",
        snapshot_json=directory / "activity-operations.json",
        report_markdown=directory / "activity-operations.md",
        cards_json=directory / "object-cards.json",
        reference_reviews_json=directory / "reference-review-results.json",
        reference_amendments_json=directory / "assertion-reference-amendments.json",
        attributes_json=directory / "attribute-projections.json",
        relations_json=directory / "relation-projections.json",
        parent_recovery_json=directory / "parent-recovery.json",
        review_rounds_json=directory / "review-rounds.json",
        omissions_json=directory / "omissions.json",
        working_json=directory / "working.json",
    )


def open_activity_view_paths(directory: Path) -> ActivityViewArtifactPaths:
    """打开未完成的活动视角目录，复用已经校验通过的分组结果。"""

    resolved = directory.expanduser().resolve()
    if not resolved.is_dir():
        raise ValueError("--resume 必须指向已有的活动运营视角草稿目录")
    model_streams = resolved / "model-streams"
    if not model_streams.is_dir():
        raise ValueError("活动视角恢复目录缺少 model-streams")
    if (resolved / "activity-operations.json").is_file():
        raise ValueError("该活动运营视角草稿已经完成，不需要恢复")
    group_checkpoints = resolved / "group-checkpoints"
    group_checkpoints.mkdir(exist_ok=True)
    return ActivityViewArtifactPaths(
        directory=resolved,
        model_streams=model_streams,
        group_checkpoints=group_checkpoints,
        boundary_plan_json=resolved / "semantic-boundary.json",
        snapshot_json=resolved / "activity-operations.json",
        report_markdown=resolved / "activity-operations.md",
        cards_json=resolved / "object-cards.json",
        reference_reviews_json=resolved / "reference-review-results.json",
        reference_amendments_json=resolved / "assertion-reference-amendments.json",
        attributes_json=resolved / "attribute-projections.json",
        relations_json=resolved / "relation-projections.json",
        parent_recovery_json=resolved / "parent-recovery.json",
        review_rounds_json=resolved / "review-rounds.json",
        omissions_json=resolved / "omissions.json",
        working_json=resolved / "working.json",
    )


def load_activity_view_inputs(
    compilation_path: Path,
) -> tuple[
    Path,
    FullCompilationSnapshot,
    GlobalExplorationSnapshot,
    tuple[ParsedBlock, ...],
]:
    source = compilation_path.expanduser().resolve()
    snapshot_path = source / "basic-compilation.json" if source.is_dir() else source
    if not snapshot_path.is_file():
        raise ValueError("--compilation 必须指向完整基础编译目录或 basic-compilation.json")
    snapshot = FullCompilationSnapshot.model_validate_json(
        snapshot_path.read_text(encoding="utf-8")
    )
    run_directory = _find_run_directory(snapshot_path.parent)
    exploration, blocks = load_exploration_inputs(run_directory)
    if snapshot.source.sha256 != exploration.source.sha256:
        raise ValueError("基础编译与全局勘探不是同一份来源文件")
    return snapshot_path, snapshot, exploration, blocks


def _find_run_directory(start: Path) -> Path:
    current = start
    while True:
        if (current / "global-exploration.json").is_file() and (
            current / "parsed-blocks.json"
        ).is_file():
            return current
        if current.parent == current:
            raise ValueError("无法从基础编译产物向上找到全局勘探运行目录")
        current = current.parent


class ActivityPerspectiveRunner:
    """先投影 Assertion，再为被保留知识带出的 Object 建立卡片。"""

    def __init__(
        self,
        *,
        model: ChatModel,
        source_compilation_path: Path,
        compilation: FullCompilationSnapshot,
        exploration: GlobalExplorationSnapshot,
        blocks: tuple[ParsedBlock, ...],
        paths: ActivityViewArtifactPaths,
        settings: ActivityViewSettings | None = None,
        progress: ProgressReporter | None = None,
    ) -> None:
        self.model = model
        self.source_compilation_path = source_compilation_path
        self.compilation = compilation
        self.exploration = exploration
        self.blocks = blocks
        self.index = BlockIndex(blocks)
        self.paths = paths
        self.settings = settings or ActivityViewSettings()
        self.progress = progress or NullProgressReporter()
        self.package = compilation.root_package
        self.objects = {item.object_id: item for item in self.package.objects}
        self.assertions = {item.assertion_id: item for item in self.package.assertions}
        self.evidence = {item.evidence_id: item for item in self.package.evidence}
        self.nodes = {item.node_id: item for item in exploration.region_tree.nodes}
        self.root_id = exploration.region_tree.root_node_id
        self.children: dict[str, list[str]] = defaultdict(list)
        for item in exploration.region_tree.nodes:
            if item.parent_id:
                self.children[item.parent_id].append(item.node_id)
        self.node_order = {
            item.node_id: index for index, item in enumerate(exploration.region_tree.nodes)
        }
        self.assertions_by_object: dict[str, list[Assertion]] = defaultdict(list)
        self.assertion_component_ids: dict[str, str] = {}
        for assertion in self.package.assertions:
            for object_id in assertion_object_ids(assertion):
                self.assertions_by_object[object_id].append(assertion)

    async def run(self) -> ActivityPerspectiveSnapshot:
        self._validate_working_source()
        self.progress.report(
            "活动运营视角",
            f"阶段 1/4：从 {len(self.package.objects)} 个 Object 建立全局材料导航",
        )
        boundary_plan, boundary_calls = await self._plan_boundary()
        assertion_groups = self._assertion_graph_groups(self.settings.max_assertions_per_group)
        self._write_working(
            stage="projecting_assertions",
            assertion_group_count=len(assertion_groups),
        )
        self.progress.report(
            "活动运营视角",
            (
                f"阶段 2/4：从 {len(assertion_groups)} 个局部 Object—Assertion 图高召回投影；"
                f"并发上限 {self.settings.max_parallel_groups}"
            ),
        )
        assertion_results = await self._project_assertions(
            assertion_groups,
            boundary_plan,
        )
        (
            assertion_results,
            reference_reviews,
            reference_amendments,
        ) = await self._resolve_reference_reviews(assertion_results, boundary_plan)
        attribute_decisions = [
            item for result in assertion_results for item in result.output.attributes
        ]
        relation_decisions = [
            item for result in assertion_results for item in result.output.relations
        ]
        # 只有属性归属或关系端点会成为候选卡；Assertion 的其他引用只是支撑指代。
        used_object_ids = {
            *[item.object_id for item in attribute_decisions],
            *[
                participant.object_id
                for item in relation_decisions
                for participant in item.participants
            ],
        }
        object_groups = self._object_projection_groups(
            self._in_source_order(
                list(used_object_ids),
                [item.object_id for item in self.package.objects],
            ),
            relation_decisions,
        )
        self.progress.report(
            "活动运营视角",
            (
                f"阶段 3/4：依据硬边界复核 {len(used_object_ids)} 个候选 Object；"
                "只判断三态和角色，线路稍后由投影反推"
            ),
        )
        object_results = await self._classify_objects(
            object_groups,
            boundary_plan,
        )
        decisions = [item for result in object_results for item in result.output.decisions]
        view_object_ids = {item.object_id for item in decisions if item.status == "view_card"}
        attribute_subject_ids = {
            item.object_id
            for item in decisions
            if item.status in {"view_card", "support_reference"}
        }
        attribute_decisions = [
            item for item in attribute_decisions if item.object_id in attribute_subject_ids
        ]
        relation_decisions = [
            item
            for item in relation_decisions
            if {participant.object_id for participant in item.participants} <= view_object_ids
        ]
        role_repair_requests = self._relation_role_review_results(
            relation_decisions,
            decisions,
        )
        preflight_repair_results: list[_AssertionGroupResult] = []
        if role_repair_requests:
            self.progress.report(
                "关系类型校验",
                "发现关系参与者与 Object 角色不一致，按原 Assertion 定向重投影",
            )
            (
                attribute_decisions,
                relation_decisions,
                preflight_repair_results,
            ) = await self._repair_review_changes(
                attributes=attribute_decisions,
                relations=relation_decisions,
                decisions=decisions,
                lane_results=role_repair_requests,
                boundary_plan=boundary_plan,
                round_index=0,
            )
        self._validate_relation_decision_roles(relation_decisions, decisions)

        self.progress.report(
            "活动运营视角",
            (
                "阶段 4/4：父节点跨区域关系恢复 + 四线路候选准入与全局复核；"
                f"最多 {self.settings.max_review_rounds} 轮，状态稳定即提前停止"
            ),
        )
        review_rounds: list[PerspectiveReviewRound] = []
        synthesis_results: list[_ParentSynthesisResult] = []
        parent_relations: list[RelationProjection] = []
        all_parent_issues: dict[str, ParentSynthesisIssue] = {}
        parent_issues_by_node: dict[str, list[ParentSynthesisIssue]] = {}
        admission_issues_by_key: dict[str, ParentSynthesisIssue] = {}
        unresolved_issues: dict[str, LaneReviewIssue] = {}
        parent_feedback: dict[str, list[dict[str, object]]] = defaultdict(list)
        affected_parent_ids: set[str] | None = None
        seen_issue_states: set[tuple[str, str]] = set()
        iterative_group_results: list[PerspectiveGroupResult] = [
            PerspectiveGroupResult(
                stage="repair_review_issues",
                region_node_id=result.group.node.node_id,
                item_ids=list(result.group.item_ids),
                included_count=(len(result.output.attributes) + len(result.output.relations)),
                omitted_count=len(result.output.omitted_assertion_ids),
                model_calls=result.model_calls,
            )
            for result in preflight_repair_results
        ]

        for round_index in range(1, self.settings.max_review_rounds + 1):
            projected_assertion_ids = self._projected_assertion_ids(
                attribute_decisions,
                relation_decisions,
            )
            direct_attributes = self._build_attributes(attribute_decisions)
            direct_relations = self._build_relations(relation_decisions)
            lane_map = self._derive_object_lanes(
                attribute_decisions,
                relation_decisions,
            )
            card_decisions = [
                item
                for item in decisions
                if item.status == "view_card" and item.object_id in lane_map
            ]
            cards = self._build_cards(
                card_decisions,
                projected_assertion_ids,
                lane_map,
            )
            cards = self._attach_projections(cards, direct_attributes, direct_relations)

            synthesis_results = await self._synthesize_parent_relations(
                cards=cards,
                attributes=direct_attributes,
                relations=direct_relations,
                parent_feedback=parent_feedback,
                round_index=round_index,
                allowed_node_ids=affected_parent_ids,
            )
            recomputed_parent_ids = (
                {item.node_id for item in self._parent_synthesis_nodes(set(lane_map))}
                if affected_parent_ids is None
                else affected_parent_ids
            )
            for result in synthesis_results:
                iterative_group_results.append(
                    PerspectiveGroupResult(
                        stage="recover_parent_relations",
                        region_node_id=result.node.node_id,
                        item_ids=[
                            item
                            for relation in result.output.relations
                            for item in relation.supporting_assertion_ids
                        ],
                        included_count=len(result.output.relations),
                        omitted_count=len(result.output.issues),
                        model_calls=result.model_calls,
                    )
                )
            for node_id in recomputed_parent_ids:
                parent_issues_by_node.pop(node_id, None)
                admission_issues_by_key = {
                    key: value
                    for key, value in admission_issues_by_key.items()
                    if not key.startswith(f"{node_id}:")
                }
            for result in synthesis_results:
                parent_issues_by_node[result.node.node_id] = list(result.output.issues)
            all_parent_issues = {
                issue.issue_key: issue
                for issues in parent_issues_by_node.values()
                for issue in issues
            }
            all_parent_issues.update(admission_issues_by_key)
            if affected_parent_ids is None:
                parent_candidates = self._build_parent_relations(synthesis_results)
            else:
                retained_parent_relations = [
                    item
                    for item in parent_relations
                    if item.source_region_node_ids[0] not in affected_parent_ids
                ]
                parent_candidates = [
                    *retained_parent_relations,
                    *self._build_parent_relations(synthesis_results),
                ]
            cards = self._attach_projections(
                cards,
                direct_attributes,
                [*direct_relations, *parent_candidates],
            )

            lane_results = await self._review_lanes(
                cards=cards,
                decisions=decisions,
                attributes=direct_attributes,
                relations=[*direct_relations, *parent_candidates],
                parent_issues=list(all_parent_issues.values()),
                boundary_plan=boundary_plan,
                round_index=round_index,
            )
            parent_relations, admission_issues = self._admit_parent_candidates(
                parent_candidates,
                lane_results,
                parent_feedback,
            )
            for issue in admission_issues:
                admission_issues_by_key[issue.issue_key] = issue
                all_parent_issues[issue.issue_key] = issue
            reviewed_state = self._projection_state_signature(
                attribute_decisions,
                relation_decisions,
                parent_relations,
            )
            for lane_result in lane_results:
                for issue in lane_result.output.unresolved_issues:
                    unresolved_issues[issue.issue_key] = issue
                iterative_group_results.append(
                    PerspectiveGroupResult(
                        stage="review_lanes",
                        region_node_id=self.root_id,
                        item_ids=[item.target_id for item in lane_result.output.changes],
                        included_count=len(lane_result.output.changes),
                        omitted_count=len(lane_result.output.unresolved_issues),
                        model_calls=lane_result.model_calls,
                    )
                )

            issue_signature = self._review_issue_signature(lane_results)
            issue_state = (issue_signature, reviewed_state)
            repeated = bool(issue_signature and issue_state in seen_issue_states)
            if issue_signature:
                seen_issue_states.add(issue_state)
            change_count = sum(len(item.output.changes) for item in lane_results)
            if change_count == 0:
                review_rounds.append(
                    PerspectiveReviewRound(
                        round_index=round_index,
                        lane_reviews=[item.output for item in lane_results],
                        applied_change_count=0,
                        state_changed=False,
                        converged=True,
                        repeated_issue_signature=repeated,
                        model_calls=sum(item.model_calls for item in lane_results),
                    )
                )
                self.progress.report(
                    "活动运营视角",
                    f"第 {round_index} 轮无定向变更，循环收敛",
                )
                break
            before_state = reviewed_state
            changed_assertion_ids = {
                change.target_id
                for result in lane_results
                for change in result.output.changes
                if change.target_kind == "assertion"
            }
            (
                attribute_decisions,
                relation_decisions,
                repair_results,
            ) = await self._repair_review_changes(
                attributes=attribute_decisions,
                relations=relation_decisions,
                decisions=decisions,
                lane_results=lane_results,
                boundary_plan=boundary_plan,
                round_index=round_index,
            )
            for result in repair_results:
                iterative_group_results.append(
                    PerspectiveGroupResult(
                        stage="repair_review_issues",
                        region_node_id=result.group.node.node_id,
                        item_ids=list(result.group.item_ids),
                        included_count=(
                            len(result.output.attributes) + len(result.output.relations)
                        ),
                        omitted_count=len(result.output.omitted_assertion_ids),
                        model_calls=result.model_calls,
                    )
                )
            after_state = self._projection_state_signature(
                attribute_decisions,
                relation_decisions,
                parent_relations,
            )
            state_changed = before_state != after_state
            review_rounds.append(
                PerspectiveReviewRound(
                    round_index=round_index,
                    lane_reviews=[item.output for item in lane_results],
                    applied_change_count=change_count,
                    state_changed=state_changed,
                    converged=False,
                    repeated_issue_signature=repeated,
                    model_calls=(
                        sum(item.model_calls for item in lane_results)
                        + sum(item.model_calls for item in repair_results)
                    ),
                )
            )
            if repeated:
                unresolved_issues["repeated-review-state"] = LaneReviewIssue(
                    issue_key="repeated-review-state",
                    affected_assertion_ids=sorted(changed_assertion_ids),
                    reason=(
                        "同一组全局复核问题在相同草稿状态再次出现；"
                        "本轮已再次应用安全差异，随后停止循环以避免振荡。"
                    ),
                )
                self.progress.report(
                    "活动运营视角",
                    f"第 {round_index} 轮问题在相同状态重复；应用安全差异后停止循环",
                )
                break
            if not state_changed:
                self.progress.report(
                    "活动运营视角",
                    f"第 {round_index} 轮修复后状态没有变化，停止重复修复",
                )
                break
            affected_parent_ids = self._affected_parent_ids(
                changed_assertion_ids,
            )

        if (
            len(review_rounds) == self.settings.max_review_rounds
            and review_rounds
            and not review_rounds[-1].converged
            and not review_rounds[-1].repeated_issue_signature
        ):
            unresolved_issues["review-round-limit"] = LaneReviewIssue(
                issue_key="review-round-limit",
                reason=(
                    f"达到 {self.settings.max_review_rounds} 轮安全上限，"
                    "最后一轮变更尚未经过下一轮全局复核。"
                ),
            )

        projected_assertion_ids = self._projected_assertion_ids(
            attribute_decisions,
            relation_decisions,
        )
        referenced_by_final_projection = {
            object_id
            for assertion_id in projected_assertion_ids
            for object_id in assertion_object_ids(self.assertions[assertion_id])
        }
        view_object_ids &= referenced_by_final_projection
        support_reference_object_ids = {
            item.object_id for item in decisions if item.status == "support_reference"
        }
        support_reference_object_ids |= referenced_by_final_projection - view_object_ids
        support_reference_object_ids -= view_object_ids
        all_object_ids = {item.object_id for item in self.package.objects}
        outside_view_object_ids = all_object_ids - view_object_ids - support_reference_object_ids
        lane_map = self._derive_object_lanes(
            attribute_decisions,
            relation_decisions,
            parent_relations,
        )
        card_decisions = [
            item for item in decisions if item.status == "view_card" and item.object_id in lane_map
        ]
        cards = self._build_cards(card_decisions, projected_assertion_ids, lane_map)
        attributes = self._build_attributes(attribute_decisions)
        relations = [*self._build_relations(relation_decisions), *parent_relations]
        cards = self._attach_projections(cards, attributes, relations)
        source_object_order = [item.object_id for item in self.package.objects]
        source_assertion_order = [item.assertion_id for item in self.package.assertions]
        support_reference_ids = self._in_source_order(
            list(support_reference_object_ids),
            source_object_order,
        )
        outside_view_ids = self._in_source_order(
            list(outside_view_object_ids),
            source_object_order,
        )
        omitted_object_ids = self._in_source_order(
            [*support_reference_ids, *outside_view_ids],
            source_object_order,
        )
        omitted_assertion_ids = self._in_source_order(
            list(set(source_assertion_order) - projected_assertion_ids),
            source_assertion_order,
        )
        self._write_working(
            stage="assertions_projected",
            card_count=len(cards),
            attribute_count=len(attributes),
            relation_count=len(relations),
            omitted_object_count=len(omitted_object_ids),
            omitted_assertion_count=len(omitted_assertion_ids),
        )

        group_results = [
            PerspectiveGroupResult(
                stage="plan_boundary",
                region_node_id=self.root_id,
                item_ids=source_object_order,
                included_count=len(source_object_order),
                omitted_count=0,
                model_calls=boundary_calls,
            ),
        ]
        group_results.extend(
            PerspectiveGroupResult(
                stage="project_assertions",
                region_node_id=result.group.node.node_id,
                item_ids=list(result.group.item_ids),
                included_count=(len(result.output.attributes) + len(result.output.relations)),
                omitted_count=len(result.output.omitted_assertion_ids),
                model_calls=result.model_calls,
            )
            for result in assertion_results
        )
        group_results.extend(
            PerspectiveGroupResult(
                stage="classify_objects",
                region_node_id=result.group.node.node_id,
                item_ids=list(result.group.item_ids),
                included_count=sum(item.status == "view_card" for item in result.output.decisions),
                omitted_count=sum(item.status != "view_card" for item in result.output.decisions),
                model_calls=result.model_calls,
            )
            for result in object_results
        )
        group_results.extend(iterative_group_results)
        snapshot = ActivityPerspectiveSnapshot(
            created_at=datetime.now(UTC),
            source=self.compilation.source,
            source_compilation_path=str(self.source_compilation_path),
            source_compilation_schema_version=self.compilation.schema_version,
            region_tree_schema_version=self.exploration.region_tree.schema_version,
            boundary_plan=boundary_plan,
            review_rounds=review_rounds,
            parent_recovery_issues=list(all_parent_issues.values()),
            unresolved_review_issues=list(unresolved_issues.values()),
            object_cards=cards,
            reference_reviews=reference_reviews,
            reference_amendments=reference_amendments,
            attributes=attributes,
            relations=relations,
            support_reference_object_ids=support_reference_ids,
            outside_view_object_ids=outside_view_ids,
            omitted_object_ids=omitted_object_ids,
            omitted_assertion_ids=omitted_assertion_ids,
            group_results=group_results,
            model_calls=sum(item.model_calls for item in group_results),
            warnings=self._warnings(cards, attributes, relations),
        )
        write_activity_view_artifacts(self.paths, snapshot)
        self.progress.report(
            "活动运营视角",
            (
                f"完成：对象卡 {len(cards)}，引用复查 {len(reference_reviews)}，"
                f"基础修订 {len(reference_amendments)}，属性 {len(attributes)}，"
                f"关系 {len(relations)}，支撑引用 {len(support_reference_ids)}，"
                f"视角外 Object {len(outside_view_ids)}，"
                f"复核轮次 {len(review_rounds)}，"
                f"未解决问题 {len(unresolved_issues)}，"
                f"省略 Assertion {len(omitted_assertion_ids)}，"
                f"模型调用 {snapshot.model_calls}"
            ),
        )
        return snapshot

    async def _plan_boundary(self) -> tuple[PerspectiveBoundaryPlan, int]:
        checkpoint = self.paths.group_checkpoints / "plan-boundary.json"
        if checkpoint.is_file():
            payload = json.loads(checkpoint.read_text(encoding="utf-8"))
            expected = {
                "schema_version": BOUNDARY_CHECKPOINT_SCHEMA_VERSION,
                "source_sha256": self.compilation.source.sha256,
            }
            actual = {key: payload.get(key) for key in expected}
            if actual != expected:
                raise ValueError(f"活动视角边界检查点与当前输入不一致：{actual}")
            return (
                PerspectiveBoundaryPlan.model_validate(payload["output"]),
                int(payload["model_calls"]),
            )

        output, calls = await self._complete_json(
            messages=[
                {"role": "system", "content": BOUNDARY_PLAN_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": boundary_plan_prompt(
                        document_context=self.exploration.document_context_markdown,
                        object_inventory=self._boundary_inventory(),
                    ),
                },
            ],
            output_model=PerspectiveBoundaryPlan,
            label="视角边界·全局规划",
            output_name="活动运营视角全局边界",
            validator=lambda value: None,
        )
        checkpoint.write_text(
            json.dumps(
                {
                    "schema_version": BOUNDARY_CHECKPOINT_SCHEMA_VERSION,
                    "source_sha256": self.compilation.source.sha256,
                    "output": output.model_dump(),
                    "model_calls": calls,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        return output, calls

    async def _classify_objects(
        self,
        groups: list[_SemanticGroup],
        boundary_plan: PerspectiveBoundaryPlan,
    ) -> list[_ObjectGroupResult]:
        semaphore = asyncio.Semaphore(self.settings.max_parallel_groups)

        async def classify_one(
            position: int,
            group: _SemanticGroup,
        ) -> _ObjectGroupResult:
            async with semaphore:
                if cached := self._load_object_checkpoint(group):
                    self.progress.report(
                        f"对象分类·{group.node.node_id}",
                        f"复用检查点 {position}/{len(groups)}：{group.node.label}",
                    )
                    return cached
                self.progress.report(
                    f"对象分类·{group.node.node_id}",
                    f"开始 {position}/{len(groups)}：{group.node.label}",
                )
                object_rows, assertion_rows = self._object_group_rows(group)
                output, calls = await self._complete_json(
                    messages=[
                        {"role": "system", "content": OBJECT_ROLE_SYSTEM_PROMPT},
                        {
                            "role": "user",
                            "content": object_role_prompt(
                                document_context=(self.exploration.document_context_markdown),
                                boundary_plan=boundary_plan.model_dump(),
                                lineage=self._lineage_text(group.node),
                                region_label=group.node.label,
                                objects=object_rows,
                                assertions=assertion_rows,
                            ),
                        },
                    ],
                    output_model=ObjectRoleOutput,
                    label=f"对象分类·{group.node.node_id}·{position}",
                    output_name="对象卡角色分类",
                    validator=lambda value: self._validate_object_role_output(
                        group,
                        value,
                    ),
                )
                self.progress.report(
                    f"对象分类·{group.node.node_id}",
                    (
                        "完成：视角卡 "
                        f"{sum(item.status == 'view_card' for item in output.decisions)}，"
                        "支撑引用 "
                        f"{sum(item.status == 'support_reference' for item in output.decisions)}，"
                        "视角外 "
                        f"{sum(item.status == 'outside_view' for item in output.decisions)}"
                    ),
                )
                result = _ObjectGroupResult(group, output, calls)
                self._save_group_checkpoint("classify_objects", result)
                return result

        outcomes = await asyncio.gather(
            *(classify_one(index, group) for index, group in enumerate(groups, 1)),
            return_exceptions=True,
        )
        return self._unwrap_results(groups, outcomes, "对象卡角色分类")

    async def _project_assertions(
        self,
        groups: list[_SemanticGroup],
        boundary_plan: PerspectiveBoundaryPlan,
    ) -> list[_AssertionGroupResult]:
        semaphore = asyncio.Semaphore(self.settings.max_parallel_groups)

        async def project_one(
            position: int,
            group: _SemanticGroup,
        ) -> _AssertionGroupResult:
            async with semaphore:
                if cached := self._load_assertion_checkpoint(group):
                    self.progress.report(
                        f"叙述投影·{group.node.node_id}",
                        f"复用检查点 {position}/{len(groups)}：{group.node.label}",
                    )
                    return cached
                referenced = {
                    object_id
                    for assertion_id in group.item_ids
                    for object_id in assertion_object_ids(self.assertions[assertion_id])
                }
                referenced_objects = [
                    self._object_identity_row(self.objects[value]) for value in sorted(referenced)
                ]
                self.progress.report(
                    f"叙述投影·{group.node.node_id}",
                    f"开始 {position}/{len(groups)}：{group.node.label}",
                )
                output, calls = await self._complete_json(
                    messages=[
                        {
                            "role": "system",
                            "content": ASSERTION_PROJECTION_SYSTEM_PROMPT,
                        },
                        {
                            "role": "user",
                            "content": assertion_projection_prompt(
                                document_context=(self.exploration.document_context_markdown),
                                boundary_plan=boundary_plan.model_dump(),
                                lineage=self._lineage_text(group.node),
                                region_label=group.node.label,
                                referenced_objects=referenced_objects,
                                assertions=[
                                    self._assertion_row(self.assertions[value])
                                    for value in group.item_ids
                                ],
                            ),
                        },
                    ],
                    output_model=AssertionProjectionOutput,
                    label=f"叙述投影·{group.node.node_id}·{position}",
                    output_name="Assertion 投影",
                    validator=lambda value: self._validate_assertion_output(
                        group,
                        value,
                    ),
                )
                self.progress.report(
                    f"叙述投影·{group.node.node_id}",
                    (
                        f"完成：属性 {len(output.attributes)}，"
                        f"关系 {len(output.relations)}，"
                        f"省略 {len(output.omitted_assertion_ids)}"
                    ),
                )
                result = _AssertionGroupResult(group, output, calls)
                self._save_group_checkpoint("project_assertions", result)
                return result

        outcomes = await asyncio.gather(
            *(project_one(index, group) for index, group in enumerate(groups, 1)),
            return_exceptions=True,
        )
        return self._unwrap_results(groups, outcomes, "Assertion 投影")

    async def _synthesize_parent_relations(
        self,
        *,
        cards: Sequence[ObjectCard],
        attributes: Sequence[AttributeProjection],
        relations: Sequence[RelationProjection],
        parent_feedback: Mapping[str, Sequence[Mapping[str, object]]],
        round_index: int,
        allowed_node_ids: set[str] | None,
    ) -> list[_ParentSynthesisResult]:
        card_by_id = {item.card_id: item for item in cards}
        object_card_ids = {item.object_id: item.card_id for item in cards}
        projected_assertion_ids = {item.source_assertion.assertion_id for item in attributes} | {
            item.source_assertion.assertion_id
            for item in relations
            if item.source_assertion is not None
        }
        candidates = self._parent_synthesis_nodes(set(object_card_ids))
        if allowed_node_ids is not None:
            candidates = [item for item in candidates if item.node_id in allowed_node_ids]
        semaphore = asyncio.Semaphore(self.settings.max_parallel_groups)

        async def synthesize_one(
            node: RegionNode,
            available_relations: Sequence[RelationProjection],
        ) -> _ParentSynthesisResult:
            async with semaphore:
                relevant_assertion_ids = self._parent_recovery_assertion_ids(
                    node=node,
                    projected_assertion_ids=projected_assertion_ids,
                    view_object_ids=set(object_card_ids),
                )
                if not relevant_assertion_ids:
                    self.progress.report(
                        f"父级恢复·{node.node_id}",
                        f"第 {round_index} 轮：没有跨孩子或父节点自有候选，跳过模型调用",
                    )
                    return _ParentSynthesisResult(
                        node=node,
                        output=ParentSynthesisOutput(relations=[], issues=[]),
                        model_calls=0,
                    )
                candidate_object_ids = {
                    object_id
                    for assertion_id in relevant_assertion_ids
                    for object_id in assertion_object_ids(self.assertions[assertion_id])
                    if object_id in object_card_ids
                }
                child_rows = []
                subtree_card_ids: set[str] = set()
                for child_id in self.children[node.node_id]:
                    descendant_ids = self._descendant_node_ids(child_id)
                    child_cards = [
                        item
                        for item in cards
                        if item.object_id in candidate_object_ids
                        if self._object_origin_node_id(item.object_id) in descendant_ids
                    ]
                    child_card_ids = {item.card_id for item in child_cards}
                    subtree_card_ids.update(child_card_ids)
                    child_attributes = [
                        self._compact_attribute(item)
                        for item in attributes
                        if item.source_assertion.assertion_id in relevant_assertion_ids
                        if object_card_id(item.subject_object_id) in child_card_ids
                    ]
                    child = self.nodes[child_id]
                    child_rows.append(
                        {
                            "node_id": child_id,
                            "label": child.label,
                            "introduction": child.introduction,
                            "cards": [self._compact_card(item) for item in child_cards],
                            "attributes": child_attributes,
                        }
                    )
                parent_card_ids = {
                    object_card_ids[object_id]
                    for object_id in object_card_ids
                    if object_id in candidate_object_ids
                    if self._object_origin_node_id(object_id) == node.node_id
                }
                subtree_card_ids.update(parent_card_ids)
                relevant_relations = [
                    item
                    for item in available_relations
                    if {value.card_id for value in item.participants} <= subtree_card_ids
                ]
                parent_row = {
                    "node_id": node.node_id,
                    "label": node.label,
                    "introduction": node.introduction,
                    "owned_cards": [
                        self._compact_card(card_by_id[value]) for value in sorted(parent_card_ids)
                    ],
                    "owned_attributes": [
                        self._compact_attribute(item)
                        for item in attributes
                        if item.source_assertion.assertion_id in relevant_assertion_ids
                        if object_card_id(item.subject_object_id) in parent_card_ids
                    ],
                }
                self.progress.report(
                    f"父级恢复·{node.node_id}",
                    (
                        f"第 {round_index} 轮：审查 {len(child_rows)} 个直接孩子，"
                        f"核对 {len(relevant_assertion_ids)} 条来源叙述"
                    ),
                )
                user_prompt = parent_synthesis_prompt(
                    document_context=self.exploration.document_context_markdown,
                    lineage=self._lineage_text(node),
                    parent=parent_row,
                    child_branches=child_rows,
                    existing_relations=[
                        self._compact_relation(item) for item in relevant_relations
                    ],
                    evidence_rows=self._parent_evidence_rows(relevant_assertion_ids),
                    source_issues=self._source_issues_for_node(node),
                    previous_feedback=parent_feedback.get(node.node_id, ()),
                )
                input_sha256 = hashlib.sha256(user_prompt.encode("utf-8")).hexdigest()
                role_by_object = {item.object_id: item.role for item in cards}

                def validate(value: ParentSynthesisOutput) -> None:
                    self._validate_parent_synthesis(
                        node,
                        value,
                        role_by_object,
                        projected_assertion_ids,
                    )

                if cached := self._load_parent_checkpoint(
                    node=node,
                    round_index=round_index,
                    input_sha256=input_sha256,
                    validator=validate,
                ):
                    self.progress.report(
                        f"父级恢复·{node.node_id}",
                        f"第 {round_index} 轮：复用已校验检查点",
                    )
                    return cached
                output, calls = await self._complete_json(
                    messages=[
                        {"role": "system", "content": PARENT_SYNTHESIS_SYSTEM_PROMPT},
                        {"role": "user", "content": user_prompt},
                    ],
                    output_model=ParentSynthesisOutput,
                    label=f"父级恢复·{node.node_id}·第{round_index}轮",
                    output_name="父节点跨区域关系恢复",
                    validator=validate,
                )
                result = _ParentSynthesisResult(node, output, calls)
                self._save_parent_checkpoint(
                    result=result,
                    round_index=round_index,
                    input_sha256=input_sha256,
                )
                return result

        accumulated_results: list[_ParentSynthesisResult] = []
        available_relations = list(relations)
        for depth in sorted({item.depth for item in candidates}, reverse=True):
            layer = [item for item in candidates if item.depth == depth]
            outcomes = await asyncio.gather(
                *(synthesize_one(node, available_relations) for node in layer),
                return_exceptions=True,
            )
            layer_results: list[_ParentSynthesisResult] = []
            for node, outcome in zip(layer, outcomes, strict=True):
                if not isinstance(outcome, BaseException):
                    layer_results.append(cast(_ParentSynthesisResult, outcome))
                    continue
                reason = f"父节点恢复未通过协议校验：{outcome}"
                self.progress.report(
                    f"父级恢复·{node.node_id}",
                    "本节点失败，记录为未决问题并继续处理其余父节点",
                )
                layer_results.append(
                    _ParentSynthesisResult(
                        node=node,
                        output=ParentSynthesisOutput(
                            relations=[],
                            issues=[
                                ParentSynthesisIssue(
                                    issue_key=(
                                        f"{node.node_id}-synthesis-failure-round-{round_index}"
                                    ),
                                    kind="synthesis_failure",
                                    affected_object_ids=[],
                                    affected_assertion_ids=[],
                                    reason=reason[:1_000],
                                )
                            ],
                        ),
                        model_calls=(
                            outcome.calls if isinstance(outcome, _ProtocolValidationFailure) else 1
                        ),
                    )
                )
            accumulated_results.extend(layer_results)
            available_relations.extend(self._build_parent_relations(layer_results))
        return accumulated_results

    async def _review_lanes(
        self,
        *,
        cards: Sequence[ObjectCard],
        decisions: Sequence[ObjectCardDecision],
        attributes: Sequence[AttributeProjection],
        relations: Sequence[RelationProjection],
        parent_issues: Sequence[ParentSynthesisIssue],
        boundary_plan: PerspectiveBoundaryPlan,
        round_index: int,
    ) -> list[_LaneReviewResult]:
        card_by_object = {item.object_id: item for item in cards}
        decision_by_object = {item.object_id: item for item in decisions}
        parent_candidates = {
            self._parent_relation_key(item): item
            for item in relations
            if item.derivation_kind == "parent_recovery"
        }

        async def review_one(lane: LaneTag) -> _LaneReviewResult:
            self.progress.report(
                f"全局复核·{lane}",
                f"第 {round_index} 轮开始",
            )
            assertion_ids = self._lane_review_assertion_ids(
                lane=lane,
                decisions=decisions,
                attributes=attributes,
                relations=relations,
            )
            lane_attributes = [item for item in attributes if lane in item.lane_tags]
            lane_relations = [item for item in relations if lane in item.lane_tags]
            relevant_object_ids = {
                object_id
                for assertion_id in assertion_ids
                for object_id in assertion_object_ids(self.assertions[assertion_id])
            }
            relevant_object_ids.update(item.subject_object_id for item in lane_attributes)
            relevant_object_ids.update(
                participant.card_id.removeprefix("object:")
                for item in lane_relations
                for participant in item.participants
            )
            compact_objects = []
            for item in self.package.objects:
                if item.object_id not in relevant_object_ids:
                    continue
                decision = decision_by_object.get(item.object_id)
                card = card_by_object.get(item.object_id)
                compact_objects.append(
                    {
                        "object_id": item.object_id,
                        "label": item.label,
                        "aliases": item.aliases,
                        "perspective_status": (
                            decision.status if decision is not None else "not_classified"
                        ),
                        "role": card.role if card is not None else None,
                        "lane_tags": card.lane_tags if card is not None else [],
                    }
                )
            compact_assertions = [
                {
                    "assertion_id": item.assertion_id,
                    "mode": item.mode,
                    "statement": self._render_assertion(item.assertion_id),
                    "object_ids": assertion_object_ids(item),
                    "temporal_scope": item.temporal_scope.model_dump(),
                }
                for item in self.package.assertions
                if item.assertion_id in assertion_ids
            ]
            user_prompt = global_lane_review_prompt(
                lane=lane,
                document_context=self.exploration.document_context_markdown,
                boundary_plan=boundary_plan.model_dump(),
                objects=compact_objects,
                assertions=compact_assertions,
                attributes=[self._compact_attribute(item) for item in lane_attributes],
                relations=[self._compact_relation(item) for item in lane_relations],
                parent_candidate_evidence=(
                    self._parent_candidate_evidence_rows(lane_relations)
                ),
                parent_issues=[item.model_dump() for item in parent_issues],
                round_index=round_index,
            )
            input_sha256 = hashlib.sha256(user_prompt.encode("utf-8")).hexdigest()

            def validate(value: LaneReviewOutput) -> None:
                self._validate_lane_review(lane, value, parent_candidates)

            if cached := self._load_lane_review_checkpoint(
                lane=lane,
                round_index=round_index,
                input_sha256=input_sha256,
                validator=validate,
            ):
                self.progress.report(
                    f"全局复核·{lane}",
                    f"第 {round_index} 轮复用已校验检查点",
                )
                return cached
            output, calls = await self._complete_json(
                messages=[
                    {
                        "role": "system",
                        "content": (
                            f"{GLOBAL_LANE_REVIEW_SYSTEM_PROMPTS[lane].strip()}\n\n"
                            f"{GLOBAL_LANE_REVIEW_PROTOCOL}"
                        ),
                    },
                    {
                        "role": "user",
                        "content": user_prompt,
                    },
                ],
                output_model=LaneReviewOutput,
                label=f"全局复核·{lane}·第{round_index}轮",
                output_name=f"{lane} 线路全局复核",
                validator=validate,
            )
            result = _LaneReviewResult(output, calls)
            self._save_lane_review_checkpoint(
                result=result,
                round_index=round_index,
                input_sha256=input_sha256,
            )
            return result

        lanes: tuple[LaneTag, ...] = (
            "activity_flow",
            "guidance",
            "staffing",
            "organization_context",
        )
        outcomes = await asyncio.gather(
            *(review_one(lane) for lane in lanes),
            return_exceptions=True,
        )
        results = []
        for lane, outcome in zip(lanes, outcomes, strict=True):
            if not isinstance(outcome, BaseException):
                results.append(cast(_LaneReviewResult, outcome))
                continue
            reason = f"{lane} 线路全局复核失败：{outcome}"[:1_000]
            self.progress.report(
                f"全局复核·{lane}",
                "本线路失败，父级候选不准入并记录为未决问题",
            )
            admissions = [
                {
                    "candidate_id": key,
                    "status": "unresolved",
                    "reason": reason,
                }
                for key, relation in parent_candidates.items()
                if RELATION_PATTERN_LANE[relation.relation_pattern] == lane
            ]
            results.append(
                _LaneReviewResult(
                    LaneReviewOutput.model_validate(
                        {
                            "lane": lane,
                            "parent_candidate_admissions": admissions,
                            "changes": [],
                            "unresolved_issues": [
                                {
                                    "issue_key": (
                                        f"global-review-failure-{lane}-round-{round_index}"
                                    ),
                                    "affected_object_ids": [],
                                    "affected_assertion_ids": [],
                                    "reason": reason,
                                }
                            ],
                        }
                    ),
                    (
                        outcome.calls
                        if isinstance(outcome, _ProtocolValidationFailure)
                        else 1
                    ),
                )
            )
        return results

    async def _repair_review_changes(
        self,
        *,
        attributes: Sequence[AttributeDecision],
        relations: Sequence[RelationDecision],
        decisions: Sequence[ObjectCardDecision],
        lane_results: Sequence[_LaneReviewResult],
        boundary_plan: PerspectiveBoundaryPlan,
        round_index: int,
    ) -> tuple[list[AttributeDecision], list[RelationDecision], list[_AssertionGroupResult]]:
        changes_by_assertion: dict[str, list[dict[str, object]]] = defaultdict(list)
        for result in lane_results:
            for change in result.output.changes:
                if change.target_kind == "assertion":
                    changes_by_assertion[change.target_id].append(
                        {"lane": result.output.lane, **change.model_dump()}
                    )
        if not changes_by_assertion:
            return list(attributes), list(relations), []

        groups = self._semantic_groups(
            self._in_source_order(
                list(changes_by_assertion),
                [item.assertion_id for item in self.package.assertions],
            ),
            self.settings.max_assertions_per_group,
        )
        decision_by_object = {item.object_id: item for item in decisions}
        view_object_ids = {item.object_id for item in decisions if item.status == "view_card"}
        attribute_subject_ids = {
            item.object_id
            for item in decisions
            if item.status in {"view_card", "support_reference"}
        }
        current_by_assertion: dict[str, dict[str, object]] = {
            item.assertion_id: {"projection_kind": "attribute", **item.model_dump()}
            for item in attributes
        }
        current_by_assertion.update(
            {
                item.assertion_id: {"projection_kind": "relation", **item.model_dump()}
                for item in relations
            }
        )
        semaphore = asyncio.Semaphore(self.settings.max_parallel_groups)

        async def repair_one(group: _SemanticGroup) -> _AssertionGroupResult:
            async with semaphore:
                related_object_ids = {
                    object_id
                    for assertion_id in group.item_ids
                    for object_id in assertion_object_ids(self.assertions[assertion_id])
                }
                object_rows = [
                    self._object_decision_row(object_id, decision_by_object)
                    for object_id in self._in_source_order(
                        list(related_object_ids),
                        [item.object_id for item in self.package.objects],
                    )
                ]

                def validate(output: AssertionProjectionOutput) -> None:
                    self._validate_assertion_output(group, output)
                    if output.reference_review_requests:
                        raise ValueError("全局复核定向修复不得再次请求引用复查")
                    if any(
                        item.object_id not in attribute_subject_ids for item in output.attributes
                    ):
                        raise ValueError(
                            "定向修复后的属性主体必须是 view_card 或 support_reference"
                        )
                    if any(
                        not {value.object_id for value in item.participants} <= view_object_ids
                        for item in output.relations
                    ):
                        raise ValueError("定向修复后的关系端点必须全部是 view_card")
                    for item in output.relations:
                        self._validate_relation_object_roles(
                            item.relation_pattern,
                            item.participants,
                            {
                                object_id: cast(str, decision.role)
                                for object_id, decision in decision_by_object.items()
                                if decision.status == "view_card" and decision.role is not None
                            },
                        )
                    projected = {
                        item.assertion_id: set(item.lane_tags)
                        for item in [*output.attributes, *output.relations]
                    }
                    for assertion_id in group.item_ids:
                        for change in changes_by_assertion[assertion_id]:
                            lane = cast(str, change["lane"])
                            action = change["action"]
                            lanes = projected.get(assertion_id, set())
                            if action == "add_lane" and lane not in lanes:
                                raise ValueError(f"{assertion_id} 修复后仍未进入 {lane}")
                            if action == "remove_lane" and lane in lanes:
                                raise ValueError(f"{assertion_id} 修复后仍错误保留 {lane}")
                            if action == "reproject" and assertion_id not in projected:
                                raise ValueError(f"{assertion_id} 要求重投影但被省略")

                user_prompt = targeted_repair_prompt(
                    document_context=self.exploration.document_context_markdown,
                    boundary_plan=boundary_plan.model_dump(),
                    object_decisions=object_rows,
                    assertions=[
                        self._assertion_row(self.assertions[value])
                        for value in group.item_ids
                    ],
                    current_projections=[
                        current_by_assertion[value]
                        for value in group.item_ids
                        if value in current_by_assertion
                    ],
                    review_changes=[
                        change
                        for value in group.item_ids
                        for change in changes_by_assertion[value]
                    ],
                )
                input_sha256 = hashlib.sha256(user_prompt.encode("utf-8")).hexdigest()
                if cached := self._load_repair_checkpoint(
                    group=group,
                    round_index=round_index,
                    input_sha256=input_sha256,
                    validator=validate,
                ):
                    self.progress.report(
                        f"定向修复·{group.node.node_id}",
                        f"第 {round_index} 轮复用已校验检查点",
                    )
                    return cached
                output, calls = await self._complete_json(
                    messages=[
                        {"role": "system", "content": TARGETED_REPAIR_SYSTEM_PROMPT},
                        {
                            "role": "user",
                            "content": user_prompt,
                        },
                    ],
                    output_model=AssertionProjectionOutput,
                    label=f"定向修复·{group.node.node_id}·第{round_index}轮",
                    output_name="四线路全局复核定向修复",
                    validator=validate,
                )
                result = _AssertionGroupResult(group, output, calls)
                self._save_repair_checkpoint(
                    result=result,
                    round_index=round_index,
                    input_sha256=input_sha256,
                )
                return result

        outcomes = await asyncio.gather(
            *(repair_one(group) for group in groups),
            return_exceptions=True,
        )
        repaired = self._unwrap_results(groups, outcomes, "四线路定向修复")
        target_ids = set(changes_by_assertion)
        new_attributes = [item for item in attributes if item.assertion_id not in target_ids]
        new_relations = [item for item in relations if item.assertion_id not in target_ids]
        new_attributes.extend(item for result in repaired for item in result.output.attributes)
        new_relations.extend(item for result in repaired for item in result.output.relations)
        return new_attributes, new_relations, repaired

    async def _resolve_reference_reviews(
        self,
        results: list[_AssertionGroupResult],
        boundary_plan: PerspectiveBoundaryPlan,
    ) -> tuple[
        list[_AssertionGroupResult],
        list[ReferenceReviewDecision],
        list[AssertionReferenceAmendment],
    ]:
        reviews: list[ReferenceReviewDecision] = []
        amendments: list[AssertionReferenceAmendment] = []
        resolved_results: list[_AssertionGroupResult] = []

        for result in results:
            output = result.output
            calls = result.model_calls
            attributes = list(output.attributes)
            relations = list(output.relations)
            omitted = list(output.omitted_assertion_ids)

            for request in output.reference_review_requests:
                review, review_calls = await self._review_reference(
                    result.group,
                    request,
                )
                calls += review_calls
                reviews.append(review)
                amendment = self._apply_reference_review(request, review)
                if amendment:
                    amendments.append(amendment)

                reprojected, projection_calls = await self._reproject_assertion(
                    result.group,
                    request,
                    review,
                    boundary_plan,
                )
                calls += projection_calls
                attributes.extend(reprojected.attributes)
                relations.extend(reprojected.relations)
                omitted.extend(reprojected.omitted_assertion_ids)

            resolved_results.append(
                _AssertionGroupResult(
                    result.group,
                    AssertionProjectionOutput(
                        attributes=attributes,
                        relations=relations,
                        reference_review_requests=[],
                        omitted_assertion_ids=omitted,
                    ),
                    calls,
                )
            )

        return (
            resolved_results,
            reviews,
            amendments,
        )

    async def _review_reference(
        self,
        group: _SemanticGroup,
        request: ReferenceReviewRequest,
    ) -> tuple[ReferenceReviewDecision, int]:
        assertion = self.assertions[request.assertion_id]
        candidates = [
            self._object_identity_row(self.objects[value]) for value in request.candidate_object_ids
        ]
        self.progress.report(
            f"引用复查·{request.assertion_id}",
            f"开始复查 {len(candidates)} 个候选 Object",
        )
        output, calls = await self._complete_json(
            messages=[
                {"role": "system", "content": REFERENCE_REVIEW_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": reference_review_prompt(
                        document_context=self.exploration.document_context_markdown,
                        lineage=self._lineage_text(group.node),
                        region_label=group.node.label,
                        request=request.model_dump(),
                        assertion=self._assertion_row(assertion),
                        candidate_objects=candidates,
                        evidence_markdown=self._assertion_evidence_text(assertion),
                    ),
                },
            ],
            output_model=ReferenceReviewDecision,
            label=f"引用复查·{request.assertion_id}",
            output_name="Assertion Object 引用复查",
            validator=lambda value: self._validate_reference_review(
                request,
                value,
            ),
        )
        self.progress.report(
            f"引用复查·{request.assertion_id}",
            (
                f"完成：确认 {len(output.confirmed_object_ids)}，"
                f"拒绝 {len(output.rejected_object_ids)}，"
                f"存疑 {len(output.ambiguous_object_ids)}"
            ),
        )
        return output, calls

    async def _reproject_assertion(
        self,
        group: _SemanticGroup,
        request: ReferenceReviewRequest,
        review: ReferenceReviewDecision,
        boundary_plan: PerspectiveBoundaryPlan,
    ) -> tuple[AssertionProjectionOutput, int]:
        assertion = self.assertions[request.assertion_id]
        referenced = assertion_object_ids(assertion)
        referenced_objects = [
            self._object_identity_row(self.objects[value]) for value in referenced
        ]
        single_group = _SemanticGroup(group.node, (request.assertion_id,))

        def validate(output: AssertionProjectionOutput) -> None:
            self._validate_assertion_output(single_group, output)
            if output.reference_review_requests:
                raise ValueError("引用复查后的单条重投影不能再次请求引用复查")

        return await self._complete_json(
            messages=[
                {"role": "system", "content": ASSERTION_PROJECTION_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": resolved_assertion_projection_prompt(
                        document_context=self.exploration.document_context_markdown,
                        boundary_plan=boundary_plan.model_dump(),
                        lineage=self._lineage_text(group.node),
                        region_label=group.node.label,
                        referenced_objects=referenced_objects,
                        assertion=self._assertion_row(assertion),
                        review=review.model_dump(),
                    ),
                },
            ],
            output_model=AssertionProjectionOutput,
            label=f"叙述重投影·{request.assertion_id}",
            output_name="复查后 Assertion 投影",
            validator=validate,
        )

    async def _complete_json(
        self,
        *,
        messages: list[Mapping[str, Any]],
        output_model: type[OutputModel],
        label: str,
        output_name: str,
        validator: Callable[[OutputModel], None],
    ) -> tuple[OutputModel, int]:
        calls = repairs = 0
        conversation = messages
        while True:
            turn = await self.model.complete_turn(
                messages=conversation,
                request_label=label,
                thinking="enabled",
            )
            calls += 1
            if turn.tool_calls:
                raise ValueError(f"{output_name}阶段不能调用工具")
            try:
                output = output_model.model_validate_json(_json_object(turn.content))
                validator(output)
                return output, calls
            except (ValidationError, ValueError, json.JSONDecodeError) as error:
                if repairs >= MAX_PROTOCOL_REPAIRS:
                    raise _ProtocolValidationFailure(output_name, calls, error) from error
                repairs += 1
                self.progress.report(
                    label,
                    f"协议校验失败，进行第 {repairs}/{MAX_PROTOCOL_REPAIRS} 次修复：{error}",
                )
                conversation = [
                    *conversation,
                    turn.as_assistant_message(),
                    {"role": "user", "content": repair_prompt(error, output_name)},
                ]

    def _object_projection_groups(
        self,
        item_ids: list[str],
        relations: Sequence[RelationDecision],
    ) -> list[_SemanticGroup]:
        """按投影关系连通分量分组；无关系对象只与同来源区域对象合并。"""

        selected = set(item_ids)
        source_position = {value: index for index, value in enumerate(item_ids)}
        parent = {value: value for value in item_ids}

        def find(value: str) -> str:
            while parent[value] != value:
                parent[value] = parent[parent[value]]
                value = parent[value]
            return value

        def union(left: str, right: str) -> None:
            left_root, right_root = find(left), find(right)
            if left_root != right_root:
                parent[right_root] = left_root

        for relation in relations:
            endpoints = [
                item.object_id for item in relation.participants if item.object_id in selected
            ]
            for endpoint in endpoints[1:]:
                union(endpoints[0], endpoint)

        components: dict[str, list[str]] = defaultdict(list)
        for object_id in item_ids:
            components[find(object_id)].append(object_id)

        units: list[list[str]] = []
        isolated_by_origin: dict[str, list[str]] = defaultdict(list)
        for component in components.values():
            if len(component) > 1:
                units.append(component)
            else:
                object_id = component[0]
                isolated_by_origin[self._object_origin_node_id(object_id)].append(object_id)
        units.extend(isolated_by_origin.values())
        units.sort(key=lambda values: min(source_position[value] for value in values))

        result: list[_SemanticGroup] = []
        for unit in units:
            current: list[str] = []
            for object_id in unit:
                candidate = [*current, object_id]
                if current and (
                    len(candidate) > self.settings.max_objects_per_group
                    or self._object_group_payload_chars(candidate)
                    > self.settings.max_object_group_chars
                ):
                    result.append(self._object_group(current))
                    current = [object_id]
                else:
                    current = candidate
            if current:
                result.append(self._object_group(current))
        return result

    def _object_group(self, item_ids: Sequence[str]) -> _SemanticGroup:
        return _SemanticGroup(
            self._common_origin_node(item_ids),
            tuple(item_ids),
        )

    def _object_group_payload_chars(self, item_ids: Sequence[str]) -> int:
        group = self._object_group(item_ids)
        objects, assertions = self._object_group_rows(group)
        return len(
            json.dumps(
                {"objects": objects, "assertions": assertions},
                ensure_ascii=False,
            )
        )

    def _semantic_groups(
        self,
        item_ids: list[str],
        max_items: int,
    ) -> list[_SemanticGroup]:
        by_origin: dict[str, list[str]] = defaultdict(list)
        for item_id in item_ids:
            origin = item_id.partition("/")[0]
            by_origin[origin if origin in self.nodes else self.root_id].append(item_id)

        cache: dict[str, list[str]] = {}

        def subtree_items(node_id: str) -> list[str]:
            if node_id not in cache:
                values = list(by_origin.get(node_id, ()))
                for child_id in self.children.get(node_id, ()):
                    values.extend(subtree_items(child_id))
                cache[node_id] = values
            return cache[node_id]

        result: list[_SemanticGroup] = []

        def visit(node_id: str) -> None:
            values = subtree_items(node_id)
            if not values:
                return
            nonempty_children = [
                value for value in self.children.get(node_id, ()) if subtree_items(value)
            ]
            if len(values) <= max_items or not nonempty_children:
                result.append(_SemanticGroup(self.nodes[node_id], tuple(values)))
                return
            if own := by_origin.get(node_id):
                result.append(_SemanticGroup(self.nodes[node_id], tuple(own)))
            for child_id in nonempty_children:
                visit(child_id)

        visit(self.root_id)
        return result

    def _assertion_graph_groups(self, max_items: int) -> list[_SemanticGroup]:
        """按共享 Object 的连通分量组织 Assertion，不混装互不相连的分量。"""

        assertion_ids = [item.assertion_id for item in self.package.assertions]
        parent = {item: item for item in assertion_ids}

        def find(value: str) -> str:
            while parent[value] != value:
                parent[value] = parent[parent[value]]
                value = parent[value]
            return value

        def union(left: str, right: str) -> None:
            left_root, right_root = find(left), find(right)
            if left_root != right_root:
                parent[right_root] = left_root

        for assertions in self.assertions_by_object.values():
            ids = [item.assertion_id for item in assertions]
            for item in ids[1:]:
                union(ids[0], item)

        components: dict[str, list[str]] = defaultdict(list)
        for assertion_id in assertion_ids:
            components[find(assertion_id)].append(assertion_id)
        ordered_components = sorted(
            components.values(),
            key=lambda values: assertion_ids.index(values[0]),
        )
        units: list[list[str]] = []
        for index, component in enumerate(ordered_components, 1):
            component_id = f"component-{index:04d}"
            self.assertion_component_ids.update(
                {assertion_id: component_id for assertion_id in component}
            )
            units.extend(
                component[position : position + max_items]
                for position in range(0, len(component), max_items)
            )

        return [
            _SemanticGroup(
                self._common_origin_node(unit),
                tuple(unit),
            )
            for unit in units
        ]

    def _common_origin_node(self, item_ids: Sequence[str]) -> RegionNode:
        lineage_sets = []
        for item_id in item_ids:
            origin_id = item_id.partition("/")[0]
            node = self.nodes.get(origin_id, self.nodes[self.root_id])
            lineage: list[str] = []
            while True:
                lineage.append(node.node_id)
                if not node.parent_id:
                    break
                node = self.nodes[node.parent_id]
            lineage_sets.append(list(reversed(lineage)))
        common = self.root_id
        for values in zip(*lineage_sets, strict=False):
            if len(set(values)) != 1:
                break
            common = values[0]
        return self.nodes[common]

    def _validate_object_role_output(
        self,
        group: _SemanticGroup,
        output: ObjectRoleOutput,
    ) -> None:
        expected = set(group.item_ids)
        actual = {item.object_id for item in output.decisions}
        if actual != expected:
            raise ValueError(
                "对象视角边界分类必须完整覆盖输入；"
                f"缺少 {sorted(expected - actual)}；越界 {sorted(actual - expected)}"
            )

    def _validate_assertion_output(
        self,
        group: _SemanticGroup,
        output: AssertionProjectionOutput,
    ) -> None:
        expected = set(group.item_ids)
        actual = {
            *[item.assertion_id for item in output.attributes],
            *[item.assertion_id for item in output.relations],
            *[item.assertion_id for item in output.reference_review_requests],
            *output.omitted_assertion_ids,
        }
        if actual != expected:
            raise ValueError(
                "Assertion 投影必须完整覆盖输入；"
                f"缺少 {sorted(expected - actual)}；越界 {sorted(actual - expected)}"
            )
        for item in output.reference_review_requests:
            allowed = {
                value["object_id"]
                for value in self._reference_candidates_for_assertion(
                    self.assertions[item.assertion_id]
                )
            }
            unknown = set(item.candidate_object_ids) - allowed
            if unknown:
                raise ValueError(
                    f"引用复查只能请求当前 Assertion 明示的候选 Object：{sorted(unknown)}"
                )
        for item in output.attributes:
            referenced = set(assertion_object_ids(self.assertions[item.assertion_id]))
            if item.object_id not in referenced:
                raise ValueError("属性所属 Object 必须由该 Assertion 明确引用")
        for item in output.relations:
            endpoint_ids = {value.object_id for value in item.participants}
            referenced = set(assertion_object_ids(self.assertions[item.assertion_id]))
            if not endpoint_ids <= referenced:
                raise ValueError("关系所有参与 Object 必须由该 Assertion 明确引用")

    def _validate_parent_synthesis(
        self,
        node: RegionNode,
        output: ParentSynthesisOutput,
        view_object_roles: Mapping[str, str],
        projected_assertion_ids: set[str],
    ) -> None:
        direct_children = set(self.children[node.node_id])
        seen: set[tuple[object, ...]] = set()
        for item in output.relations:
            participant_ids = {value.object_id for value in item.participants}
            if not participant_ids <= set(view_object_roles):
                raise ValueError("父节点关系参与者必须全部是当前 view_card")
            self._validate_relation_object_roles(
                item.relation_pattern,
                item.participants,
                view_object_roles,
            )
            if not set(item.supporting_child_node_ids) <= direct_children:
                raise ValueError("父节点关系只能引用当前节点的直接孩子")
            if not set(item.supporting_assertion_ids) <= projected_assertion_ids:
                raise ValueError("父节点关系只能引用当前已经投影的 Assertion")
            supporting_evidence_ids = {
                evidence_id
                for assertion_id in item.supporting_assertion_ids
                for evidence_id in self.assertions[assertion_id].evidence_ids
            }
            if not set(item.proof_evidence_ids) <= supporting_evidence_ids:
                raise ValueError("proof_evidence_ids 必须来自 supporting Assertion")
            supported_objects = {
                object_id
                for assertion_id in item.supporting_assertion_ids
                for object_id in assertion_object_ids(self.assertions[assertion_id])
            }
            if not participant_ids <= supported_objects:
                raise ValueError("父节点关系的每个端点必须有 supporting Assertion")
            if item.proof_kind == "structural_recovery":
                if item.relation_pattern not in {
                    "classification",
                    "workflow_use",
                    "composition",
                }:
                    raise ValueError(
                        "structural_recovery 只能恢复 classification、workflow_use 或 composition"
                    )
                structural_issues = self._blocking_source_issues_for_owned_blocks(node)
                if structural_issues:
                    raise ValueError(
                        "结构恢复触及父节点自有原文冲突，应输出 source_conflict："
                        + "；".join(value["reason"] for value in structural_issues)
                    )
            elif item.proof_kind == "direct_statement" and not any(
                participant_ids <= set(assertion_object_ids(self.assertions[assertion_id]))
                for assertion_id in item.supporting_assertion_ids
            ):
                raise ValueError("direct_statement 必须至少有一条 Assertion 同时引用全部关系参与者")
            blocking_issues = self._blocking_source_issues_for_evidence(item.proof_evidence_ids)
            if blocking_issues:
                raise ValueError(
                    "关系证明触及来源冲突，不能恢复正式关系；应输出 source_conflict："
                    + "；".join(value["reason"] for value in blocking_issues)
                )
            participant_branches = {
                child_id
                for child_id in direct_children
                for object_id in participant_ids
                if self._object_origin_node_id(object_id) in self._descendant_node_ids(child_id)
            }
            if len(participant_branches) < 2:
                raise ValueError("父节点只能恢复至少跨两个直接孩子的关系")
            if not participant_branches <= set(item.supporting_child_node_ids):
                raise ValueError("supporting_child_node_ids 未覆盖全部关系端点分支")
            key = (
                item.relation_pattern,
                tuple(sorted((value.object_id, value.role) for value in item.participants)),
            )
            if key in seen:
                raise ValueError("父节点不能重复输出同一关系")
            seen.add(key)

    def _validate_relation_decision_roles(
        self,
        relations: Sequence[RelationDecision],
        decisions: Sequence[ObjectCardDecision],
    ) -> None:
        role_by_object = {
            item.object_id: item.role
            for item in decisions
            if item.status == "view_card" and item.role is not None
        }
        for item in relations:
            self._validate_relation_object_roles(
                item.relation_pattern,
                item.participants,
                role_by_object,
            )

    def _relation_role_review_results(
        self,
        relations: Sequence[RelationDecision],
        decisions: Sequence[ObjectCardDecision],
    ) -> list[_LaneReviewResult]:
        role_by_object = {
            item.object_id: cast(str, item.role)
            for item in decisions
            if item.status == "view_card" and item.role is not None
        }
        changes_by_lane: dict[LaneTag, list[LaneReviewChange]] = defaultdict(list)
        for item in relations:
            try:
                self._validate_relation_object_roles(
                    item.relation_pattern,
                    item.participants,
                    role_by_object,
                )
            except ValueError as error:
                lane = RELATION_PATTERN_LANE[item.relation_pattern]
                changes_by_lane[lane].append(
                    LaneReviewChange(
                        target_kind="assertion",
                        target_id=item.assertion_id,
                        action="reproject",
                        reason=(
                            "关系参与者与已确认 Object 角色不相容；"
                            f"必须保持 Object 真实角色并重投影：{error}"
                        ),
                    )
                )
        return [
            _LaneReviewResult(
                LaneReviewOutput(
                    lane=lane,
                    parent_candidate_admissions=[],
                    changes=changes,
                    unresolved_issues=[],
                ),
                0,
            )
            for lane, changes in changes_by_lane.items()
        ]

    @staticmethod
    def _validate_relation_object_roles(
        relation_pattern: str,
        participants: Sequence[RelationParticipantDecision],
        role_by_object: Mapping[str, str],
    ) -> None:
        signature = RELATION_OBJECT_ROLE_SIGNATURES[relation_pattern]
        for participant in participants:
            object_id = participant.object_id
            relation_role = participant.role
            object_role = role_by_object.get(object_id)
            allowed = signature.get(relation_role, set())
            if object_role not in allowed:
                raise ValueError(
                    f"{relation_pattern}.{relation_role} 不接受 "
                    f"{object_id} 的 Object 角色 {object_role}；允许 {sorted(allowed)}"
                )

    def _validate_lane_review(
        self,
        lane: LaneTag,
        output: LaneReviewOutput,
        parent_candidates: Mapping[str, RelationProjection],
    ) -> None:
        if output.lane != lane:
            raise ValueError(f"线路审查必须返回 {lane}")
        expected_candidates = {
            key
            for key, relation in parent_candidates.items()
            if RELATION_PATTERN_LANE[relation.relation_pattern] == lane
        }
        actual_candidates = {item.candidate_id for item in output.parent_candidate_admissions}
        if actual_candidates != expected_candidates:
            raise ValueError(
                "线路必须显式审查全部本线父级恢复候选；"
                f"缺少 {sorted(expected_candidates - actual_candidates)}；"
                f"越界 {sorted(actual_candidates - expected_candidates)}"
            )
        for item in output.changes:
            if item.target_kind == "assertion":
                if item.target_id not in self.assertions:
                    raise ValueError("线路审查引用了不存在的 Assertion")
            else:
                raise ValueError("父级恢复候选必须通过 parent_candidate_admissions 审查")

    def _lane_review_assertion_ids(
        self,
        *,
        lane: LaneTag,
        decisions: Sequence[ObjectCardDecision],
        attributes: Sequence[AttributeProjection],
        relations: Sequence[RelationProjection],
    ) -> set[str]:
        """为单条线路生成高召回候选，避免四个审查器反复阅读整份基础图。"""

        selected = {
            item.source_assertion.assertion_id
            for item in attributes
            if lane in item.lane_tags
        }
        for item in relations:
            if lane not in item.lane_tags:
                continue
            if item.source_assertion is not None:
                selected.add(item.source_assertion.assertion_id)
            selected.update(value.assertion_id for value in item.supporting_assertions)

        roles = {
            item.object_id: item.role
            for item in decisions
            if item.status == "view_card" and item.role is not None
        }
        flow_roles = {"activity", "activity_trait", "workflow", "work_step"}
        operational_roles = {
            *flow_roles,
            "system",
            "funding_scheme",
            "communication_channel",
            "standard",
            "document",
            "venue",
            "resource",
        }
        flow_terms = (
            "属于",
            "分类",
            "使用",
            "包含",
            "组成",
            "流程",
            "步骤",
            "先于",
            "随后",
            "依赖",
            "前提",
        )
        guidance_terms = (
            "必须",
            "不得",
            "不能",
            "应当",
            "需要",
            "建议",
            "原则",
            "规范",
            "经验",
            "通常",
            "注意",
            "风险",
            "复盘",
            "否则",
            "只有",
        )
        staffing_terms = ("担任", "负责", "参与", "协助", "人员", "成员", "负责人")
        context_terms = (
            "当前",
            "当时",
            "时期",
            "人数",
            "容量",
            "经费",
            "资源",
            "授权",
            "执行能力",
        )

        for assertion in self.package.assertions:
            if assertion.assertion_id in selected:
                continue
            object_roles = {
                roles[object_id]
                for object_id in assertion_object_ids(assertion)
                if object_id in roles
            }
            statement = self._render_assertion(assertion.assertion_id)
            if lane == "activity_flow":
                role_pair = (
                    {"activity", "activity_trait"} <= object_roles
                    or (
                        bool({"activity", "activity_trait"} & object_roles)
                        and "workflow" in object_roles
                    )
                    or len(object_roles & {"workflow", "work_step"}) >= 2
                )
                include = role_pair or (
                    bool(object_roles & flow_roles)
                    and any(term in statement for term in flow_terms)
                )
            elif lane == "guidance":
                include = bool(object_roles & operational_roles) and (
                    assertion.mode == "viewpoint"
                    or any(term in statement for term in guidance_terms)
                )
            elif lane == "staffing":
                include = bool(object_roles & {"person", "role"}) or any(
                    term in statement for term in staffing_terms
                )
            else:
                include = bool(object_roles & {"organization", "period"}) and (
                    assertion.temporal_scope.kind != "unknown"
                    or any(term in statement for term in context_terms)
                )
            if include:
                selected.add(assertion.assertion_id)
        return selected

    @staticmethod
    def _projected_assertion_ids(
        attributes: Sequence[AttributeDecision],
        relations: Sequence[RelationDecision],
    ) -> set[str]:
        return {
            *[item.assertion_id for item in attributes],
            *[item.assertion_id for item in relations],
        }

    @staticmethod
    def _derive_object_lanes(
        attributes: Sequence[AttributeDecision],
        relations: Sequence[RelationDecision],
        parent_relations: Sequence[RelationProjection] = (),
    ) -> dict[str, list[LaneTag]]:
        result: dict[str, list[LaneTag]] = defaultdict(list)
        for item in attributes:
            result[item.object_id].extend(item.lane_tags)
        for item in relations:
            for participant in item.participants:
                result[participant.object_id].extend(item.lane_tags)
        for item in parent_relations:
            for participant in item.participants:
                object_id = participant.card_id.removeprefix("object:")
                result[object_id].extend(item.lane_tags)
        return {
            object_id: cast(list[LaneTag], list(dict.fromkeys(lanes)))
            for object_id, lanes in result.items()
        }

    def _parent_synthesis_nodes(self, view_object_ids: set[str]) -> list[RegionNode]:
        result = []
        for node in self.exploration.region_tree.nodes:
            direct_children = self.children.get(node.node_id, [])
            if len(direct_children) < 2:
                continue
            populated = 0
            for child_id in direct_children:
                descendants = self._descendant_node_ids(child_id)
                if any(
                    self._object_origin_node_id(object_id) in descendants
                    for object_id in view_object_ids
                ):
                    populated += 1
            if populated >= 2:
                result.append(node)
        return sorted(result, key=lambda item: (-item.depth, self.node_order[item.node_id]))

    def _parent_recovery_assertion_ids(
        self,
        *,
        node: RegionNode,
        projected_assertion_ids: set[str],
        view_object_ids: set[str],
    ) -> set[str]:
        """只保留图上确实跨直接孩子或由父节点自己持有的恢复候选。"""

        branch_by_origin: dict[str, str] = {}
        for child_id in self.children.get(node.node_id, ()):
            for descendant_id in self._descendant_node_ids(child_id):
                branch_by_origin[descendant_id] = child_id

        selected = set()
        for assertion_id in projected_assertion_ids:
            assertion = self.assertions[assertion_id]
            assertion_origin_id = assertion_id.partition("/")[0]
            branches = set()
            for object_id in assertion_object_ids(assertion):
                if object_id not in view_object_ids:
                    continue
                object_origin_id = self._object_origin_node_id(object_id)
                if object_origin_id in branch_by_origin:
                    branches.add(branch_by_origin[object_origin_id])
            if assertion_origin_id == node.node_id or len(branches) >= 2:
                selected.add(assertion_id)
        return selected

    def _affected_parent_ids(
        self,
        assertion_ids: set[str],
    ) -> set[str]:
        """只重算被修复基础 Assertion 所在区域的祖先父节点。"""

        candidates = {
            item.node_id
            for item in self.exploration.region_tree.nodes
            if len(self.children.get(item.node_id, ())) >= 2
        }
        affected: set[str] = set()
        origins = {assertion_id.partition("/")[0] for assertion_id in assertion_ids}
        for origin_id in origins:
            current = self.nodes.get(origin_id)
            while current is not None:
                if current.node_id in candidates:
                    affected.add(current.node_id)
                current = self.nodes.get(current.parent_id) if current.parent_id else None
        return affected

    def _descendant_node_ids(self, node_id: str) -> set[str]:
        result: set[str] = set()
        pending = [node_id]
        while pending:
            current = pending.pop()
            if current in result:
                continue
            result.add(current)
            pending.extend(self.children.get(current, ()))
        return result

    def _object_origin_node_id(self, object_id: str) -> str:
        origin_id = object_id.partition("/")[0]
        return origin_id if origin_id in self.nodes else self.root_id

    @staticmethod
    def _compact_card(item: ObjectCard) -> dict[str, object]:
        return {
            "card_id": item.card_id,
            "object_id": item.object_id,
            "title": item.title_markdown,
            "role": item.role,
            "lane_tags": item.lane_tags,
            "source_assertion_ids": item.source_assertion_ids,
        }

    @staticmethod
    def _compact_attribute(item: AttributeProjection) -> dict[str, object]:
        return {
            "projection_id": item.projection_id,
            "assertion_id": item.source_assertion.assertion_id,
            "subject_object_id": item.subject_object_id,
            "semantic_kind": item.semantic_kind,
            "lane_tags": item.lane_tags,
            "statement": item.rendered_statement_markdown,
        }

    def _compact_relation(self, item: RelationProjection) -> dict[str, object]:
        return {
            "projection_id": item.projection_id,
            "parent_relation_key": (
                self._parent_relation_key(item)
                if item.derivation_kind == "parent_recovery"
                else None
            ),
            "relation_pattern": item.relation_pattern,
            "participants": [value.model_dump() for value in item.participants],
            "semantic_kind": item.semantic_kind,
            "lane_tags": item.lane_tags,
            "derivation_kind": item.derivation_kind,
            "source_assertion_id": (
                item.source_assertion.assertion_id if item.source_assertion is not None else None
            ),
            "supporting_assertion_ids": [
                value.assertion_id for value in item.supporting_assertions
            ],
            "proof_kind": item.parent_proof_kind,
            "proof_evidence_ids": item.proof_evidence_ids,
            "source_region_node_ids": item.source_region_node_ids,
            "temporal_scope": (
                item.source_assertion.temporal_scope.model_dump()
                if item.source_assertion is not None
                else item.synthesized_temporal_scope.model_dump()
            ),
            "temporal_basis_markdown": (
                item.source_assertion.temporal_basis_markdown
                if item.source_assertion is not None
                else item.synthesized_temporal_basis_markdown
            ),
            "statement": item.rendered_statement_markdown,
        }

    @staticmethod
    def _parent_relation_key(item: RelationProjection) -> str:
        payload = json.dumps(
            {
                "pattern": item.relation_pattern,
                "participants": sorted((value.card_id, value.role) for value in item.participants),
                "regions": item.source_region_node_ids,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        return "parent-relation:" + hashlib.sha256(payload.encode()).hexdigest()[:16]

    def _build_parent_relations(
        self,
        results: Sequence[_ParentSynthesisResult],
    ) -> list[RelationProjection]:
        built: dict[str, RelationProjection] = {}
        for result in results:
            for decision in result.output.relations:
                supporting = [self.assertions[value] for value in decision.supporting_assertion_ids]
                relation = RelationProjection(
                    projection_id="pending",
                    relation_pattern=decision.relation_pattern,
                    participants=[
                        RelationParticipantProjection(
                            card_id=object_card_id(value.object_id),
                            role=value.role,
                        )
                        for value in decision.participants
                    ],
                    semantic_kind=decision.semantic_kind,
                    lane_tags=decision.lane_tags,
                    derivation_kind="parent_recovery",
                    source_assertion=None,
                    supporting_assertions=supporting,
                    source_region_node_ids=[
                        result.node.node_id,
                        *decision.supporting_child_node_ids,
                    ],
                    parent_proof_kind=decision.proof_kind,
                    proof_evidence_ids=decision.proof_evidence_ids,
                    synthesized_temporal_scope=decision.temporal_scope,
                    synthesized_temporal_basis_markdown=(decision.temporal_basis_markdown),
                    rendered_statement_markdown=self._render_parent_relation(decision),
                    reason=decision.reason,
                )
                key = self._parent_relation_key(relation)
                built[key] = relation.model_copy(update={"projection_id": key})
        return list(built.values())

    def _render_parent_relation(self, decision: ParentRelationDecision) -> str:
        participants = decision.participants
        labels_by_role: dict[str, list[str]] = defaultdict(list)
        for item in participants:
            labels_by_role[item.role].append(self.objects[item.object_id].label)

        def one(role: str) -> str:
            return labels_by_role[role][0]

        def many(role: str) -> str:
            return "、".join(labels_by_role[role])

        pattern = decision.relation_pattern
        renderers: dict[str, Callable[[], str]] = {
            "classification": lambda: f"{one('subject')}归入{one('category')}。",
            "workflow_use": lambda: f"{one('workflow_user')}使用{one('workflow')}。",
            "composition": lambda: f"{one('whole')}包含{many('part')}。",
            "sequence": lambda: f"{one('previous')}先于{one('next')}。",
            "dependency": lambda: f"{one('dependent')}以{one('dependency')}为必要条件。",
            "guidance_application": lambda: f"关于{one('anchor')}的指导适用于{one('scope')}。",
            "role_holding": lambda: f"{one('person')}担任{one('role')}。",
            "responsibility": lambda: (
                f"{one('responsible_party')}负责{one('responsibility_target')}。"
            ),
            "participation": lambda: f"{many('participant')}参与{one('participation_target')}。",
            "contextualization": lambda: (
                f"{one('context')}构成{one('contextualized_object')}的运营背景。"
            ),
        }
        return renderers[pattern]()

    def _admit_parent_candidates(
        self,
        candidates: Sequence[RelationProjection],
        lane_results: Sequence[_LaneReviewResult],
        feedback: dict[str, list[dict[str, object]]],
    ) -> tuple[list[RelationProjection], list[ParentSynthesisIssue]]:
        admissions = {
            item.candidate_id: (result.output.lane, item)
            for result in lane_results
            for item in result.output.parent_candidate_admissions
        }
        accepted = []
        issues = []
        for relation in candidates:
            key = self._parent_relation_key(relation)
            lane, admission = admissions[key]
            if admission.status == "accept":
                accepted.append(relation)
                continue
            parent_id = relation.source_region_node_ids[0]
            feedback[parent_id].append(
                {
                    "lane": lane,
                    "candidate_id": key,
                    "status": admission.status,
                    "reason": admission.reason,
                }
            )
            issues.append(
                ParentSynthesisIssue(
                    issue_key=f"{parent_id}:{key}:{admission.status}",
                    kind=(
                        "insufficient_support"
                        if admission.status == "reject"
                        else "source_conflict"
                    ),
                    affected_object_ids=[
                        item.card_id.removeprefix("object:") for item in relation.participants
                    ],
                    affected_assertion_ids=[
                        item.assertion_id for item in relation.supporting_assertions
                    ],
                    reason=admission.reason,
                )
            )
        return accepted, issues

    @staticmethod
    def _review_issue_signature(results: Sequence[_LaneReviewResult]) -> str:
        rows = sorted(
            (
                result.output.lane,
                change.target_kind,
                change.target_id,
                change.action,
            )
            for result in results
            for change in result.output.changes
        )
        if not rows:
            return ""
        return hashlib.sha256(json.dumps(rows, ensure_ascii=False).encode()).hexdigest()

    @staticmethod
    def _projection_state_signature(
        attributes: Sequence[AttributeDecision],
        relations: Sequence[RelationDecision],
        parent_relations: Sequence[RelationProjection],
    ) -> str:
        payload = {
            "attributes": sorted(
                json.dumps(item.model_dump(), sort_keys=True, ensure_ascii=False)
                for item in attributes
            ),
            "relations": sorted(
                json.dumps(item.model_dump(), sort_keys=True, ensure_ascii=False)
                for item in relations
            ),
            "parent_relations": sorted(item.projection_id for item in parent_relations),
        }
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()
        ).hexdigest()

    def _validate_reference_review(
        self,
        request: ReferenceReviewRequest,
        review: ReferenceReviewDecision,
    ) -> None:
        if review.assertion_id != request.assertion_id:
            raise ValueError("引用复查返回了错误的 assertion_id")
        expected = set(request.candidate_object_ids)
        actual = {
            *review.confirmed_object_ids,
            *review.rejected_object_ids,
            *review.ambiguous_object_ids,
        }
        if actual != expected:
            raise ValueError(
                "引用复查必须完整覆盖请求候选；"
                f"缺少 {sorted(expected - actual)}；越界 {sorted(actual - expected)}"
            )
        self._revised_assertion(request, review)

    def _revised_assertion(
        self,
        request: ReferenceReviewRequest,
        review: ReferenceReviewDecision,
    ) -> Assertion | None:
        if not review.confirmed_object_ids:
            return None
        original = self.assertions[request.assertion_id]
        revised = Assertion.model_validate(
            {
                **original.model_dump(),
                "statement_template_markdown": (review.revised_statement_template_markdown),
            }
        )
        old_references = set(original.referenced_object_ids)
        expected_references = old_references | set(review.confirmed_object_ids)
        actual_references = set(revised.referenced_object_ids)
        if actual_references != expected_references:
            raise ValueError(
                "引用修订只能保留原引用并增加已确认 Object；"
                f"缺少 {sorted(expected_references - actual_references)}；"
                f"越界 {sorted(actual_references - expected_references)}"
            )

        original_rendered = render_statement(original, self.objects)
        for object_id in review.confirmed_object_ids:
            item = self.objects[object_id]
            names = sorted(
                {item.label, *item.aliases},
                key=len,
                reverse=True,
            )
            for name in names:
                original_rendered = original_rendered.replace(name, item.label)
        if render_statement(revised, self.objects) != original_rendered:
            raise ValueError("引用修订除对象占位替换外不得改变 Assertion 可见正文")
        return revised

    def _apply_reference_review(
        self,
        request: ReferenceReviewRequest,
        review: ReferenceReviewDecision,
    ) -> AssertionReferenceAmendment | None:
        revised = self._revised_assertion(request, review)
        if revised is None:
            return None
        original = self.assertions[request.assertion_id]
        self.assertions[request.assertion_id] = revised
        for object_id, assertions in self.assertions_by_object.items():
            self.assertions_by_object[object_id] = [
                revised if item.assertion_id == revised.assertion_id else item
                for item in assertions
            ]
        for object_id in review.confirmed_object_ids:
            if all(
                item.assertion_id != revised.assertion_id
                for item in self.assertions_by_object[object_id]
            ):
                self.assertions_by_object[object_id].append(revised)
        return AssertionReferenceAmendment(
            assertion_id=request.assertion_id,
            added_object_ids=review.confirmed_object_ids,
            old_statement_template_markdown=original.statement_template_markdown,
            new_statement_template_markdown=revised.statement_template_markdown,
            reason=review.reason,
        )

    def _build_cards(
        self,
        decisions: Sequence[ObjectCardDecision],
        projected_assertion_ids: set[str],
        lane_map: Mapping[str, Sequence[LaneTag]],
    ) -> list[ObjectCard]:
        cards = []
        for decision in decisions:
            if decision.status != "view_card" or decision.role is None:
                raise ValueError("只有 view_card 决定可以生成对象卡")
            item = self.objects[decision.object_id]
            cards.append(
                ObjectCard(
                    card_id=object_card_id(item.object_id),
                    object_id=item.object_id,
                    role=decision.role,
                    title_markdown=item.label,
                    aliases=item.aliases,
                    lane_tags=list(lane_map[item.object_id]),
                    source_assertion_ids=[
                        value.assertion_id
                        for value in self.assertions_by_object[item.object_id]
                        if value.assertion_id in projected_assertion_ids
                    ],
                    attribute_projection_ids=[],
                )
            )
        order = {item.object_id: index for index, item in enumerate(self.package.objects)}
        return sorted(cards, key=lambda item: order[item.object_id])

    def _build_attributes(
        self,
        decisions: Sequence[AttributeDecision],
    ) -> list[AttributeProjection]:
        order = {item.assertion_id: index for index, item in enumerate(self.package.assertions)}
        sorted_items = sorted(decisions, key=lambda item: order[item.assertion_id])
        result = []
        for index, decision in enumerate(sorted_items, 1):
            assertion = self.assertions[decision.assertion_id]
            result.append(
                AttributeProjection(
                    projection_id=f"attribute-{index:04d}",
                    subject_object_id=decision.object_id,
                    semantic_kind=decision.semantic_kind,
                    lane_tags=decision.lane_tags,
                    source_assertion=assertion,
                    rendered_statement_markdown=self._render_assertion(decision.assertion_id),
                    reason=decision.reason,
                )
            )
        return result

    def _build_relations(
        self,
        decisions: Sequence[RelationDecision],
    ) -> list[RelationProjection]:
        order = {item.assertion_id: index for index, item in enumerate(self.package.assertions)}
        sorted_items = sorted(decisions, key=lambda item: order[item.assertion_id])
        result = []
        for index, decision in enumerate(sorted_items, 1):
            assertion = self.assertions[decision.assertion_id]
            result.append(
                RelationProjection(
                    projection_id=f"relation-{index:04d}",
                    relation_pattern=decision.relation_pattern,
                    participants=[
                        RelationParticipantProjection(
                            card_id=object_card_id(value.object_id),
                            role=value.role,
                        )
                        for value in decision.participants
                    ],
                    semantic_kind=decision.semantic_kind,
                    lane_tags=decision.lane_tags,
                    derivation_kind=decision.derivation_kind,
                    source_assertion=assertion,
                    supporting_assertions=[],
                    source_region_node_ids=[],
                    synthesized_temporal_scope=None,
                    synthesized_temporal_basis_markdown=None,
                    rendered_statement_markdown=self._render_assertion(decision.assertion_id),
                    reason=decision.reason,
                )
            )
        return result

    def _attach_projections(
        self,
        cards: list[ObjectCard],
        attributes: Sequence[AttributeProjection],
        relations: Sequence[RelationProjection],
    ) -> list[ObjectCard]:
        attribute_ids: dict[str, list[str]] = defaultdict(list)
        added_tags: dict[str, list[str]] = defaultdict(list)
        for item in attributes:
            card_id = object_card_id(item.subject_object_id)
            attribute_ids[card_id].append(item.projection_id)
            added_tags[card_id].extend(item.lane_tags)
        for item in relations:
            for card_id in {value.card_id for value in item.participants}:
                added_tags[card_id].extend(item.lane_tags)
        return [
            item.model_copy(
                update={
                    "attribute_projection_ids": attribute_ids[item.card_id],
                    "lane_tags": list(dict.fromkeys(added_tags[item.card_id])),
                }
            )
            for item in cards
        ]

    @staticmethod
    def _object_identity_row(item: MemoryObject) -> dict[str, object]:
        return {
            "object_id": item.object_id,
            "label": item.label,
            "aliases": item.aliases,
        }

    def _object_decision_row(
        self,
        object_id: str,
        decision_by_object: Mapping[str, ObjectCardDecision],
    ) -> dict[str, object]:
        decision = decision_by_object.get(object_id)
        return {
            **self._object_identity_row(self.objects[object_id]),
            "perspective_status": (decision.status if decision is not None else "not_classified"),
            "role": decision.role if decision is not None else None,
        }

    def _boundary_inventory(self) -> list[dict[str, object]]:
        """为一次全局边界规划提供紧凑但覆盖全文的 Object 索引。"""

        objects_by_region: dict[str, list[dict[str, object]]] = defaultdict(list)
        for item in self.package.objects:
            assertions = self.assertions_by_object.get(item.object_id, [])
            representative = self._spread_samples(assertions, limit=2)
            origin_id = item.object_id.partition("/")[0]
            origin = self.nodes.get(origin_id, self.nodes[self.root_id])
            objects_by_region[origin.node_id].append(
                {
                    "object_id": item.object_id,
                    "label": item.label,
                    "assertion_count": len(assertions),
                    "representative_assertions": [
                        self._render_assertion(assertion.assertion_id)
                        for assertion in representative
                    ],
                }
            )
        return [
            {
                "region_node_id": node.node_id,
                "region_label": node.label,
                "region_introduction": node.introduction,
                "objects": objects_by_region[node.node_id],
            }
            for node in self.exploration.region_tree.nodes
            if objects_by_region[node.node_id]
        ]

    @staticmethod
    def _spread_samples(
        values: Sequence[Assertion],
        *,
        limit: int,
    ) -> list[Assertion]:
        if len(values) <= limit:
            return list(values)
        positions = {round(index * (len(values) - 1) / (limit - 1)) for index in range(limit)}
        return [values[index] for index in sorted(positions)]

    def _object_group_rows(
        self,
        group: _SemanticGroup,
        allowed_assertion_ids: set[str] | None = None,
    ) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
        assertion_ids = {
            assertion.assertion_id
            for object_id in group.item_ids
            for assertion in self.assertions_by_object.get(object_id, ())
            if allowed_assertion_ids is None or assertion.assertion_id in allowed_assertion_ids
        }
        ordered_assertion_ids = [
            item.assertion_id
            for item in self.package.assertions
            if item.assertion_id in assertion_ids
        ]
        objects = []
        for object_id in group.item_ids:
            item = self.objects[object_id]
            related_ids = {
                value.assertion_id
                for value in self.assertions_by_object.get(object_id, ())
                if allowed_assertion_ids is None or value.assertion_id in allowed_assertion_ids
            }
            objects.append(
                {
                    **self._object_identity_row(item),
                    "assertion_ids": [
                        value for value in ordered_assertion_ids if value in related_ids
                    ],
                }
            )
        return (
            objects,
            [
                self._object_classification_assertion_row(self.assertions[value])
                for value in ordered_assertion_ids
            ],
        )

    def _object_classification_assertion_row(
        self,
        assertion: Assertion,
    ) -> dict[str, object]:
        """对象三态与角色判断只需要完整命题，不重复传输 Evidence 协议细节。"""

        return {
            "assertion_id": assertion.assertion_id,
            "mode": assertion.mode,
            "statement": self._render_assertion(assertion.assertion_id),
            "referenced_object_ids": assertion_object_ids(assertion),
            "temporal_scope": {
                "kind": assertion.temporal_scope.kind,
                "display": assertion.temporal_scope.display,
            },
        }

    def _assertion_row(self, assertion: Assertion) -> dict[str, object]:
        return {
            **assertion.model_dump(),
            "graph_component_id": self.assertion_component_ids.get(
                assertion.assertion_id,
                "component-unknown",
            ),
            "referenced_object_ids": assertion_object_ids(assertion),
            "rendered_statement_markdown": self._render_assertion(assertion.assertion_id),
            "possible_missing_object_references": (
                self._reference_candidates_for_assertion(assertion)
            ),
        }

    def _reference_candidates_for_assertion(
        self,
        assertion: Assertion,
    ) -> list[dict[str, object]]:
        """只列出模板正文中按名称明示、但尚未引用的已有 Object。"""

        statement = assertion.statement_template_markdown.casefold()
        referenced = set(assertion_object_ids(assertion))
        candidates = []
        for item in self.package.objects:
            if item.object_id in referenced:
                continue
            matched_names = [
                name
                for name in (item.label, *item.aliases)
                if name.strip() and name.casefold() in statement
            ]
            if matched_names:
                candidates.append(
                    {
                        **self._object_identity_row(item),
                        "matched_names": list(dict.fromkeys(matched_names)),
                    }
                )
        return candidates

    def _assertion_evidence_text(self, assertion: Assertion) -> str:
        sections = []
        for evidence_id in assertion.evidence_ids:
            evidence = self.evidence[evidence_id]
            header = f"### {evidence.evidence_id}"
            if evidence.note_markdown:
                header += f"\n依据备注：{evidence.note_markdown}"
            sections.append(
                f"{header}\n\n"
                f"{format_blocks(self.index.slice(evidence.start_block_id, evidence.end_block_id))}"
            )
        return "\n\n".join(sections)

    def _parent_evidence_rows(
        self,
        assertion_ids: set[str],
    ) -> list[dict[str, object]]:
        rows = []
        source_order = [item.assertion_id for item in self.package.assertions]
        for assertion_id in self._in_source_order(list(assertion_ids), source_order):
            assertion = self.assertions[assertion_id]
            rows.append(
                {
                    "assertion_id": assertion_id,
                    "statement": self._render_assertion(assertion_id),
                    "temporal_scope": assertion.temporal_scope.model_dump(),
                    "evidence": [
                        {
                            "evidence_id": evidence_id,
                            "blocks": format_blocks(
                                self.index.slice(
                                    self.evidence[evidence_id].start_block_id,
                                    self.evidence[evidence_id].end_block_id,
                                )
                            ),
                        }
                        for evidence_id in assertion.evidence_ids
                    ],
                }
            )
        return rows

    def _source_issues_for_node(self, node: RegionNode) -> list[dict[str, object]]:
        left = self.index.position(node.start_block_id)
        right = self.index.position(node.end_block_id)
        return [
            {
                "source_issue_id": f"source-issue-{index:04d}",
                **issue.model_dump(),
            }
            for index, issue in enumerate(
                self.exploration.region_tree.source_issues,
                1,
            )
            if any(left <= self.index.position(block_id) <= right for block_id in issue.block_ids)
        ]

    def _blocking_source_issues_for_evidence(
        self,
        evidence_ids: Sequence[str],
    ) -> list[dict[str, object]]:
        evidence_block_ids = {
            block.block_id
            for evidence_id in evidence_ids
            for block in self.index.slice(
                self.evidence[evidence_id].start_block_id,
                self.evidence[evidence_id].end_block_id,
            )
        }
        blocking_terms = ("矛盾", "不符", "冲突", "错乱", "缺失", "错误")
        return [
            {
                "source_issue_id": f"source-issue-{index:04d}",
                **issue.model_dump(),
            }
            for index, issue in enumerate(
                self.exploration.region_tree.source_issues,
                1,
            )
            if evidence_block_ids & set(issue.block_ids)
            and "不影响语义" not in issue.reason
            and any(term in issue.reason for term in blocking_terms)
        ]

    def _blocking_source_issues_for_owned_blocks(
        self,
        node: RegionNode,
    ) -> list[dict[str, object]]:
        owned_block_ids = {
            block.block_id
            for segment in node.owned_segments
            for block in self.index.slice(
                segment.start_block_id,
                segment.end_block_id,
            )
        }
        blocking_terms = ("矛盾", "不符", "冲突", "错乱", "缺失", "错误")
        return [
            {
                "source_issue_id": f"source-issue-{index:04d}",
                **issue.model_dump(),
            }
            for index, issue in enumerate(
                self.exploration.region_tree.source_issues,
                1,
            )
            if owned_block_ids & set(issue.block_ids)
            and "不影响语义" not in issue.reason
            and any(term in issue.reason for term in blocking_terms)
        ]

    def _parent_candidate_evidence_rows(
        self,
        relations: Sequence[RelationProjection],
    ) -> list[dict[str, object]]:
        return [
            {
                "candidate_id": self._parent_relation_key(item),
                "proof_kind": item.parent_proof_kind,
                "proof_evidence": [
                    row
                    for row in self._parent_evidence_rows(
                        {value.assertion_id for value in item.supporting_assertions}
                    )
                    if any(
                        evidence["evidence_id"] in item.proof_evidence_ids
                        for evidence in cast(list[dict[str, object]], row["evidence"])
                    )
                ],
                "source_regions": [
                    {
                        "node_id": node_id,
                        "label": self.nodes[node_id].label,
                        "introduction": self.nodes[node_id].introduction,
                        "first_source_block": format_blocks(
                            self.index.slice(
                                self.nodes[node_id].start_block_id,
                                self.nodes[node_id].start_block_id,
                            )
                        ),
                    }
                    for node_id in item.source_region_node_ids
                ],
                "source_issues": self._candidate_source_issues(item),
            }
            for item in relations
            if item.derivation_kind == "parent_recovery"
        ]

    def _candidate_source_issues(
        self,
        relation: RelationProjection,
    ) -> list[dict[str, object]]:
        issues = self._blocking_source_issues_for_evidence(relation.proof_evidence_ids)
        if relation.parent_proof_kind == "structural_recovery":
            issues.extend(
                self._blocking_source_issues_for_owned_blocks(
                    self.nodes[relation.source_region_node_ids[0]]
                )
            )
        return list({cast(str, item["source_issue_id"]): item for item in issues}.values())

    def _render_assertion(self, assertion_id: str) -> str:
        return render_statement(self.assertions[assertion_id], self.objects)

    def _lineage_text(self, node: RegionNode) -> str:
        lineage: list[RegionNode] = []
        current: RegionNode | None = node
        while current is not None:
            lineage.append(current)
            current = self.nodes.get(current.parent_id) if current.parent_id else None
        return "\n".join(
            f"- {item.node_id}｜{item.label}：{item.introduction}" for item in reversed(lineage)
        )

    def _warnings(
        self,
        cards: Sequence[ObjectCard],
        attributes: Sequence[AttributeProjection],
        relations: Sequence[RelationProjection],
    ) -> list[str]:
        warnings = []
        if not cards:
            warnings.append("活动运营视角没有选择任何对象卡。")
        if not relations:
            warnings.append("活动运营视角没有形成任何对象关系。")
        isolated = {item.card_id for item in cards if not item.source_assertion_ids}
        if isolated:
            warnings.append(f"{len(isolated)} 张对象卡没有来源 Assertion。")
        return warnings

    def _parent_checkpoint_path(
        self,
        node: RegionNode,
        round_index: int,
        input_sha256: str,
    ) -> Path:
        return self.paths.group_checkpoints / (
            f"recover_parent_relations-{node.node_id}-round-{round_index}-{input_sha256[:16]}.json"
        )

    def _load_parent_checkpoint(
        self,
        *,
        node: RegionNode,
        round_index: int,
        input_sha256: str,
        validator: Callable[[ParentSynthesisOutput], None],
    ) -> _ParentSynthesisResult | None:
        path = self._parent_checkpoint_path(node, round_index, input_sha256)
        if not path.is_file():
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
        expected = {
            "schema_version": PARENT_GROUP_CHECKPOINT_SCHEMA_VERSION,
            "stage": "recover_parent_relations",
            "source_sha256": self.compilation.source.sha256,
            "region_node_id": node.node_id,
            "round_index": round_index,
            "input_sha256": input_sha256,
        }
        if {key: payload.get(key) for key in expected} != expected:
            return None
        output = ParentSynthesisOutput.model_validate(payload["output"])
        validator(output)
        return _ParentSynthesisResult(node, output, int(payload["model_calls"]))

    def _save_parent_checkpoint(
        self,
        *,
        result: _ParentSynthesisResult,
        round_index: int,
        input_sha256: str,
    ) -> None:
        path = self._parent_checkpoint_path(result.node, round_index, input_sha256)
        path.write_text(
            json.dumps(
                {
                    "schema_version": PARENT_GROUP_CHECKPOINT_SCHEMA_VERSION,
                    "stage": "recover_parent_relations",
                    "source_sha256": self.compilation.source.sha256,
                    "region_node_id": result.node.node_id,
                    "round_index": round_index,
                    "input_sha256": input_sha256,
                    "output": result.output.model_dump(),
                    "model_calls": result.model_calls,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    def _repair_checkpoint_path(
        self,
        group: _SemanticGroup,
        round_index: int,
        input_sha256: str,
    ) -> Path:
        return self.paths.group_checkpoints / (
            f"repair_review_issues-{group.node.node_id}-round-{round_index}-"
            f"{input_sha256[:16]}.json"
        )

    def _load_repair_checkpoint(
        self,
        *,
        group: _SemanticGroup,
        round_index: int,
        input_sha256: str,
        validator: Callable[[AssertionProjectionOutput], None],
    ) -> _AssertionGroupResult | None:
        path = self._repair_checkpoint_path(group, round_index, input_sha256)
        if not path.is_file():
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
        expected = {
            "schema_version": REPAIR_GROUP_CHECKPOINT_SCHEMA_VERSION,
            "stage": "repair_review_issues",
            "source_sha256": self.compilation.source.sha256,
            "region_node_id": group.node.node_id,
            "round_index": round_index,
            "item_ids": list(group.item_ids),
            "input_sha256": input_sha256,
        }
        if {key: payload.get(key) for key in expected} != expected:
            return None
        output = AssertionProjectionOutput.model_validate(payload["output"])
        validator(output)
        return _AssertionGroupResult(group, output, int(payload["model_calls"]))

    def _save_repair_checkpoint(
        self,
        *,
        result: _AssertionGroupResult,
        round_index: int,
        input_sha256: str,
    ) -> None:
        path = self._repair_checkpoint_path(result.group, round_index, input_sha256)
        path.write_text(
            json.dumps(
                {
                    "schema_version": REPAIR_GROUP_CHECKPOINT_SCHEMA_VERSION,
                    "stage": "repair_review_issues",
                    "source_sha256": self.compilation.source.sha256,
                    "region_node_id": result.group.node.node_id,
                    "round_index": round_index,
                    "item_ids": list(result.group.item_ids),
                    "input_sha256": input_sha256,
                    "output": result.output.model_dump(),
                    "model_calls": result.model_calls,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    def _lane_review_checkpoint_path(
        self,
        lane: LaneTag,
        round_index: int,
        input_sha256: str,
    ) -> Path:
        return self.paths.group_checkpoints / (
            f"review_lane-{lane}-round-{round_index}-{input_sha256[:16]}.json"
        )

    def _load_lane_review_checkpoint(
        self,
        *,
        lane: LaneTag,
        round_index: int,
        input_sha256: str,
        validator: Callable[[LaneReviewOutput], None],
    ) -> _LaneReviewResult | None:
        path = self._lane_review_checkpoint_path(lane, round_index, input_sha256)
        if not path.is_file():
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
        expected = {
            "schema_version": LANE_REVIEW_CHECKPOINT_SCHEMA_VERSION,
            "stage": "review_lane",
            "source_sha256": self.compilation.source.sha256,
            "lane": lane,
            "round_index": round_index,
            "input_sha256": input_sha256,
        }
        if {key: payload.get(key) for key in expected} != expected:
            return None
        output = LaneReviewOutput.model_validate(payload["output"])
        validator(output)
        return _LaneReviewResult(output, int(payload["model_calls"]))

    def _save_lane_review_checkpoint(
        self,
        *,
        result: _LaneReviewResult,
        round_index: int,
        input_sha256: str,
    ) -> None:
        lane = result.output.lane
        path = self._lane_review_checkpoint_path(lane, round_index, input_sha256)
        path.write_text(
            json.dumps(
                {
                    "schema_version": LANE_REVIEW_CHECKPOINT_SCHEMA_VERSION,
                    "stage": "review_lane",
                    "source_sha256": self.compilation.source.sha256,
                    "lane": lane,
                    "round_index": round_index,
                    "input_sha256": input_sha256,
                    "output": result.output.model_dump(),
                    "model_calls": result.model_calls,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    def _checkpoint_path(self, stage: str, group: _SemanticGroup) -> Path:
        digest = hashlib.sha256("\n".join(group.item_ids).encode("utf-8")).hexdigest()[:16]
        return self.paths.group_checkpoints / (f"{stage}-{group.node.node_id}-{digest}.json")

    def _load_assertion_checkpoint(
        self,
        group: _SemanticGroup,
    ) -> _AssertionGroupResult | None:
        path = self._checkpoint_path("project_assertions", group)
        if not path.is_file():
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("schema_version") != ASSERTION_GROUP_CHECKPOINT_SCHEMA_VERSION:
            return None
        self._validate_checkpoint_identity(payload, "project_assertions", group)
        output = AssertionProjectionOutput.model_validate(payload["output"])
        self._validate_assertion_output(group, output)
        return _AssertionGroupResult(group, output, int(payload["model_calls"]))

    def _load_object_checkpoint(
        self,
        group: _SemanticGroup,
    ) -> _ObjectGroupResult | None:
        path = self._checkpoint_path("classify_objects", group)
        if not path.is_file():
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("schema_version") != OBJECT_GROUP_CHECKPOINT_SCHEMA_VERSION:
            return None
        self._validate_checkpoint_identity(payload, "classify_objects", group)
        output = ObjectRoleOutput.model_validate(payload["output"])
        self._validate_object_role_output(group, output)
        return _ObjectGroupResult(group, output, int(payload["model_calls"]))

    def _save_group_checkpoint(
        self,
        stage: str,
        result: (_AssertionGroupResult | _ObjectGroupResult),
    ) -> None:
        path = self._checkpoint_path(stage, result.group)
        path.write_text(
            json.dumps(
                {
                    "schema_version": self._group_checkpoint_schema_version(stage),
                    "stage": stage,
                    "source_sha256": self.compilation.source.sha256,
                    "region_node_id": result.group.node.node_id,
                    "item_ids": list(result.group.item_ids),
                    "output": result.output.model_dump(),
                    "model_calls": result.model_calls,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    def _validate_checkpoint_identity(
        self,
        payload: Mapping[str, object],
        stage: str,
        group: _SemanticGroup,
    ) -> None:
        expected = {
            "schema_version": self._group_checkpoint_schema_version(stage),
            "stage": stage,
            "source_sha256": self.compilation.source.sha256,
            "region_node_id": group.node.node_id,
            "item_ids": list(group.item_ids),
        }
        actual = {key: payload.get(key) for key in expected}
        if actual != expected:
            raise ValueError(f"活动视角分组检查点与当前输入不一致：{actual}")

    @staticmethod
    def _group_checkpoint_schema_version(stage: str) -> str:
        if stage == "project_assertions":
            return ASSERTION_GROUP_CHECKPOINT_SCHEMA_VERSION
        if stage == "classify_objects":
            return OBJECT_GROUP_CHECKPOINT_SCHEMA_VERSION
        raise ValueError(f"未知活动视角分组阶段：{stage}")

    def _validate_working_source(self) -> None:
        if not self.paths.working_json.is_file():
            return
        payload = json.loads(self.paths.working_json.read_text(encoding="utf-8"))
        source_sha256 = payload.get("source_sha256")
        if source_sha256 is not None and source_sha256 != self.compilation.source.sha256:
            raise ValueError("活动视角恢复目录与当前基础编译来源不一致")

    def _write_working(self, *, stage: str, **counts: int) -> None:
        self.paths.working_json.write_text(
            json.dumps(
                {
                    "stage": stage,
                    "source_sha256": self.compilation.source.sha256,
                    "source_compilation_path": str(self.source_compilation_path),
                    "perspective_schema_version": "activity-operations-perspective.v10",
                    **counts,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    @staticmethod
    def _in_source_order(values: Sequence[str], source: Sequence[str]) -> list[str]:
        selected = set(values)
        return [item for item in source if item in selected]

    @staticmethod
    def _unwrap_results(
        groups: Sequence[_SemanticGroup | RegionNode],
        outcomes: Sequence[object],
        stage: str,
    ) -> list[Any]:
        failures = [
            (
                f"{group.node.node_id if isinstance(group, _SemanticGroup) else group.node_id}："
                f"{outcome}"
            )
            for group, outcome in zip(groups, outcomes, strict=True)
            if isinstance(outcome, BaseException)
        ]
        if failures:
            raise RuntimeError(f"{stage}失败：" + "；".join(failures))
        return cast(list[Any], outcomes)


def _json_object(raw: str) -> str:
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end < start:
        raise ValueError("模型正文中不存在 JSON 对象")
    return raw[start : end + 1]


def write_activity_view_artifacts(
    paths: ActivityViewArtifactPaths,
    snapshot: ActivityPerspectiveSnapshot,
) -> None:
    paths.snapshot_json.write_text(snapshot.model_dump_json(indent=2), encoding="utf-8")
    paths.boundary_plan_json.write_text(
        snapshot.boundary_plan.model_dump_json(indent=2),
        encoding="utf-8",
    )
    paths.cards_json.write_text(
        json.dumps(
            [item.model_dump() for item in snapshot.object_cards],
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    paths.reference_reviews_json.write_text(
        json.dumps(
            [item.model_dump() for item in snapshot.reference_reviews],
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    paths.reference_amendments_json.write_text(
        json.dumps(
            [item.model_dump() for item in snapshot.reference_amendments],
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    paths.attributes_json.write_text(
        json.dumps(
            [item.model_dump() for item in snapshot.attributes],
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    paths.relations_json.write_text(
        json.dumps(
            [item.model_dump() for item in snapshot.relations],
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    paths.parent_recovery_json.write_text(
        json.dumps(
            [item.model_dump() for item in snapshot.parent_recovery_issues],
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    paths.review_rounds_json.write_text(
        json.dumps(
            [item.model_dump() for item in snapshot.review_rounds],
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    paths.omissions_json.write_text(
        json.dumps(
            {
                "object_ids": snapshot.omitted_object_ids,
                "support_reference_object_ids": (snapshot.support_reference_object_ids),
                "outside_view_object_ids": snapshot.outside_view_object_ids,
                "assertion_ids": snapshot.omitted_assertion_ids,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    paths.report_markdown.write_text(_report(snapshot), encoding="utf-8")


def _report(snapshot: ActivityPerspectiveSnapshot) -> str:
    attributes = {item.projection_id: item for item in snapshot.attributes}
    relations_by_card: dict[str, list[RelationProjection]] = defaultdict(list)
    for item in snapshot.relations:
        for participant in item.participants:
            relations_by_card[participant.card_id].append(item)
    lines = [
        "# 活动运营视角草稿",
        "",
        f"> 对象卡：{len(snapshot.object_cards)}",
        f"> 支撑引用 Object：{len(snapshot.support_reference_object_ids)}",
        f"> 视角外 Object：{len(snapshot.outside_view_object_ids)}",
        f"> 按需引用复查：{len(snapshot.reference_reviews)}",
        f"> 基础引用修订：{len(snapshot.reference_amendments)}",
        f"> 属性投影：{len(snapshot.attributes)}",
        f"> 关系投影：{len(snapshot.relations)}",
        f"> 全局复核轮次：{len(snapshot.review_rounds)}",
        f"> 父节点关系恢复未决问题：{len(snapshot.parent_recovery_issues)}",
        f"> 全局复核未决问题：{len(snapshot.unresolved_review_issues)}",
        f"> 省略 Object：{len(snapshot.omitted_object_ids)}",
        f"> 省略 Assertion：{len(snapshot.omitted_assertion_ids)}",
        "",
        "## 全局语义边界",
        "",
        snapshot.boundary_plan.perspective_definition_markdown,
        "",
        "### 纳入区域",
        "",
        *[
            f"- **{item.name}**：{item.description_markdown}"
            for item in snapshot.boundary_plan.included_areas
        ],
        "",
        "### 排除区域",
        "",
        *[
            f"- **{item.name}**：{item.description_markdown}"
            for item in snapshot.boundary_plan.excluded_areas
        ],
        "",
        "### 边界规则",
        "",
        *[f"- {item}" for item in snapshot.boundary_plan.boundary_rules],
        "",
    ]
    if snapshot.review_rounds:
        lines.extend(["## 四线路全局复核循环", ""])
        for item in snapshot.review_rounds:
            lines.append(
                f"- 第 {item.round_index} 轮：应用 {item.applied_change_count} 项；"
                f"状态变化={item.state_changed}；收敛={item.converged}；"
                f"问题重复={item.repeated_issue_signature}"
            )
        lines.append("")
    if snapshot.reference_amendments:
        lines.extend(["## 本次运行确认的基础引用修订", ""])
        for item in snapshot.reference_amendments:
            added_objects = ", ".join(f"`{value}`" for value in item.added_object_ids)
            lines.extend(
                [
                    f"- Assertion：`{item.assertion_id}`",
                    f"  - 新增 Object：{added_objects}",
                    f"  - 原模板：{item.old_statement_template_markdown}",
                    f"  - 修订模板：{item.new_statement_template_markdown}",
                ]
            )
        lines.append("")
    for card in snapshot.object_cards:
        lines.extend(
            [
                f"## {card.title_markdown}",
                "",
                f"- Object：`{card.object_id}`",
                f"- 角色：`{card.role}`",
                f"- 线路：{', '.join(card.lane_tags)}",
                f"- 来源叙述：{', '.join(f'`{value}`' for value in card.source_assertion_ids)}",
            ]
        )
        for projection_id in card.attribute_projection_ids:
            item = attributes[projection_id]
            lines.append(
                f"- 属性 `{item.semantic_kind}`：{item.rendered_statement_markdown}"
                f"｜时间：{item.source_assertion.temporal_scope.display}"
                f"｜时间依据：{item.source_assertion.temporal_basis_markdown}"
            )
        for item in relations_by_card[card.card_id]:
            participants = "、".join(
                f"`{value.role}`={value.card_id}" for value in item.participants
            )
            time_scope = (
                item.source_assertion.temporal_scope
                if item.source_assertion is not None
                else item.synthesized_temporal_scope
            )
            time_basis = (
                item.source_assertion.temporal_basis_markdown
                if item.source_assertion is not None
                else item.synthesized_temporal_basis_markdown
            )
            assert time_scope is not None and time_basis is not None
            lines.append(
                f"- 关系 `{item.relation_pattern}`（{participants}）："
                f"{item.rendered_statement_markdown}"
                f"｜时间：{time_scope.display}"
                f"｜时间依据：{time_basis}"
                f"｜形成方式：{item.derivation_kind}"
            )
        lines.append("")
    support_attributes = [
        item
        for item in snapshot.attributes
        if item.subject_object_id in set(snapshot.support_reference_object_ids)
    ]
    if support_attributes:
        lines.extend(["## 支撑引用承载的属性", ""])
        for item in support_attributes:
            lines.append(
                f"- 主体 `{item.subject_object_id}` · `{item.semantic_kind}`："
                f"{item.rendered_statement_markdown}"
                f"｜时间：{item.source_assertion.temporal_scope.display}"
                f"｜时间依据：{item.source_assertion.temporal_basis_markdown}"
            )
        lines.append("")
    if snapshot.warnings:
        lines.extend(["## 警告", ""])
        lines.extend(f"- {item}" for item in snapshot.warnings)
        lines.append("")
    return "\n".join(lines)
