"""叶子局部编译的结构化协议。"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from cold_start.global_exploration.models import SourceMetadata
from cold_start.region_tree.models import BlockId


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


MemoryCardKind = Literal[
    "activity_pattern",
    "activity_trait",
    "person",
    "role",
    "historical_event",
    "workflow",
    "work_step",
    "rule",
    "principle",
    "practice",
    "archive_record",
]

MemoryRelationType = Literal[
    "has_trait",
    "uses",
    "contains",
    "next",
    "requires",
    "exception_to",
    "applies_to",
    "relevant_at",
    "informs",
    "constrains",
    "deviates_from",
    "establishes",
    "changes",
    "held_role",
    "responsible_for",
    "participated_in",
    "authored",
]

CARD_CONTENT_FIELDS: dict[str, tuple[frozenset[str], frozenset[str]]] = {
    "activity_pattern": (
        frozenset({"description_markdown", "recurrence_kind"}),
        frozenset(
            {
                "purpose_markdown",
                "typical_timing_markdown",
                "identity_boundary_markdown",
            }
        ),
    ),
    "activity_trait": (
        frozenset({"dimension", "code", "definition_markdown"}),
        frozenset(),
    ),
    "person": (
        frozenset({"identity_markdown"}),
        frozenset({"disambiguation_markdown"}),
    ),
    "role": (
        frozenset({"definition_markdown"}),
        frozenset({"boundary_markdown", "uncertainty_markdown"}),
    ),
    "historical_event": (
        frozenset({"event_markdown"}),
        frozenset(
            {
                "time_markdown",
                "background_markdown",
                "outcome_markdown",
                "significance_markdown",
                "uncertainty_markdown",
            }
        ),
    ),
    "workflow": (
        frozenset({"goal_markdown", "entry_meaning_markdown"}),
        frozenset(),
    ),
    "work_step": (
        frozenset(
            {
                "objective_markdown",
                "instruction_markdown",
                "completion_meaning_markdown",
            }
        ),
        frozenset(),
    ),
    "rule": (
        frozenset({"statement_markdown"}),
        frozenset({"rationale_markdown", "violation_impact_markdown"}),
    ),
    "principle": (
        frozenset({"statement_markdown", "rationale_markdown"}),
        frozenset({"tradeoff_markdown"}),
    ),
    "practice": (
        frozenset({"situation_markdown", "behavior_markdown", "lesson_markdown"}),
        frozenset(
            {
                "outcome_markdown",
                "uncertainty_markdown",
            }
        ),
    ),
    "archive_record": (
        frozenset({"content_overview_markdown"}),
        frozenset({"provenance_markdown", "integrity_markdown"}),
    ),
}


class MemoryCardCandidate(StrictModel):
    card_id: str = Field(pattern=r"^card-\d+$")
    kind: MemoryCardKind
    title: str = Field(min_length=1, max_length=100)
    summary: str = Field(min_length=1, max_length=500)
    content: dict[str, str | None] = Field(min_length=1, max_length=6)
    evidence_ids: list[str] = Field(min_length=1, max_length=12)

    @model_validator(mode="after")
    def validate_content_fields(self) -> MemoryCardCandidate:
        required, optional = CARD_CONTENT_FIELDS[self.kind]
        keys = set(self.content)
        missing = required - keys
        unknown = keys - required - optional
        empty_required = {
            key
            for key in required
            if self.content.get(key) is None or not str(self.content[key]).strip()
        }
        if missing or empty_required:
            names = ", ".join(sorted(missing | empty_required))
            raise ValueError(f"{self.kind} 缺少必填内容字段：{names}")
        if unknown:
            raise ValueError(
                f"{self.kind} 包含未知内容字段：{', '.join(sorted(unknown))}"
            )
        for key, value in self.content.items():
            if value is not None and not value.strip():
                raise ValueError(f"{self.kind}.{key} 不能为空字符串")
        if self.kind == "activity_pattern":
            recurrence = self.content["recurrence_kind"]
            if recurrence not in {
                "annual",
                "semester",
                "irregular",
                "on_demand",
                "unknown",
            }:
                raise ValueError("activity_pattern.recurrence_kind 取值无效")
        if self.kind == "activity_trait":
            dimension = self.content["dimension"]
            if dimension not in {
                "scale",
                "format",
                "audience",
                "funding",
                "venue",
                "recurrence",
                "other",
            }:
                raise ValueError("activity_trait.dimension 取值无效")
        return self


class LocalEdgeCandidate(StrictModel):
    edge_id: str = Field(pattern=r"^edge-\d+$")
    from_card_id: str = Field(pattern=r"^card-\d+$")
    to_card_id: str = Field(pattern=r"^card-\d+$")
    context_card_id: str | None = Field(default=None, pattern=r"^card-\d+$")
    relation_type: MemoryRelationType
    sequence: int | None = Field(default=None, ge=0)
    temporal_scope_markdown: str | None = Field(default=None, max_length=500)
    note_markdown: str | None = Field(default=None, max_length=500)
    evidence_ids: list[str] = Field(min_length=1, max_length=12)


class SourceEvidenceCandidate(StrictModel):
    evidence_id: str = Field(pattern=r"^evidence-\d+$")
    start_block_id: BlockId
    end_block_id: BlockId
    role: Literal["basis", "example", "counterexample", "context"]
    note_markdown: str = Field(min_length=1, max_length=500)


class UncompiledSegment(StrictModel):
    start_block_id: BlockId
    end_block_id: BlockId
    reason_kind: Literal[
        "structural_only",
        "not_long_term_memory",
        "duplicate_within_region",
        "insufficient_information",
        "unsupported_card_kind",
        "needs_parent_context",
    ]
    reason: str = Field(min_length=1, max_length=500)


class LeafCandidateSubgraph(StrictModel):
    new_cards: list[MemoryCardCandidate] = Field(default_factory=list, max_length=20)
    local_edges: list[LocalEdgeCandidate] = Field(default_factory=list, max_length=40)
    source_evidence: list[SourceEvidenceCandidate] = Field(
        default_factory=list,
        max_length=40,
    )
    uncompiled_segments: list[UncompiledSegment] = Field(
        default_factory=list,
        max_length=30,
    )


class LeafCompilationResult(StrictModel):
    leaf_node_id: str = Field(pattern=r"^region-\d{4,}$")
    label: str
    lineage: list[str]
    start_block_id: BlockId
    end_block_id: BlockId
    source_pages: list[int]
    status: Literal["compiled", "failed"]
    subgraph: LeafCandidateSubgraph | None = None
    error: str | None = None
    model_calls: int = Field(default=0, ge=0)


class LeafCompilationSnapshot(StrictModel):
    schema_version: Literal["leaf-compilation.v1"] = "leaf-compilation.v1"
    created_at: datetime
    status: Literal["running", "complete", "partial"]
    source: SourceMetadata
    region_tree_schema_version: str
    leaf_results: list[LeafCompilationResult]
    deferred_content_node_ids: list[str]
    model_calls: int = Field(default=0, ge=0)
    issues: list[str] = Field(default_factory=list)
