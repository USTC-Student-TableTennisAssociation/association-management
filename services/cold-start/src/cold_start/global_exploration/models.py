"""全局勘探最终产物。"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict

from cold_start.region_tree.models import RegionTreeSnapshot


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

    schema_version: Literal["global-exploration.v9"] = "global-exploration.v9"
    authority: Literal["preliminary-low-authority"] = "preliminary-low-authority"
    created_at: datetime
    source: SourceMetadata
    document_context_markdown: str
    context_model_calls: int
    region_tree: RegionTreeSnapshot
