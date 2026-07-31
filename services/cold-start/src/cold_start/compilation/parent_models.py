"""父节点整合的结构化协议。"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import Field, model_validator

from cold_start.compilation.models import (
    MemoryCardCandidate,
    MemoryCardKind,
    MemoryRelationType,
    SourceEvidenceCandidate,
    StrictModel,
    UncompiledSegment,
)
from cold_start.global_exploration.models import SourceMetadata
from cold_start.region_tree.models import BlockId, SourceSegment


class IntegratedEvidence(StrictModel):
    evidence_id: str
    source_node_id: str
    start_block_id: BlockId
    end_block_id: BlockId
    role: Literal["basis", "example", "counterexample", "context"]
    note_markdown: str


class IntegratedCard(StrictModel):
    card_id: str
    kind: MemoryCardKind
    title: str
    summary: str
    content: dict[str, str | None]
    evidence_ids: list[str]
    origin_card_ids: list[str]


class IntegratedEdge(StrictModel):
    edge_id: str
    from_card_id: str
    to_card_id: str
    context_card_id: str | None = None
    relation_type: MemoryRelationType
    sequence: int | None = None
    temporal_scope_markdown: str | None = None
    note_markdown: str | None = None
    evidence_ids: list[str]
    origin_edge_ids: list[str]


class IntegrationIssue(StrictModel):
    issue_id: str
    source_node_id: str
    card_ids: list[str] = Field(default_factory=list)
    source_segments: list[SourceSegment] = Field(default_factory=list)
    description: str


class IntegratedSubgraph(StrictModel):
    cards: list[IntegratedCard] = Field(default_factory=list)
    edges: list[IntegratedEdge] = Field(default_factory=list)
    evidence: list[IntegratedEvidence] = Field(default_factory=list)
    unresolved_issues: list[IntegrationIssue] = Field(default_factory=list)


AgendaKind = Literal[
    "possible_duplicate",
    "possible_correction",
    "possible_cross_child_link",
    "possible_parent_source_link",
]


class AgendaGroup(StrictModel):
    kind: AgendaKind
    card_ids: list[str] = Field(min_length=1, max_length=24)
    reason: str = Field(min_length=1, max_length=500)


class ParentIntegrationAgenda(StrictModel):
    overview: str = Field(min_length=1, max_length=1000)
    candidate_groups: list[AgendaGroup] = Field(default_factory=list, max_length=80)


class IntegrationCardDefinition(StrictModel):
    kind: MemoryCardKind
    title: str = Field(min_length=1, max_length=100)
    summary: str = Field(min_length=1, max_length=500)
    content: dict[str, str | None] = Field(min_length=1, max_length=6)
    evidence_ids: list[str] = Field(min_length=1, max_length=24)

    @model_validator(mode="after")
    def validate_content(self) -> IntegrationCardDefinition:
        MemoryCardCandidate(
            card_id="card-1",
            kind=self.kind,
            title=self.title,
            summary=self.summary,
            content=self.content,
            evidence_ids=self.evidence_ids,
        )
        return self


class NewCardOperation(StrictModel):
    card_id: str = Field(pattern=r"^card-\d+$")
    definition: IntegrationCardDefinition


class MergeCardsOperation(StrictModel):
    card_ids: list[str] = Field(min_length=2, max_length=24)
    replacement: IntegrationCardDefinition
    reason: str = Field(min_length=1, max_length=500)


class ReviseCardOperation(StrictModel):
    card_id: str
    replacement: IntegrationCardDefinition
    reason: str = Field(min_length=1, max_length=500)


class RemoveCardOperation(StrictModel):
    card_id: str
    evidence_ids: list[str] = Field(min_length=1, max_length=24)
    reason: str = Field(min_length=1, max_length=500)


class AddEdgeOperation(StrictModel):
    edge_id: str = Field(pattern=r"^edge-\d+$")
    from_card_id: str
    to_card_id: str
    context_card_id: str | None = None
    relation_type: MemoryRelationType
    sequence: int | None = Field(default=None, ge=0)
    temporal_scope_markdown: str | None = Field(default=None, max_length=500)
    note_markdown: str | None = Field(default=None, max_length=500)
    evidence_ids: list[str] = Field(min_length=1, max_length=24)


class RemoveEdgeOperation(StrictModel):
    edge_id: str
    evidence_ids: list[str] = Field(min_length=1, max_length=24)
    reason: str = Field(min_length=1, max_length=500)


class DeferredIssueDraft(StrictModel):
    issue_id: str = Field(pattern=r"^issue-\d+$")
    card_ids: list[str] = Field(default_factory=list, max_length=24)
    source_segments: list[SourceSegment] = Field(default_factory=list, max_length=12)
    description: str = Field(min_length=1, max_length=500)


class ParentIntegrationDecision(StrictModel):
    new_cards: list[NewCardOperation] = Field(default_factory=list, max_length=20)
    merge_cards: list[MergeCardsOperation] = Field(default_factory=list, max_length=30)
    revise_cards: list[ReviseCardOperation] = Field(default_factory=list, max_length=30)
    remove_cards: list[RemoveCardOperation] = Field(default_factory=list, max_length=30)
    add_edges: list[AddEdgeOperation] = Field(default_factory=list, max_length=60)
    remove_edges: list[RemoveEdgeOperation] = Field(default_factory=list, max_length=60)
    source_evidence: list[SourceEvidenceCandidate] = Field(
        default_factory=list,
        max_length=40,
    )
    uncompiled_parent_segments: list[UncompiledSegment] = Field(
        default_factory=list,
        max_length=30,
    )
    resolved_issue_ids: list[str] = Field(default_factory=list, max_length=40)
    deferred_issues: list[DeferredIssueDraft] = Field(default_factory=list, max_length=30)


class ParentIntegrationResult(StrictModel):
    node_id: str
    label: str
    depth: int
    child_ids: list[str]
    status: Literal["integrated", "failed", "blocked"]
    agenda: ParentIntegrationAgenda | None = None
    decision: ParentIntegrationDecision | None = None
    input_card_count: int = Field(default=0, ge=0)
    output_card_count: int = Field(default=0, ge=0)
    output_edge_count: int = Field(default=0, ge=0)
    model_calls: int = Field(default=0, ge=0)
    error: str | None = None


class ParentIntegrationSnapshot(StrictModel):
    schema_version: Literal["parent-integration.v1"] = "parent-integration.v1"
    created_at: datetime
    status: Literal["running", "complete", "partial"]
    source: SourceMetadata
    leaf_compilation_created_at: datetime
    root_node_id: str
    parent_results: list[ParentIntegrationResult]
    root_subgraph: IntegratedSubgraph | None = None
    model_calls: int = Field(default=0, ge=0)
    issues: list[str] = Field(default_factory=list)
