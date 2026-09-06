"""全局勘探最终产物。"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict

from cold_start.region_tree.models import (
    RegionTreeSnapshot,
    RegionTreeWorkingCheckpoint,
)

GLOBAL_EXPLORATION_POLICY_VERSION = "global-exploration-policy.v1"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SourceMetadata(StrictModel):
    path: str
    title: str
    sha256: str
    parser: str
    page_count: int
    block_count: int


class GlobalExplorationSnapshot(StrictModel):
    model_config = ConfigDict(frozen=True)

    schema_version: Literal["global-exploration.v10"] = "global-exploration.v10"
    policy_version: Literal["global-exploration-policy.v1"]
    authority: Literal["preliminary-low-authority"] = "preliminary-low-authority"
    created_at: datetime
    source: SourceMetadata
    document_context_markdown: str
    context_model_calls: int
    region_tree: RegionTreeSnapshot


class GlobalExplorationWorkingCheckpoint(StrictModel):
    """勘探阶段的完整恢复边界：文档上下文与区域树必须一起版本化。"""

    schema_version: Literal["global-exploration-working.v1"] = (
        "global-exploration-working.v1"
    )
    source_sha256: str
    document_context_markdown: str
    context_model_calls: int = 0
    region_tree: RegionTreeWorkingCheckpoint
