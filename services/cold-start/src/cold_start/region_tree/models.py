"""区域树的最小结构化协议。"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, RootModel


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RegionChild(StrictModel):
    label: str = Field(min_length=1, max_length=80)
    introduction: str = Field(min_length=1, max_length=300)
    start_block_id: str = Field(pattern=r"^p\d{4}-b\d{4}$")
    end_block_id: str = Field(pattern=r"^p\d{4}-b\d{4}$")


class StopDecision(StrictModel):
    action: Literal["stop"]
    introduction: str = Field(min_length=1, max_length=300)
    reason: str = Field(min_length=1, max_length=500)


class SplitDecision(StrictModel):
    action: Literal["split"]
    introduction: str = Field(min_length=1, max_length=300)
    reason: str = Field(min_length=1, max_length=500)
    children: list[RegionChild] = Field(min_length=2, max_length=8)


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
    child_ids: list[str] = Field(default_factory=list)
    revised: bool = False


class RegionTreeSnapshot(StrictModel):
    schema_version: Literal["region-tree.v2"] = "region-tree.v2"
    status: Literal["frozen", "needs_review"]
    root_node_id: str
    nodes: list[RegionNode]
    leaf_node_ids: list[str]
    issues: list[str] = Field(default_factory=list)
    model_calls: int = 0
    tool_calls: int = 0
