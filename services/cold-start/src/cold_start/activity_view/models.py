"""活动运营视角中的对象卡与 Assertion 投影。"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from cold_start.compilation.models import Assertion, TemporalScope, assertion_object_ids
from cold_start.global_exploration.models import SourceMetadata

LaneTag = Literal[
    "activity_flow",
    "guidance",
    "staffing",
    "organization_context",
]
ObjectCardRole = Literal[
    "organization",
    "activity",
    "activity_trait",
    "workflow",
    "work_step",
    "person",
    "role",
    "period",
    "system",
    "funding_scheme",
    "communication_channel",
    "standard",
    "document",
    "venue",
    "resource",
]
AssertionSemanticKind = Literal[
    "fact",
    "rule",
    "principle",
    "practice",
    "insight",
]
RelationPattern = Literal[
    "classification",
    "workflow_use",
    "composition",
    "sequence",
    "dependency",
    "guidance_application",
    "role_holding",
    "responsibility",
    "participation",
    "contextualization",
]
RelationParticipantRole = Literal[
    "subject",
    "category",
    "workflow_user",
    "workflow",
    "whole",
    "part",
    "previous",
    "next",
    "dependent",
    "dependency",
    "anchor",
    "scope",
    "person",
    "role",
    "responsible_party",
    "responsibility_target",
    "participant",
    "participation_target",
    "context",
    "contextualized_object",
]
DerivationKind = Literal[
    "direct_source",
    "perspective_interpretation",
    "parent_recovery",
]
ParentProofKind = Literal[
    "direct_statement",
    "structural_recovery",
    "necessary_normalization",
]
IntendedProjection = Literal["attribute", "relation"]
ObjectPerspectiveStatus = Literal[
    "view_card",
    "support_reference",
    "outside_view",
]
ReviewAction = Literal["add_lane", "remove_lane", "reproject"]
ReviewTargetKind = Literal["assertion"]
ParentCandidateAdmissionStatus = Literal["accept", "reject", "unresolved"]

RELATION_PATTERN_LANE: dict[str, LaneTag] = {
    "classification": "activity_flow",
    "workflow_use": "activity_flow",
    "composition": "activity_flow",
    "sequence": "activity_flow",
    "dependency": "activity_flow",
    "guidance_application": "guidance",
    "role_holding": "staffing",
    "responsibility": "staffing",
    "participation": "staffing",
    "contextualization": "organization_context",
}


def validate_participant_shape(
    relation_pattern: RelationPattern,
    participants: list[RelationParticipantDecision],
) -> None:
    """校验关系参与者槽位；Object 业务角色由运行时继续校验。"""

    counts: dict[str, int] = {}
    for item in participants:
        counts[item.role] = counts.get(item.role, 0) + 1
    exact: dict[str, dict[str, int]] = {
        "classification": {"subject": 1, "category": 1},
        "workflow_use": {"workflow_user": 1, "workflow": 1},
        "sequence": {"previous": 1, "next": 1},
        "dependency": {"dependent": 1, "dependency": 1},
        "guidance_application": {"anchor": 1, "scope": 1},
        "role_holding": {"person": 1, "role": 1},
        "responsibility": {"responsible_party": 1, "responsibility_target": 1},
        "contextualization": {"context": 1, "contextualized_object": 1},
    }
    if relation_pattern in exact and counts != exact[relation_pattern]:
        raise ValueError(f"{relation_pattern} 的参与者槽位必须是 {exact[relation_pattern]}")
    if relation_pattern == "composition" and not (
        counts.get("whole") == 1 and counts.get("part", 0) >= 1 and set(counts) == {"whole", "part"}
    ):
        raise ValueError("composition 必须包含一个 whole 和至少一个 part")
    if relation_pattern == "participation" and not (
        counts.get("participation_target") == 1
        and counts.get("participant", 0) >= 1
        and set(counts) == {"participant", "participation_target"}
    ):
        raise ValueError("participation 必须包含至少一个 participant 和一个 participation_target")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PerspectiveSemanticArea(StrictModel):
    """全局边界规划中的一个语义区域。"""

    name: str = Field(min_length=1, max_length=100)
    description_markdown: str = Field(min_length=1, max_length=1_000)


class PerspectiveBoundaryPlan(StrictModel):
    """面向后续局部判断的全局活动运营视角边界。"""

    perspective_definition_markdown: str = Field(min_length=1, max_length=2_000)
    included_areas: list[PerspectiveSemanticArea] = Field(
        min_length=1,
        max_length=20,
    )
    excluded_areas: list[PerspectiveSemanticArea] = Field(
        default_factory=list,
        max_length=20,
    )
    boundary_rules: list[str] = Field(min_length=1, max_length=30)


class ObjectCardDecision(StrictModel):
    """AI 判断 Object 在活动运营视角中的存在方式与业务角色。"""

    object_id: str = Field(min_length=1)
    status: ObjectPerspectiveStatus
    role: ObjectCardRole | None = None
    reason: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_role(self) -> ObjectCardDecision:
        if self.status == "view_card":
            if self.role is None:
                raise ValueError("view_card 必须提供 role")
        elif self.role is not None:
            raise ValueError("非 view_card 不得提供 role")
        return self


class ObjectRoleOutput(StrictModel):
    decisions: list[ObjectCardDecision] = Field(default_factory=list, max_length=500)

    @model_validator(mode="after")
    def validate_unique_objects(self) -> ObjectRoleOutput:
        ids = [item.object_id for item in self.decisions]
        if len(set(ids)) != len(ids):
            raise ValueError("同一个 Object 只能有一项视角边界决定")
        return self


class AttributeDecision(StrictModel):
    """一条非联系性 Assertion 在业务视角中的主体投影。"""

    assertion_id: str = Field(min_length=1)
    object_id: str = Field(min_length=1)
    semantic_kind: AssertionSemanticKind
    lane_tags: list[LaneTag] = Field(min_length=1, max_length=4)
    reason: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_tags(self) -> AttributeDecision:
        if len(set(self.lane_tags)) != len(self.lane_tags):
            raise ValueError("lane_tags 不能重复")
        return self


class RelationParticipantDecision(StrictModel):
    object_id: str = Field(min_length=1)
    role: RelationParticipantRole


class RelationDecision(StrictModel):
    """一条联系性 Assertion 在四条业务线路中的关系投影。"""

    assertion_id: str = Field(min_length=1)
    relation_pattern: RelationPattern
    participants: list[RelationParticipantDecision] = Field(
        min_length=2,
        max_length=10,
    )
    semantic_kind: AssertionSemanticKind
    lane_tags: list[LaneTag] = Field(min_length=1, max_length=4)
    derivation_kind: DerivationKind
    reason: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_relation(self) -> RelationDecision:
        object_ids = [item.object_id for item in self.participants]
        if len(set(object_ids)) != len(object_ids):
            raise ValueError("同一个 Object 不能在一条关系中重复出现")
        if len(set(self.lane_tags)) != len(self.lane_tags):
            raise ValueError("lane_tags 不能重复")
        required_lane = RELATION_PATTERN_LANE[self.relation_pattern]
        if required_lane not in self.lane_tags:
            raise ValueError(f"{self.relation_pattern} 必须属于 {required_lane} 线路")
        if self.derivation_kind == "parent_recovery":
            raise ValueError("局部 Assertion 投影不能使用 parent_recovery")
        validate_participant_shape(self.relation_pattern, self.participants)
        return self


class ReferenceReviewRequest(StrictModel):
    """业务投影发现基础 Assertion 可能漏标已有 Object。"""

    assertion_id: str = Field(min_length=1)
    candidate_object_ids: list[str] = Field(min_length=1, max_length=10)
    intended_projection: IntendedProjection
    reason: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_candidates(self) -> ReferenceReviewRequest:
        if len(set(self.candidate_object_ids)) != len(self.candidate_object_ids):
            raise ValueError("candidate_object_ids 不能重复")
        return self


class ReferenceReviewDecision(StrictModel):
    """独立复查对一项引用补全请求的判断。"""

    assertion_id: str = Field(min_length=1)
    confirmed_object_ids: list[str] = Field(default_factory=list, max_length=10)
    rejected_object_ids: list[str] = Field(default_factory=list, max_length=10)
    ambiguous_object_ids: list[str] = Field(default_factory=list, max_length=10)
    revised_statement_template_markdown: str | None = Field(
        default=None,
        min_length=1,
        max_length=3_000,
    )
    reason: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_partitions(self) -> ReferenceReviewDecision:
        groups = (
            self.confirmed_object_ids,
            self.rejected_object_ids,
            self.ambiguous_object_ids,
        )
        if any(len(set(values)) != len(values) for values in groups):
            raise ValueError("引用复查结果中的 Object ID 不能重复")
        if any(set(left) & set(right) for left in groups for right in groups if left is not right):
            raise ValueError("同一 Object 只能有一种引用复查结果")
        if bool(self.confirmed_object_ids) != bool(self.revised_statement_template_markdown):
            raise ValueError("确认补全时必须提交修订模板，否则修订模板必须为 null")
        return self


class AssertionProjectionOutput(StrictModel):
    attributes: list[AttributeDecision] = Field(default_factory=list, max_length=500)
    relations: list[RelationDecision] = Field(default_factory=list, max_length=500)
    reference_review_requests: list[ReferenceReviewRequest] = Field(
        default_factory=list,
        max_length=500,
    )
    omitted_assertion_ids: list[str] = Field(default_factory=list, max_length=500)

    @model_validator(mode="after")
    def validate_unique_assertions(self) -> AssertionProjectionOutput:
        attribute_ids = [item.assertion_id for item in self.attributes]
        relation_ids = [item.assertion_id for item in self.relations]
        review_ids = [item.assertion_id for item in self.reference_review_requests]
        omitted_ids = self.omitted_assertion_ids
        for name, values in (
            ("attributes", attribute_ids),
            ("relations", relation_ids),
            ("reference_review_requests", review_ids),
            ("omitted_assertion_ids", omitted_ids),
        ):
            if len(set(values)) != len(values):
                raise ValueError(f"{name} 不能重复使用同一 Assertion")
        groups = [set(attribute_ids), set(relation_ids), set(review_ids), set(omitted_ids)]
        if any(
            groups[left] & groups[right]
            for left in range(len(groups))
            for right in range(left + 1, len(groups))
        ):
            raise ValueError("一条 Assertion 只能选择属性、关系、引用复查或省略之一")
        return self


class ParentRelationDecision(StrictModel):
    """父节点从来源中恢复出的跨孩子业务关系候选。"""

    relation_pattern: RelationPattern
    participants: list[RelationParticipantDecision] = Field(
        min_length=2,
        max_length=10,
    )
    semantic_kind: AssertionSemanticKind
    lane_tags: list[LaneTag] = Field(min_length=1, max_length=4)
    proof_kind: ParentProofKind
    supporting_assertion_ids: list[str] = Field(min_length=1, max_length=30)
    proof_evidence_ids: list[str] = Field(min_length=1, max_length=30)
    supporting_child_node_ids: list[str] = Field(min_length=2, max_length=10)
    temporal_scope: TemporalScope
    temporal_basis_markdown: str = Field(min_length=1, max_length=500)
    reason: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_relation(self) -> ParentRelationDecision:
        object_ids = [item.object_id for item in self.participants]
        if len(set(object_ids)) != len(object_ids):
            raise ValueError("同一个 Object 不能在一条父级关系中重复出现")
        if len(set(self.lane_tags)) != len(self.lane_tags):
            raise ValueError("lane_tags 不能重复")
        required_lane = RELATION_PATTERN_LANE[self.relation_pattern]
        if required_lane not in self.lane_tags:
            raise ValueError(f"{self.relation_pattern} 必须属于 {required_lane} 线路")
        if len(set(self.supporting_assertion_ids)) != len(self.supporting_assertion_ids):
            raise ValueError("supporting_assertion_ids 不能重复")
        if len(set(self.proof_evidence_ids)) != len(self.proof_evidence_ids):
            raise ValueError("proof_evidence_ids 不能重复")
        if len(set(self.supporting_child_node_ids)) != len(self.supporting_child_node_ids):
            raise ValueError("supporting_child_node_ids 不能重复")
        validate_participant_shape(self.relation_pattern, self.participants)
        return self


class ParentSynthesisIssue(StrictModel):
    issue_key: str = Field(min_length=1, max_length=200)
    kind: Literal[
        "missing_connection",
        "boundary_conflict",
        "source_conflict",
        "insufficient_support",
        "synthesis_failure",
    ]
    affected_object_ids: list[str] = Field(default_factory=list, max_length=30)
    affected_assertion_ids: list[str] = Field(default_factory=list, max_length=30)
    reason: str = Field(min_length=1, max_length=1_000)


class ParentSynthesisOutput(StrictModel):
    relations: list[ParentRelationDecision] = Field(default_factory=list, max_length=100)
    issues: list[ParentSynthesisIssue] = Field(default_factory=list, max_length=100)


class ParentCandidateAdmission(StrictModel):
    """对应业务线路对父级恢复候选作出的显式准入决定。"""

    candidate_id: str = Field(min_length=1)
    status: ParentCandidateAdmissionStatus
    reason: str = Field(min_length=1, max_length=800)


class LaneReviewChange(StrictModel):
    """一条全局线路审查对当前草稿提出的最小定向变更。"""

    target_kind: ReviewTargetKind
    target_id: str = Field(min_length=1)
    action: ReviewAction
    reason: str = Field(min_length=1, max_length=800)


class LaneReviewIssue(StrictModel):
    issue_key: str = Field(min_length=1, max_length=200)
    affected_object_ids: list[str] = Field(default_factory=list, max_length=50)
    affected_assertion_ids: list[str] = Field(default_factory=list, max_length=50)
    reason: str = Field(min_length=1, max_length=1_000)


class LaneReviewOutput(StrictModel):
    lane: LaneTag
    parent_candidate_admissions: list[ParentCandidateAdmission] = Field(
        default_factory=list,
        max_length=500,
    )
    changes: list[LaneReviewChange] = Field(default_factory=list, max_length=500)
    unresolved_issues: list[LaneReviewIssue] = Field(
        default_factory=list,
        max_length=200,
    )

    @model_validator(mode="after")
    def validate_unique_changes(self) -> LaneReviewOutput:
        candidate_ids = [item.candidate_id for item in self.parent_candidate_admissions]
        if len(set(candidate_ids)) != len(candidate_ids):
            raise ValueError("同一父级关系候选只能有一项准入决定")
        keys = [(item.target_kind, item.target_id) for item in self.changes]
        if len(set(keys)) != len(keys):
            raise ValueError("同一线路不能对同一目标提交多项变更")
        return self


class PerspectiveReviewRound(StrictModel):
    round_index: int = Field(ge=1)
    lane_reviews: list[LaneReviewOutput] = Field(min_length=4, max_length=4)
    applied_change_count: int = Field(ge=0)
    state_changed: bool
    converged: bool
    repeated_issue_signature: bool
    model_calls: int = Field(ge=0)


class ObjectCard(StrictModel):
    """活动运营视角中由一个基础 Object 形成的唯一卡片。"""

    card_id: str = Field(min_length=1)
    object_id: str = Field(min_length=1)
    role: ObjectCardRole
    title_markdown: str = Field(min_length=1, max_length=300)
    aliases: list[str] = Field(default_factory=list, max_length=100)
    lane_tags: list[LaneTag] = Field(min_length=1, max_length=4)
    source_assertion_ids: list[str] = Field(default_factory=list, max_length=5_000)
    attribute_projection_ids: list[str] = Field(default_factory=list, max_length=500)


class AttributeProjection(StrictModel):
    projection_id: str = Field(min_length=1)
    subject_object_id: str = Field(min_length=1)
    semantic_kind: AssertionSemanticKind
    lane_tags: list[LaneTag] = Field(min_length=1, max_length=4)
    source_assertion: Assertion
    rendered_statement_markdown: str = Field(min_length=1, max_length=5_000)
    reason: str = Field(min_length=1, max_length=500)


class RelationParticipantProjection(StrictModel):
    card_id: str = Field(min_length=1)
    role: RelationParticipantRole


class RelationProjection(StrictModel):
    projection_id: str = Field(min_length=1)
    relation_pattern: RelationPattern
    participants: list[RelationParticipantProjection] = Field(
        min_length=2,
        max_length=10,
    )
    semantic_kind: AssertionSemanticKind
    lane_tags: list[LaneTag] = Field(min_length=1, max_length=4)
    derivation_kind: DerivationKind
    source_assertion: Assertion | None = None
    supporting_assertions: list[Assertion] = Field(default_factory=list, max_length=30)
    source_region_node_ids: list[str] = Field(default_factory=list, max_length=20)
    parent_proof_kind: ParentProofKind | None = None
    proof_evidence_ids: list[str] = Field(default_factory=list, max_length=30)
    synthesized_temporal_scope: TemporalScope | None = None
    synthesized_temporal_basis_markdown: str | None = Field(
        default=None,
        min_length=1,
        max_length=500,
    )
    rendered_statement_markdown: str = Field(min_length=1, max_length=5_000)
    reason: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_sources(self) -> RelationProjection:
        if self.derivation_kind == "parent_recovery":
            if not self.supporting_assertions or not self.source_region_node_ids:
                raise ValueError("父节点恢复关系必须保留支撑 Assertion 和区域节点")
            if self.parent_proof_kind is None or not self.proof_evidence_ids:
                raise ValueError("父节点恢复关系必须保留证明类型和 Evidence")
            if (
                self.synthesized_temporal_scope is None
                or self.synthesized_temporal_basis_markdown is None
            ):
                raise ValueError("父节点恢复关系必须说明时间范围和时间依据")
        elif self.source_assertion is None:
            raise ValueError("直接关系投影必须保留 source_assertion")
        elif (
            self.synthesized_temporal_scope is not None
            or self.synthesized_temporal_basis_markdown is not None
            or self.parent_proof_kind is not None
            or self.proof_evidence_ids
        ):
            raise ValueError("直接关系不得携带父级恢复证明")
        return self


class AssertionReferenceAmendment(StrictModel):
    """业务视角触发并经 Evidence 复查确认的基础 Assertion 引用修订。"""

    assertion_id: str = Field(min_length=1)
    added_object_ids: list[str] = Field(min_length=1, max_length=10)
    old_statement_template_markdown: str = Field(min_length=1, max_length=3_000)
    new_statement_template_markdown: str = Field(min_length=1, max_length=3_000)
    triggered_by_perspective: Literal["activity_operations"] = "activity_operations"
    reason: str = Field(min_length=1, max_length=500)


class PerspectiveGroupResult(StrictModel):
    stage: Literal[
        "plan_boundary",
        "project_assertions",
        "classify_objects",
        "recover_parent_relations",
        "review_lanes",
        "repair_review_issues",
    ]
    region_node_id: str
    item_ids: list[str]
    included_count: int = Field(ge=0)
    omitted_count: int = Field(ge=0)
    model_calls: int = Field(ge=1)


class ActivityPerspectiveSnapshot(StrictModel):
    """对象卡与 Assertion 投影组成的活动运营视角草稿。"""

    schema_version: Literal["activity-operations-perspective.v10"] = (
        "activity-operations-perspective.v10"
    )
    created_at: datetime
    status: Literal["draft"] = "draft"
    perspective_key: Literal["activity_operations"] = "activity_operations"
    source: SourceMetadata
    source_compilation_path: str
    source_compilation_schema_version: str
    region_tree_schema_version: str
    boundary_plan: PerspectiveBoundaryPlan
    review_rounds: list[PerspectiveReviewRound]
    parent_recovery_issues: list[ParentSynthesisIssue]
    unresolved_review_issues: list[LaneReviewIssue]
    object_cards: list[ObjectCard]
    reference_reviews: list[ReferenceReviewDecision]
    reference_amendments: list[AssertionReferenceAmendment]
    attributes: list[AttributeProjection]
    relations: list[RelationProjection]
    support_reference_object_ids: list[str]
    outside_view_object_ids: list[str]
    omitted_object_ids: list[str]
    omitted_assertion_ids: list[str]
    group_results: list[PerspectiveGroupResult]
    model_calls: int = Field(ge=0)
    warnings: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_snapshot(self) -> ActivityPerspectiveSnapshot:
        card_ids = {item.card_id for item in self.object_cards}
        if len(card_ids) != len(self.object_cards):
            raise ValueError("card_id 不能重复")
        card_object_ids = {item.object_id for item in self.object_cards}
        support_ids = set(self.support_reference_object_ids)
        outside_ids = set(self.outside_view_object_ids)
        omitted_ids = set(self.omitted_object_ids)
        if support_ids & outside_ids:
            raise ValueError("support_reference 与 outside_view 不能重叠")
        if card_object_ids & omitted_ids:
            raise ValueError("视角卡 Object 不能同时被省略")
        if support_ids | outside_ids != omitted_ids:
            raise ValueError("省略 Object 必须完整分为 support_reference 和 outside_view")
        attribute_ids = {item.projection_id for item in self.attributes}
        if len(attribute_ids) != len(self.attributes):
            raise ValueError("属性 projection_id 不能重复")
        relation_ids = {item.projection_id for item in self.relations}
        if len(relation_ids) != len(self.relations):
            raise ValueError("关系 projection_id 不能重复")
        for item in self.attributes:
            if item.subject_object_id not in card_object_ids | support_ids:
                raise ValueError(
                    f"{item.projection_id} 的主体必须是 view_card 或 support_reference"
                )
            if item.subject_object_id not in assertion_object_ids(item.source_assertion):
                raise ValueError(f"{item.projection_id} 的主体未被来源 Assertion 引用")
        for item in self.relations:
            endpoints = {value.card_id for value in item.participants}
            if not endpoints <= card_ids:
                raise ValueError(f"{item.projection_id} 引用了不存在的对象卡")
        source_assertions = {
            item.source_assertion.assertion_id: item.source_assertion for item in self.attributes
        }
        for relation in self.relations:
            if relation.source_assertion is not None:
                source_assertions[relation.source_assertion.assertion_id] = (
                    relation.source_assertion
                )
            source_assertions.update(
                {item.assertion_id: item for item in relation.supporting_assertions}
            )
        for card in self.object_cards:
            if not card.source_assertion_ids:
                raise ValueError(f"{card.card_id} 没有来源 Assertion")
            unknown = set(card.source_assertion_ids) - set(source_assertions)
            if unknown:
                raise ValueError(f"{card.card_id} 引用了未投影的 Assertion：{sorted(unknown)}")
            if any(
                card.object_id not in assertion_object_ids(source_assertions[assertion_id])
                for assertion_id in card.source_assertion_ids
            ):
                raise ValueError(f"{card.card_id} 与来源 Assertion 的 Object 引用不一致")
        return self


def object_card_id(object_id: str) -> str:
    return f"object:{object_id}"
