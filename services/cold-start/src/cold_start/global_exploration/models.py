"""全局勘探的受控中间产物。"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

SignalBasis = Literal[
    "heading",
    "repeated",
    "explicit_emphasis",
    "explicit_cross_reference",
]
RouteName = Literal["profile", "structure", "landscape"]


class StrictOutputModel(BaseModel):
    """拒绝模型擅自扩展字段，避免悄悄改变勘探边界。"""

    model_config = ConfigDict(extra="forbid")


class SourcedOutputModel(StrictOutputModel):
    """带有页码证据的受控输出。"""

    source_pages: list[int] = Field(default_factory=list)

    @field_validator("source_pages")
    @classmethod
    def normalize_pages(cls, pages: list[int]) -> list[int]:
        return sorted({page for page in pages if page >= 1})


class MemoryArea(SourcedOutputModel):
    """文档中承载某一粗略组织记忆方向的区域。"""

    label: str = Field(min_length=1, max_length=80)
    coverage: str = Field(min_length=1, max_length=160)


class GlobalSignal(SourcedOutputModel):
    """值得后续阅读持续留意的文档级名称或主题信号。"""

    label: str = Field(min_length=1, max_length=80)
    context: str = Field(min_length=1, max_length=160)
    basis: list[SignalBasis] = Field(min_length=1, max_length=4)

    @field_validator("basis")
    @classmethod
    def normalize_basis(cls, values: list[SignalBasis]) -> list[SignalBasis]:
        return list(dict.fromkeys(values))


class ExplicitDocumentRelation(SourcedOutputModel):
    """原文明示的章节承接、包含或交叉引用关系。"""

    source_area: str = Field(min_length=1, max_length=80)
    target_area: str = Field(min_length=1, max_length=80)
    observation: str = Field(min_length=1, max_length=180)


class LandscapeObservationBatch(StrictOutputModel):
    """一个阅读单元新增的粗略记忆地形观察。"""

    unit_pages: list[int] = Field(min_length=1)
    memory_areas: list[MemoryArea] = Field(default_factory=list, max_length=6)
    global_signals: list[GlobalSignal] = Field(default_factory=list, max_length=8)
    explicit_relations: list[ExplicitDocumentRelation] = Field(
        default_factory=list,
        max_length=4,
    )

    @field_validator("unit_pages")
    @classmethod
    def normalize_unit_pages(cls, pages: list[int]) -> list[int]:
        return sorted({page for page in pages if page >= 1})


class DocumentMemoryLandscape(StrictOutputModel):
    """只用于后续定位阅读区域的文档级记忆地形。"""

    scope_note: str = Field(min_length=1, max_length=320)
    memory_areas: list[MemoryArea] = Field(default_factory=list, max_length=20)
    global_signals: list[GlobalSignal] = Field(default_factory=list, max_length=24)
    explicit_relations: list[ExplicitDocumentRelation] = Field(
        default_factory=list,
        max_length=12,
    )


class ReviewIssue(StrictOutputModel):
    """全局勘探边界校验发现的可修复问题。"""

    severity: Literal["low", "medium", "high"]
    routes: list[RouteName] = Field(min_length=1)
    description: str = Field(min_length=1, max_length=240)
    evidence_pages: list[int] = Field(default_factory=list)
    revision_instruction: str = Field(min_length=1, max_length=240)

    @field_validator("evidence_pages")
    @classmethod
    def normalize_pages(cls, pages: list[int]) -> list[int]:
        return sorted({page for page in pages if page >= 1})

    @field_validator("routes")
    @classmethod
    def normalize_routes(cls, routes: list[RouteName]) -> list[RouteName]:
        return list(dict.fromkeys(routes))


class ExplorationBoundaryReview(StrictOutputModel):
    """三份产物能否作为低权威全局阅读地图冻结。"""

    acceptable_as_global_exploration: bool
    overall_assessment: str = Field(min_length=1, max_length=500)
    issues: list[ReviewIssue] = Field(default_factory=list, max_length=10)
    non_blocking_notes: list[str] = Field(default_factory=list, max_length=10)


class RouteStatistics(StrictOutputModel):
    """用于审计阅读覆盖范围，不表达知识结论。"""

    profile_units: int
    structure_scans: int
    landscape_units: int
    landscape_merge_calls: int
    review_rounds: int


class SourceMetadata(StrictOutputModel):
    """输入 PDF 的稳定来源信息。"""

    path: str
    title: str
    sha256: str
    parser: str
    page_count: int


class GlobalExplorationSnapshot(StrictOutputModel):
    """冻结后的低权威文档级阅读地图。"""

    model_config = ConfigDict(frozen=True)

    schema_version: Literal["global-exploration.v3"] = "global-exploration.v3"
    authority: Literal["preliminary-low-authority"] = "preliminary-low-authority"
    created_at: datetime
    source: SourceMetadata
    document_profile_markdown: str
    document_structure_markdown: str
    document_memory_landscape: DocumentMemoryLandscape
    review_history: list[ExplorationBoundaryReview]
    frozen_with_boundary_issues: bool
    route_statistics: RouteStatistics
    landscape_observations: tuple[LandscapeObservationBatch, ...] = Field(
        default_factory=tuple,
        exclude=True,
    )
