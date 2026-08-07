"""区域树的结构化协议。"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, RootModel


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


BlockId = Annotated[str, Field(pattern=r"^p\d{4}-b\d{4}$")]


class SourceSegment(StrictModel):
    start_block_id: BlockId
    end_block_id: BlockId


class RegionChild(StrictModel):
    label: str = Field(min_length=1, max_length=80)
    introduction: str = Field(min_length=1, max_length=300)
    start_block_id: BlockId
    end_block_id: BlockId


SourceRole = Literal["content_source", "structural_context"]


class SourceIssue(StrictModel):
    block_ids: list[BlockId] = Field(min_length=1)
    reason: str = Field(min_length=1, max_length=500)


class DecisionWithSourceIssues(StrictModel):
    source_issues: list[SourceIssue] = Field(default_factory=list)


class StopDecision(DecisionWithSourceIssues):
    action: Literal["stop"]
    owned_source_role: SourceRole
    introduction: str = Field(min_length=1, max_length=300)
    reason: str = Field(min_length=1, max_length=500)


class SplitDecision(DecisionWithSourceIssues):
    action: Literal["split"]
    owned_source_role: SourceRole | None
    introduction: str = Field(min_length=1, max_length=300)
    reason: str = Field(min_length=1, max_length=500)
    children: list[RegionChild] = Field(min_length=1, max_length=8)


class ParentPartitionError(StrictModel):
    action: Literal["parent_partition_error"]
    problem_kind: Literal["boundary_cut", "missing_intermediate_region"]
    related_node_ids: list[str] = Field(min_length=1, max_length=8)
    reason: str = Field(min_length=1, max_length=500)


RegionDecision = Annotated[
    StopDecision | SplitDecision | ParentPartitionError,
    Field(discriminator="action"),
]


class RegionDecisionOutput(RootModel[RegionDecision]):
    pass


class KeepDecision(DecisionWithSourceIssues):
    action: Literal["keep"]
    reason: str = Field(min_length=1, max_length=500)


RepairDecision = Annotated[
    KeepDecision | StopDecision | SplitDecision,
    Field(discriminator="action"),
]


class RepairDecisionOutput(RootModel[RepairDecision]):
    pass


class StructureIssue(StrictModel):
    kind: Literal["heading_hierarchy"]
    target_node_id: str = Field(pattern=r"^region-\d{4,}$")
    block_ids: list[BlockId]
    reason: str = Field(min_length=1, max_length=500)


class StructureCheckReport(StrictModel):
    initial_issues: list[StructureIssue] = Field(default_factory=list)
    remaining_issues: list[StructureIssue] = Field(default_factory=list)


class RegionNode(StrictModel):
    node_id: str
    parent_id: str | None
    depth: int
    label: str
    introduction: str
    start_block_id: str
    end_block_id: str
    source_pages: list[int]
    status: Literal["pending", "branch", "leaf", "failed", "needs_review"]
    owned_segments: list[SourceSegment] = Field(default_factory=list)
    owned_source_role: SourceRole | None = None
    decision_reason: str = ""
    child_ids: list[str] = Field(default_factory=list)
    revised: bool = False


class RegionTreeSnapshot(StrictModel):
    schema_version: Literal["region-tree.v5"] = "region-tree.v5"
    status: Literal["frozen", "needs_review"]
    root_node_id: str
    nodes: list[RegionNode]
    leaf_node_ids: list[str]
    content_node_ids: list[str]
    structural_context_node_ids: list[str]
    structure_check: StructureCheckReport = Field(
        default_factory=StructureCheckReport
    )
    source_issues: list[SourceIssue] = Field(default_factory=list)
    issues: list[str] = Field(default_factory=list)
    model_calls: int = 0
    tool_calls: int = 0
