"""业务视角的递归节点、观察维度与实例赋值协议。"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

BusinessNodeKind = Literal[
    "activity",
    "workflow",
    "work_step",
    "supporting_object",
]
DimensionStatus = Literal["candidate", "confirmed"]
DimensionValueKind = Literal[
    "categorical",
    "multi_categorical",
    "boolean",
    "number",
    "text",
    "object_reference",
]
DimensionAssignmentState = Literal[
    "known",
    "unknown",
    "not_applicable",
    "conflicting",
]
DimensionDerivationKind = Literal[
    "direct_source",
    "source_normalization",
    "practice_pattern",
]
DimensionValue = str | bool | int | float | list[str] | None


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class BusinessNodeSelector(StrictModel):
    """一个维度适用的结构节点范围；role_key 为空表示该类节点全部适用。"""

    node_kind: BusinessNodeKind
    role_key: str | None = Field(default=None, min_length=1, max_length=100)


class DimensionValueOption(StrictModel):
    value_key: str = Field(pattern=r"^[a-z][a-z0-9_.-]*$")
    label: str = Field(min_length=1, max_length=100)
    meaning_markdown: str = Field(min_length=1, max_length=500)


class DimensionValueSchema(StrictModel):
    """维度值的数据形状；枚举项由业务材料学习，不在程序中预先穷举。"""

    value_kind: DimensionValueKind
    options: list[DimensionValueOption] = Field(default_factory=list, max_length=100)
    unit: str | None = Field(default=None, min_length=1, max_length=50)

    @model_validator(mode="after")
    def validate_options(self) -> DimensionValueSchema:
        option_keys = [item.value_key for item in self.options]
        if len(set(option_keys)) != len(option_keys):
            raise ValueError("维度 options 的 value_key 不能重复")
        if self.value_kind in {"categorical", "multi_categorical"}:
            if not self.options:
                raise ValueError("categorical 维度必须给出当前已知 options")
        elif self.options:
            raise ValueError("只有 categorical 维度可以提供 options")
        if self.value_kind != "number" and self.unit is not None:
            raise ValueError("只有 number 维度可以提供 unit")
        return self


class BusinessDimension(StrictModel):
    """该业务视角认为一类业务节点值得长期询问和记录的观察维度。"""

    dimension_id: str = Field(pattern=r"^dimension\.[a-z][a-z0-9_.-]*$")
    status: DimensionStatus
    name: str = Field(min_length=1, max_length=100)
    question_markdown: str = Field(min_length=1, max_length=500)
    why_it_matters_markdown: str = Field(min_length=1, max_length=1_000)
    applies_to: list[BusinessNodeSelector] = Field(min_length=1, max_length=30)
    value_schema: DimensionValueSchema
    supporting_assertion_ids: list[str] = Field(default_factory=list, max_length=100)
    supporting_evidence_ids: list[str] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def validate_dimension(self) -> BusinessDimension:
        selectors = [(item.node_kind, item.role_key) for item in self.applies_to]
        if len(set(selectors)) != len(selectors):
            raise ValueError("applies_to 不能包含重复选择器")
        if len(set(self.supporting_assertion_ids)) != len(self.supporting_assertion_ids):
            raise ValueError("supporting_assertion_ids 不能重复")
        if len(set(self.supporting_evidence_ids)) != len(self.supporting_evidence_ids):
            raise ValueError("supporting_evidence_ids 不能重复")
        if self.status == "confirmed" and not self.supporting_assertion_ids:
            raise ValueError("confirmed 维度必须保留发现它的 Assertion 依据")
        return self


class PerspectiveSchema(StrictModel):
    """描述一个业务视角如何观察不同种类、不同角色的业务节点。"""

    schema_version: Literal["business-perspective-schema.v1"] = "business-perspective-schema.v1"
    perspective_key: str = Field(pattern=r"^[a-z][a-z0-9_.-]*$")
    name: str = Field(min_length=1, max_length=100)
    definition_markdown: str = Field(min_length=1, max_length=2_000)
    dimensions: list[BusinessDimension] = Field(default_factory=list, max_length=500)

    @model_validator(mode="after")
    def validate_unique_dimensions(self) -> PerspectiveSchema:
        ids = [item.dimension_id for item in self.dimensions]
        if len(set(ids)) != len(ids):
            raise ValueError("dimension_id 不能重复")
        return self


class BusinessNode(StrictModel):
    """来源 Object 在某个业务视角中的递归业务节点。"""

    node_id: str = Field(pattern=r"^business-node-\d+$")
    node_kind: BusinessNodeKind
    role_key: str | None = Field(default=None, min_length=1, max_length=100)
    label: str = Field(min_length=1, max_length=150)
    source_object_id: str
    supporting_assertion_ids: list[str] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def validate_node(self) -> BusinessNode:
        if len(set(self.supporting_assertion_ids)) != len(self.supporting_assertion_ids):
            raise ValueError("BusinessNode supporting_assertion_ids 不能重复")
        return self


class BusinessTopologyEdge(StrictModel):
    """Activity、Workflow、SubWorkflow 与 WorkStep 构成的递归业务拓扑。"""

    edge_id: str = Field(pattern=r"^business-edge-\d+$")
    relation_key: Literal["uses", "contains", "precedes", "depends_on"]
    source_node_id: str = Field(pattern=r"^business-node-\d+$")
    target_node_id: str = Field(pattern=r"^business-node-\d+$")
    supporting_assertion_ids: list[str] = Field(min_length=1, max_length=100)
    supporting_evidence_ids: list[str] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def validate_edge(self) -> BusinessTopologyEdge:
        if self.source_node_id == self.target_node_id:
            raise ValueError("业务拓扑边不能自连")
        if len(set(self.supporting_assertion_ids)) != len(self.supporting_assertion_ids):
            raise ValueError("业务拓扑边 supporting_assertion_ids 不能重复")
        if len(set(self.supporting_evidence_ids)) != len(self.supporting_evidence_ids):
            raise ValueError("业务拓扑边 supporting_evidence_ids 不能重复")
        return self


class DimensionAssignment(StrictModel):
    """一个具体业务节点在一个业务维度上的值或显式未知状态。"""

    assignment_id: str = Field(pattern=r"^dimension-assignment-\d+$")
    subject_node_id: str = Field(pattern=r"^business-node-\d+$")
    dimension_id: str = Field(pattern=r"^dimension\.[a-z][a-z0-9_.-]*$")
    state: DimensionAssignmentState
    value: DimensionValue = None
    value_display_markdown: str | None = Field(
        default=None,
        min_length=1,
        max_length=500,
    )
    derivation_kind: DimensionDerivationKind
    assertion_ids: list[str] = Field(default_factory=list, max_length=100)
    evidence_ids: list[str] = Field(default_factory=list, max_length=100)
    basis_markdown: str = Field(min_length=1, max_length=1_000)

    @model_validator(mode="after")
    def validate_assignment(self) -> DimensionAssignment:
        if self.state in {"known", "conflicting"}:
            if self.value is None or not self.assertion_ids or not self.evidence_ids:
                raise ValueError("known/conflicting 赋值必须包含值、Assertion 和 Evidence")
        elif self.value is not None or self.value_display_markdown is not None:
            raise ValueError("unknown/not_applicable 不得伪造维度值")
        if len(set(self.assertion_ids)) != len(self.assertion_ids):
            raise ValueError("DimensionAssignment assertion_ids 不能重复")
        if len(set(self.evidence_ids)) != len(self.evidence_ids):
            raise ValueError("DimensionAssignment evidence_ids 不能重复")
        return self


class BusinessPerspectiveDraft(StrictModel):
    """一个 Activity 为根、但维度可递归作用于任意业务节点的实例草稿。"""

    schema_version: Literal["business-perspective-draft.v1"] = "business-perspective-draft.v1"
    perspective_schema: PerspectiveSchema
    root_activity_node_id: str = Field(pattern=r"^business-node-\d+$")
    nodes: list[BusinessNode] = Field(min_length=1, max_length=5_000)
    topology_edges: list[BusinessTopologyEdge] = Field(
        default_factory=list,
        max_length=10_000,
    )
    dimension_assignments: list[DimensionAssignment] = Field(
        default_factory=list,
        max_length=20_000,
    )

    @model_validator(mode="after")
    def validate_draft(self) -> BusinessPerspectiveDraft:
        nodes = _unique_by("node_id", self.nodes)
        _unique_by("edge_id", self.topology_edges)
        _unique_by("assignment_id", self.dimension_assignments)
        root = nodes.get(self.root_activity_node_id)
        if root is None or root.node_kind != "activity":
            raise ValueError("root_activity_node_id 必须指向 Activity 节点")
        for edge in self.topology_edges:
            if edge.source_node_id not in nodes or edge.target_node_id not in nodes:
                raise ValueError("业务拓扑边引用了不存在的 BusinessNode")

        dimensions = {item.dimension_id: item for item in self.perspective_schema.dimensions}
        pairs: set[tuple[str, str]] = set()
        for assignment in self.dimension_assignments:
            node = nodes.get(assignment.subject_node_id)
            dimension = dimensions.get(assignment.dimension_id)
            if node is None or dimension is None:
                raise ValueError("DimensionAssignment 引用了不存在的节点或维度")
            pair = (assignment.subject_node_id, assignment.dimension_id)
            if pair in pairs:
                raise ValueError("同一节点的同一维度只能赋值一次")
            pairs.add(pair)
            if not _dimension_applies_to_node(dimension, node):
                raise ValueError("DimensionAssignment 的维度不适用于该节点种类/角色")

        required_pairs = {
            (node.node_id, dimension.dimension_id)
            for node in nodes.values()
            for dimension in dimensions.values()
            if dimension.status == "confirmed" and _dimension_applies_to_node(dimension, node)
        }
        missing = required_pairs - pairs
        if missing:
            raise ValueError(
                "confirmed 维度缺少显式赋值（known/unknown/not_applicable/conflicting）："
                + ", ".join(
                    f"{node_id}:{dimension_id}" for node_id, dimension_id in sorted(missing)
                )
            )
        return self


def _dimension_applies_to_node(
    dimension: BusinessDimension,
    node: BusinessNode,
) -> bool:
    return any(
        selector.node_kind == node.node_kind
        and (selector.role_key is None or selector.role_key == node.role_key)
        for selector in dimension.applies_to
    )


def _unique_by(attribute: str, values: list[BaseModel]) -> dict[str, BaseModel]:
    result: dict[str, BaseModel] = {}
    for item in values:
        value = getattr(item, attribute)
        if value in result:
            raise ValueError(f"{attribute} 不能重复：{value}")
        result[value] = item
    return result
