from __future__ import annotations

import pytest
from pydantic import ValidationError

from cold_start.activity_view import (
    BusinessDimension,
    BusinessNode,
    BusinessNodeSelector,
    BusinessPerspectiveDraft,
    BusinessTopologyEdge,
    DimensionAssignment,
    DimensionValueOption,
    DimensionValueSchema,
    PerspectiveSchema,
)


def _schema() -> PerspectiveSchema:
    return PerspectiveSchema(
        perspective_key="activity_operations",
        name="活动运营",
        definition_markdown="从活动到递归工作流观察可复用实践。",
        dimensions=[
            BusinessDimension(
                dimension_id="dimension.activity.scale",
                status="confirmed",
                name="活动规模",
                question_markdown="这项活动在运营上属于什么规模？",
                why_it_matters_markdown="规模会改变场地、人员和行政准备。",
                applies_to=[BusinessNodeSelector(node_kind="activity")],
                value_schema=DimensionValueSchema(
                    value_kind="categorical",
                    options=[
                        DimensionValueOption(
                            value_key="large",
                            label="大型",
                            meaning_markdown="需要大型赛事级别的准备。",
                        )
                    ],
                ),
                supporting_assertion_ids=["region-1/assert-1"],
                supporting_evidence_ids=["region-1/evidence-1"],
            ),
            BusinessDimension(
                dimension_id="dimension.registration.subject",
                status="confirmed",
                name="报名主体",
                question_markdown="报名以个人还是组合为单位？",
                why_it_matters_markdown="它会改变报名表结构和后续匹配步骤。",
                applies_to=[
                    BusinessNodeSelector(
                        node_kind="workflow",
                        role_key="registration",
                    )
                ],
                value_schema=DimensionValueSchema(
                    value_kind="categorical",
                    options=[
                        DimensionValueOption(
                            value_key="individual",
                            label="个人",
                            meaning_markdown="每名参与者独立报名。",
                        ),
                        DimensionValueOption(
                            value_key="pair",
                            label="双人组合",
                            meaning_markdown="以两人组合为报名单位。",
                        ),
                    ],
                ),
                supporting_assertion_ids=["region-2/assert-1"],
                supporting_evidence_ids=["region-2/evidence-1"],
            ),
        ],
    )


def _draft(assignments: list[DimensionAssignment]) -> BusinessPerspectiveDraft:
    return BusinessPerspectiveDraft(
        perspective_schema=_schema(),
        root_activity_node_id="business-node-1",
        nodes=[
            BusinessNode(
                node_id="business-node-1",
                node_kind="activity",
                label="继往开来杯",
                source_object_id="region-1/obj-1",
            ),
            BusinessNode(
                node_id="business-node-2",
                node_kind="workflow",
                role_key="registration",
                label="报名",
                source_object_id="region-2/obj-1",
            ),
            BusinessNode(
                node_id="business-node-3",
                node_kind="work_step",
                role_key="partner_matching",
                label="搭档匹配",
                source_object_id="region-2/obj-2",
            ),
        ],
        topology_edges=[
            BusinessTopologyEdge(
                edge_id="business-edge-1",
                relation_key="uses",
                source_node_id="business-node-1",
                target_node_id="business-node-2",
                supporting_assertion_ids=["region-2/assert-1"],
                supporting_evidence_ids=["region-2/evidence-1"],
            ),
            BusinessTopologyEdge(
                edge_id="business-edge-2",
                relation_key="contains",
                source_node_id="business-node-2",
                target_node_id="business-node-3",
                supporting_assertion_ids=["region-2/assert-2"],
                supporting_evidence_ids=["region-2/evidence-2"],
            ),
        ],
        dimension_assignments=assignments,
    )


def test_dimensions_apply_to_activity_and_nested_workflow_with_one_protocol() -> None:
    draft = _draft(
        [
            DimensionAssignment(
                assignment_id="dimension-assignment-1",
                subject_node_id="business-node-1",
                dimension_id="dimension.activity.scale",
                state="known",
                value="large",
                value_display_markdown="大型",
                derivation_kind="direct_source",
                assertion_ids=["region-1/assert-1"],
                evidence_ids=["region-1/evidence-1"],
                basis_markdown="原文将继往开来杯列为大型赛事。",
            ),
            DimensionAssignment(
                assignment_id="dimension-assignment-2",
                subject_node_id="business-node-2",
                dimension_id="dimension.registration.subject",
                state="known",
                value="individual",
                value_display_markdown="个人",
                derivation_kind="direct_source",
                assertion_ids=["region-2/assert-1"],
                evidence_ids=["region-2/evidence-1"],
                basis_markdown="原文说明报名由个人提交。",
            ),
        ]
    )

    assert draft.dimension_assignments[1].subject_node_id == "business-node-2"
    assert draft.nodes[2].role_key == "partner_matching"


def test_confirmed_dimension_requires_explicit_unknown_instead_of_silent_omission() -> None:
    with pytest.raises(ValidationError, match="confirmed 维度缺少显式赋值"):
        _draft(
            [
                DimensionAssignment(
                    assignment_id="dimension-assignment-1",
                    subject_node_id="business-node-1",
                    dimension_id="dimension.activity.scale",
                    state="known",
                    value="large",
                    value_display_markdown="大型",
                    derivation_kind="direct_source",
                    assertion_ids=["region-1/assert-1"],
                    evidence_ids=["region-1/evidence-1"],
                    basis_markdown="原文将继往开来杯列为大型赛事。",
                )
            ]
        )
