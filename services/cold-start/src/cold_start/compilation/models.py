"""对象—陈述—关系—依据的文档局部记忆协议。"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from cold_start.global_exploration.models import SourceMetadata
from cold_start.region_tree.models import BlockId


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


ObjectKindHint = Literal[
    "organization",
    "activity",
    "activity_trait",
    "person",
    "role",
    "work_unit",
    "archive",
    "document",
    "concept",
    "unknown",
]

AssertionMode = Literal["record", "viewpoint"]

AssertionKindHint = Literal[
    "existence",
    "state",
    "event",
    "practice",
    "outcome",
    "formal_norm",
    "interpretation",
    "causal_explanation",
    "evaluation",
    "guidance",
    "goal",
    "proposal",
    "prediction",
    "other",
]

RECORD_ASSERTION_KINDS = frozenset(
    {"existence", "state", "event", "practice", "outcome", "formal_norm"}
)
VIEWPOINT_ASSERTION_KINDS = frozenset(
    {
        "interpretation",
        "causal_explanation",
        "evaluation",
        "guidance",
        "goal",
        "proposal",
        "prediction",
    }
)

AuthorityStatus = Literal[
    "personal_view",
    "role_based_view",
    "team_consensus",
    "organization_adopted",
    "formal_authority",
    "unknown",
]


class Evidence(StrictModel):
    """一项识别或陈述在当前文档中的可追溯来源。"""

    evidence_id: str = Field(pattern=r"^evidence-\d+$")
    start_block_id: BlockId
    end_block_id: BlockId
    role: Literal["identity", "basis", "context", "example", "counterexample"]
    note_markdown: str | None = Field(default=None, max_length=500)


class MemoryObject(StrictModel):
    """当前局部能够持续指认的对象；类型在叶子阶段只是候选。"""

    object_id: str = Field(pattern=r"^obj-\d+$")
    label: str = Field(min_length=1, max_length=150)
    aliases: list[str] = Field(default_factory=list, max_length=20)
    kind_hints: list[ObjectKindHint] = Field(min_length=1, max_length=4)
    identity_markdown: str | None = Field(default=None, max_length=1_000)
    evidence_ids: list[str] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def validate_kind_hints(self) -> MemoryObject:
        if len(set(self.kind_hints)) != len(self.kind_hints):
            raise ValueError("kind_hints 不能重复")
        if "unknown" in self.kind_hints and len(self.kind_hints) > 1:
            raise ValueError("unknown 不能与其他对象类型候选并列")
        if len(set(self.aliases)) != len(self.aliases):
            raise ValueError("aliases 不能重复")
        return self


class Assertion(StrictModel):
    """来源对一个或多个对象作出的事实性记录或观点性表达。"""

    assertion_id: str = Field(pattern=r"^assert-\d+$")
    about_object_ids: list[str] = Field(min_length=1, max_length=12)
    mode: AssertionMode
    kind_hint: AssertionKindHint | None = None
    statement_markdown: str = Field(min_length=1, max_length=3_000)
    holder_object_id: str | None = None
    authority_status: AuthorityStatus | None = None
    temporal_scope_markdown: str | None = Field(default=None, max_length=500)
    uncertainty_markdown: str | None = Field(default=None, max_length=500)
    evidence_ids: list[str] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def validate_semantics(self) -> Assertion:
        if len(set(self.about_object_ids)) != len(self.about_object_ids):
            raise ValueError("about_object_ids 不能重复")
        return self


class Relation(StrictModel):
    """两个对象间有依据的连接；关系也保留陈述来源和立场。"""

    relation_id: str = Field(pattern=r"^rel-\d+$")
    from_object_id: str
    predicate: str = Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")
    to_object_id: str
    context_object_id: str | None = None
    mode: AssertionMode = "record"
    holder_object_id: str | None = None
    authority_status: AuthorityStatus | None = None
    temporal_scope_markdown: str | None = Field(default=None, max_length=500)
    uncertainty_markdown: str | None = Field(default=None, max_length=500)
    evidence_ids: list[str] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def validate_semantics(self) -> Relation:
        if self.from_object_id == self.to_object_id:
            raise ValueError("关系两端不能是同一个对象")
        return self


class UnresolvedItem(StrictModel):
    """无法在当前局部可靠决定、需要父节点或人工继续处理的问题。"""

    unresolved_id: str = Field(pattern=r"^unresolved-\d+$")
    kind: Literal[
        "object_identity",
        "object_kind",
        "assertion_scope",
        "viewpoint_holder",
        "relation",
        "other",
    ]
    description_markdown: str = Field(min_length=1, max_length=1_000)
    object_ids: list[str] = Field(default_factory=list, max_length=12)
    assertion_ids: list[str] = Field(default_factory=list, max_length=12)
    relation_ids: list[str] = Field(default_factory=list, max_length=12)
    evidence_ids: list[str] = Field(min_length=1, max_length=20)


class MemoryPackage(StrictModel):
    """一个区域可独立校验、也可递归交给父节点的记忆中间包。"""

    schema_version: Literal["object-assertion-package.v1"] = (
        "object-assertion-package.v1"
    )
    objects: list[MemoryObject] = Field(default_factory=list, max_length=100)
    assertions: list[Assertion] = Field(default_factory=list, max_length=200)
    relations: list[Relation] = Field(default_factory=list, max_length=200)
    evidence: list[Evidence] = Field(default_factory=list, max_length=300)
    unresolved: list[UnresolvedItem] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def validate_references(self) -> MemoryPackage:
        object_ids = _unique_ids("object_id", self.objects)
        assertion_ids = _unique_ids("assertion_id", self.assertions)
        relation_ids = _unique_ids("relation_id", self.relations)
        evidence_ids = _unique_ids("evidence_id", self.evidence)
        _unique_ids("unresolved_id", self.unresolved)

        for item in self.objects:
            _require_known("对象依据", item.evidence_ids, evidence_ids)
        for item in self.assertions:
            _require_known("陈述对象", item.about_object_ids, object_ids)
            _require_optional("观点持有者", item.holder_object_id, object_ids)
            _require_known("陈述依据", item.evidence_ids, evidence_ids)
        for item in self.relations:
            _require_known(
                "关系对象",
                [item.from_object_id, item.to_object_id],
                object_ids,
            )
            _require_optional("关系上下文", item.context_object_id, object_ids)
            _require_optional("关系观点持有者", item.holder_object_id, object_ids)
            _require_known("关系依据", item.evidence_ids, evidence_ids)
        for item in self.unresolved:
            _require_known("未决对象", item.object_ids, object_ids)
            _require_known("未决陈述", item.assertion_ids, assertion_ids)
            _require_known("未决关系", item.relation_ids, relation_ids)
            _require_known("未决依据", item.evidence_ids, evidence_ids)

        return self


class RegionCompilationArtifact(StrictModel):
    """一个区域及其记忆包的可递归编译产物。"""

    schema_version: Literal["region-object-compilation.v1"] = (
        "region-object-compilation.v1"
    )
    created_at: datetime
    source: SourceMetadata
    region_tree_schema_version: str
    region_node_id: str = Field(pattern=r"^region-\d{4,}$")
    label: str
    lineage_node_ids: list[str]
    start_block_id: BlockId
    end_block_id: BlockId
    source_pages: list[int]
    package: MemoryPackage
    model_calls: int = Field(ge=1, le=2)
    warnings: list[str] = Field(default_factory=list)


def package_warnings(package: MemoryPackage) -> list[str]:
    """返回不阻断局部产物、但需要父节点或人工复核的语义问题。"""

    warnings: list[str] = []
    used_evidence_ids = {
        evidence_id
        for item in [
            *package.objects,
            *package.assertions,
            *package.relations,
            *package.unresolved,
        ]
        for evidence_id in item.evidence_ids
    }
    unused = {item.evidence_id for item in package.evidence} - used_evidence_ids
    if unused:
        warnings.append(f"存在未被知识引用的依据：{', '.join(sorted(unused))}")

    for item in package.assertions:
        if item.mode == "record" and item.kind_hint in VIEWPOINT_ASSERTION_KINDS:
            warnings.append(
                f"{item.assertion_id} 的 kind_hint={item.kind_hint} 与 mode=record 不一致"
            )
        if item.mode == "viewpoint" and item.kind_hint in RECORD_ASSERTION_KINDS:
            warnings.append(
                f"{item.assertion_id} 的 kind_hint={item.kind_hint} "
                "与 mode=viewpoint 不一致"
            )
        if item.mode == "record" and (
            item.holder_object_id is not None or item.authority_status is not None
        ):
            warnings.append(f"{item.assertion_id} 是 record，但包含观点归属字段")

    for item in package.relations:
        if item.mode == "record" and (
            item.holder_object_id is not None or item.authority_status is not None
        ):
            warnings.append(f"{item.relation_id} 是 record，但包含观点归属字段")
    return warnings


def _unique_ids(field_name: str, items: list[StrictModel]) -> set[str]:
    values = [str(getattr(item, field_name)) for item in items]
    if len(values) != len(set(values)):
        raise ValueError(f"{field_name} 不能重复")
    return set(values)


def _require_known(label: str, references: list[str], known: set[str]) -> None:
    missing = set(references) - known
    if missing:
        raise ValueError(f"{label}引用了不存在的 ID：{', '.join(sorted(missing))}")


def _require_optional(label: str, reference: str | None, known: set[str]) -> None:
    if reference is not None:
        _require_known(label, [reference], known)
