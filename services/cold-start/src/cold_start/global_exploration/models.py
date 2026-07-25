"""全局勘探的受控中间产物。"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StrictOutputModel(BaseModel):
    """拒绝模型擅自扩展字段，避免悄悄丢失语义。"""

    model_config = ConfigDict(extra="forbid")


class GlobalSignal(StrictOutputModel):
    """跨文档反复出现或对后续解析有提示作用的全局信号。"""

    label: str
    observation: str
    importance: str
    importance_reason: str
    source_pages: list[int] = Field(default_factory=list)
    occurrence_count: int = Field(default=1, ge=1)
    uncertainty: str | None = None

    @field_validator("source_pages")
    @classmethod
    def normalize_pages(cls, pages: list[int]) -> list[int]:
        return sorted({page for page in pages if page >= 1})


class CandidateConcept(StrictOutputModel):
    """尚未成为记忆节点的候选概念。"""

    label: str
    aliases: list[str] = Field(default_factory=list)
    initial_understanding: str
    importance: str
    importance_reason: str
    source_pages: list[int] = Field(default_factory=list)
    uncertainties: list[str] = Field(default_factory=list)

    @field_validator("source_pages")
    @classmethod
    def normalize_pages(cls, pages: list[int]) -> list[int]:
        return sorted({page for page in pages if page >= 1})


class CoarseRelation(StrictOutputModel):
    """只描述大概念之间的初步关系，不等同于最终图连线。"""

    source: str
    target: str
    relation: str
    rationale: str
    source_pages: list[int] = Field(default_factory=list)
    uncertainty: str | None = None

    @field_validator("source_pages")
    @classmethod
    def normalize_pages(cls, pages: list[int]) -> list[int]:
        return sorted({page for page in pages if page >= 1})


class ConceptSketch(StrictOutputModel):
    """概念阅读路径从文档开头持续累积的初步印象。"""

    document_level_observation: str = ""
    global_signals: list[GlobalSignal] = Field(default_factory=list)
    candidate_concepts: list[CandidateConcept] = Field(default_factory=list)
    coarse_relations: list[CoarseRelation] = Field(default_factory=list)
    open_questions: list[str] = Field(default_factory=list)


class ReviewIssue(StrictOutputModel):
    """交叉校验发现的、可触发定向回看的问题。"""

    severity: Literal["low", "medium", "high"]
    routes: list[Literal["summary", "structure", "concept"]] = Field(min_length=1)
    description: str
    evidence_pages: list[int] = Field(default_factory=list)
    revision_instruction: str

    @field_validator("evidence_pages")
    @classmethod
    def normalize_pages(cls, pages: list[int]) -> list[int]:
        return sorted({page for page in pages if page >= 1})

    @field_validator("routes")
    @classmethod
    def normalize_routes(
        cls,
        routes: list[Literal["summary", "structure", "concept"]],
    ) -> list[Literal["summary", "structure", "concept"]]:
        return list(dict.fromkeys(routes))


class ReconciliationReview(StrictOutputModel):
    """三条独立阅读路径的交叉校验结果。"""

    accepted_as_initial_impression: bool
    overall_assessment: str
    issues: list[ReviewIssue] = Field(default_factory=list)
    unresolved_uncertainties: list[str] = Field(default_factory=list)


class RouteStatistics(StrictOutputModel):
    """用于审计阅读覆盖范围，不表达知识结论。"""

    summary_units: int
    structure_units: int
    concept_units: int
    review_rounds: int


class SourceMetadata(StrictOutputModel):
    """输入 PDF 的稳定来源信息。"""

    path: str
    title: str
    sha256: str
    parser: str
    page_count: int


class GlobalExplorationSnapshot(StrictOutputModel):
    """冻结后的低权威全局勘探快照。"""

    model_config = ConfigDict(frozen=True)

    schema_version: Literal["global-exploration.v1"] = "global-exploration.v1"
    authority: Literal["preliminary-low-authority"] = "preliminary-low-authority"
    created_at: datetime
    source: SourceMetadata
    global_summary_markdown: str
    document_structure_markdown: str
    concept_sketch: ConceptSketch
    review_history: list[ReconciliationReview]
    frozen_with_unresolved_issues: bool
    route_statistics: RouteStatistics
