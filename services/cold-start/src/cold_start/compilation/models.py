"""对象—叙述—依据的文档局部记忆协议。"""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from cold_start.global_exploration.models import SourceMetadata
from cold_start.region_tree.models import BlockId

OBJECT_REFERENCE_PATTERN = re.compile(r"\{\{object:([^{}]+)\}\}")
OBJECT_ID_PATTERN = re.compile(r"^(?:region-\d{4,}/)?obj-\d+$")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Evidence(StrictModel):
    """一项对象识别或叙述在当前叶子中的原文依据。"""

    evidence_id: str = Field(pattern=r"^(?:region-\d{4,}/)?evidence-\d+$")
    start_block_id: BlockId
    end_block_id: BlockId
    note_markdown: str | None = Field(default=None, min_length=1, max_length=500)


class MemoryObject(StrictModel):
    """当前局部能够被后续叙述持续指认的对象。"""

    object_id: str = Field(pattern=r"^(?:region-\d{4,}/)?obj-\d+$")
    label: str = Field(min_length=1, max_length=150)
    aliases: list[str] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def validate_aliases(self) -> MemoryObject:
        if len(set(self.aliases)) != len(self.aliases):
            raise ValueError("aliases 不能重复")
        return self


class TemporalScope(StrictModel):
    """Assertion 所描述事实或观点成立的时间范围。"""

    kind: Literal["point", "range", "open_range", "general", "unknown"]
    display: str = Field(min_length=1, max_length=200)
    start: str | None = Field(default=None, min_length=1, max_length=100)
    end: str | None = Field(default=None, min_length=1, max_length=100)
    precision: Literal[
        "day",
        "month",
        "semester",
        "academic_year",
        "year",
        "unspecified",
    ]

    @model_validator(mode="after")
    def validate_boundaries(self) -> TemporalScope:
        if self.kind == "point" and (self.start is None or self.end is not None):
            raise ValueError("point 必须只填写 start")
        if self.kind == "range" and (self.start is None or self.end is None):
            raise ValueError("range 必须同时填写 start 和 end")
        if self.kind == "open_range" and ((self.start is None) == (self.end is None)):
            raise ValueError("open_range 必须且只能填写 start、end 之一")
        if self.kind in {"general", "unknown"} and (
            self.start is not None or self.end is not None
        ):
            raise ValueError(f"{self.kind} 不能填写 start 或 end")
        return self


class Assertion(StrictModel):
    """来源对一个或多个对象作出的事实记录或观点表达。"""

    assertion_id: str = Field(pattern=r"^(?:region-\d{4,}/)?assert-\d+$")
    mode: Literal["record", "viewpoint"]
    statement_template_markdown: str = Field(min_length=1, max_length=3_000)
    holder_object_id: str | None = None
    temporal_scope: TemporalScope
    temporal_basis_markdown: str = Field(min_length=1, max_length=500)
    uncertainty_markdown: str | None = Field(
        default=None,
        min_length=1,
        max_length=500,
    )
    evidence_ids: list[str] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def validate_statement_template(self) -> Assertion:
        object_ids = object_reference_ids(self.statement_template_markdown)
        if not object_ids:
            raise ValueError("statement_template_markdown 至少需要一个对象引用")
        if len(object_ids) > 100:
            raise ValueError("一条叙述最多引用 100 个对象")
        if self.mode == "record" and self.holder_object_id is not None:
            raise ValueError("record 的 holder_object_id 必须为 null")
        return self

    @property
    def referenced_object_ids(self) -> list[str]:
        """从正文模板推导对象引用；不再维护第二份易失真的对象列表。"""

        return object_reference_ids(self.statement_template_markdown)


class MemoryPackage(StrictModel):
    """一个叶子的完整对象—叙述—依据提取结果。"""

    schema_version: Literal["object-assertion-evidence-package.v4"] = (
        "object-assertion-evidence-package.v4"
    )
    objects: list[MemoryObject] = Field(default_factory=list, max_length=2_000)
    assertions: list[Assertion] = Field(default_factory=list, max_length=5_000)
    evidence: list[Evidence] = Field(default_factory=list, max_length=5_000)

    @model_validator(mode="after")
    def validate_references(self) -> MemoryPackage:
        object_ids = _unique_ids("object_id", self.objects)
        evidence_ids = _unique_ids("evidence_id", self.evidence)
        _unique_ids("assertion_id", self.assertions)

        for item in self.assertions:
            _require_known("叙述对象", item.referenced_object_ids, object_ids)
            _require_optional("观点持有者", item.holder_object_id, object_ids)
            _require_known("叙述依据", item.evidence_ids, evidence_ids)
        connected_object_ids = {
            object_id
            for item in self.assertions
            for object_id in assertion_object_ids(item)
        }
        orphaned = object_ids - connected_object_ids
        if orphaned:
            raise ValueError(
                "存在未被任何叙述连接的对象：" + ", ".join(sorted(orphaned))
            )
        if self.evidence and not self.assertions:
            raise ValueError("没有叙述时不能单独提交依据")
        return self


class RegionCompilationArtifact(StrictModel):
    """一个叶子及其基础记忆包和原文覆盖情况。"""

    schema_version: Literal["region-basic-compilation.v4"] = "region-basic-compilation.v4"
    created_at: datetime
    source: SourceMetadata
    region_tree_schema_version: str
    region_node_id: str = Field(pattern=r"^region-\d{4,}$")
    label: str
    lineage_node_ids: list[str]
    start_block_id: BlockId
    end_block_id: BlockId
    source_pages: list[int]
    source_block_ids: list[BlockId]
    covered_block_ids: list[BlockId]
    uncovered_block_ids: list[BlockId]
    package: MemoryPackage
    model_calls: int = Field(ge=2, le=8)
    warnings: list[str] = Field(default_factory=list)


class ObjectMergeDecision(StrictModel):
    """父节点确认多个局部对象指向同一个对象。"""

    object_ids: list[str] = Field(min_length=2, max_length=30)
    preferred_object_id: str
    reason: str = Field(min_length=1, max_length=500)


class AssertionMergeDecision(StrictModel):
    """父节点确认多条叙述表达同一件事。"""

    assertion_ids: list[str] = Field(min_length=2, max_length=30)
    preferred_assertion_id: str
    reason: str = Field(min_length=1, max_length=500)


class AssertionRevisionDecision(StrictModel):
    """父节点上下文足以证明局部叙述需要纠正。"""

    assertion_id: str
    mode: Literal["record", "viewpoint"]
    statement_template_markdown: str = Field(min_length=1, max_length=3_000)
    holder_object_id: str | None = None
    temporal_scope: TemporalScope
    temporal_basis_markdown: str = Field(min_length=1, max_length=500)
    uncertainty_markdown: str | None = Field(
        default=None,
        min_length=1,
        max_length=500,
    )
    reason: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_statement_template(self) -> AssertionRevisionDecision:
        if not object_reference_ids(self.statement_template_markdown):
            raise ValueError("statement_template_markdown 至少需要一个对象引用")
        if self.mode == "record" and self.holder_object_id is not None:
            raise ValueError("record 的 holder_object_id 必须为 null")
        return self


class ParentIntegrationDecision(StrictModel):
    """父节点只返回对已有基础记忆的少量确定性操作。"""

    object_merges: list[ObjectMergeDecision] = Field(default_factory=list, max_length=100)
    assertion_merges: list[AssertionMergeDecision] = Field(
        default_factory=list,
        max_length=200,
    )
    assertion_revisions: list[AssertionRevisionDecision] = Field(
        default_factory=list,
        max_length=100,
    )


class MissingObjectBinding(StrictModel):
    """把 Assertion 中仍为字面的稳定指称替换为 Object 引用。"""

    assertion_id: str
    literal_surface: str = Field(min_length=1, max_length=150)


class MissingObjectCandidate(StrictModel):
    """父级整合后发现、但尚未获准写入基础记忆的 Object 候选。"""

    candidate_id: str = Field(pattern=r"^candidate-\d+$")
    proposed_label: str = Field(min_length=1, max_length=150)
    proposed_aliases: list[str] = Field(default_factory=list, max_length=100)
    supporting_assertion_ids: list[str] = Field(min_length=1, max_length=100)
    proof_evidence_ids: list[str] = Field(min_length=1, max_length=100)
    bindings: list[MissingObjectBinding] = Field(min_length=1, max_length=100)
    reason: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_candidate(self) -> MissingObjectCandidate:
        if len(set(self.proposed_aliases)) != len(self.proposed_aliases):
            raise ValueError("proposed_aliases 不能重复")
        if self.proposed_label in self.proposed_aliases:
            raise ValueError("proposed_aliases 不能重复 proposed_label")
        assertion_ids = set(self.supporting_assertion_ids)
        if len(assertion_ids) != len(self.supporting_assertion_ids):
            raise ValueError("supporting_assertion_ids 不能重复")
        if len(set(self.proof_evidence_ids)) != len(self.proof_evidence_ids):
            raise ValueError("proof_evidence_ids 不能重复")
        binding_ids = {item.assertion_id for item in self.bindings}
        if not binding_ids <= assertion_ids:
            raise ValueError("bindings 只能引用 supporting_assertion_ids")
        return self


class MissingObjectDiscoveryOutput(StrictModel):
    """独立缺失对象发现阶段的候选集合。"""

    candidates: list[MissingObjectCandidate] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def validate_unique_candidates(self) -> MissingObjectDiscoveryOutput:
        candidate_ids = [item.candidate_id for item in self.candidates]
        if len(set(candidate_ids)) != len(candidate_ids):
            raise ValueError("candidate_id 不能重复")
        return self


class MissingObjectReviewDecision(StrictModel):
    """独立 Evidence 复查对一个缺失 Object 候选作出的决定。"""

    candidate_id: str = Field(pattern=r"^candidate-\d+$")
    verdict: Literal["accept", "reject", "defer"]
    confirmed_label: str | None = Field(default=None, min_length=1, max_length=150)
    confirmed_aliases: list[str] = Field(default_factory=list, max_length=100)
    confirmed_bindings: list[MissingObjectBinding] = Field(
        default_factory=list,
        max_length=100,
    )
    confirmed_evidence_ids: list[str] = Field(default_factory=list, max_length=100)
    reason: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_verdict(self) -> MissingObjectReviewDecision:
        if self.verdict == "accept":
            if self.confirmed_label is None:
                raise ValueError("accept 必须提供 confirmed_label")
            if not self.confirmed_bindings:
                raise ValueError("accept 必须提供 confirmed_bindings")
            if not self.confirmed_evidence_ids:
                raise ValueError("accept 必须提供 confirmed_evidence_ids")
            if any(
                item.literal_surface != self.confirmed_label
                for item in self.confirmed_bindings
            ):
                raise ValueError("第一版只允许把与 confirmed_label 完全相同的字面值绑定为 Object")
        elif (
            self.confirmed_label is not None
            or self.confirmed_aliases
            or self.confirmed_bindings
            or self.confirmed_evidence_ids
        ):
            raise ValueError("reject/defer 不得提交 confirmed_* 字段内容")
        if len(set(self.confirmed_aliases)) != len(self.confirmed_aliases):
            raise ValueError("confirmed_aliases 不能重复")
        if self.confirmed_label in self.confirmed_aliases:
            raise ValueError("confirmed_aliases 不能重复 confirmed_label")
        return self


class MissingObjectReviewOutput(StrictModel):
    """独立 Evidence 复查的完整输出。"""

    decisions: list[MissingObjectReviewDecision] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def validate_unique_decisions(self) -> MissingObjectReviewOutput:
        candidate_ids = [item.candidate_id for item in self.decisions]
        if len(set(candidate_ids)) != len(candidate_ids):
            raise ValueError("同一个 candidate_id 只能复查一次")
        return self


class MissingObjectRecoveryArtifact(StrictModel):
    """一个父节点的缺失 Object 发现、复查与确定性写入记录。"""

    schema_version: Literal["missing-object-recovery.v1"] = (
        "missing-object-recovery.v1"
    )
    node_id: str = Field(pattern=r"^region-\d{4,}$")
    discovery: MissingObjectDiscoveryOutput
    review: MissingObjectReviewOutput
    created_object_ids: list[str] = Field(default_factory=list, max_length=100)
    model_calls: int = Field(ge=0)


class NodeIntegrationResult(StrictModel):
    node_id: str = Field(pattern=r"^region-\d{4,}$")
    label: str
    depth: int = Field(ge=0)
    child_ids: list[str]
    source_compiled: bool
    input_object_count: int = Field(ge=0)
    output_object_count: int = Field(ge=0)
    input_assertion_count: int = Field(ge=0)
    output_assertion_count: int = Field(ge=0)
    source_model_calls: int = Field(ge=0)
    integration_model_calls: int = Field(ge=0)
    missing_object_model_calls: int = Field(default=0, ge=0)
    recovered_object_count: int = Field(default=0, ge=0)
    warnings: list[str] = Field(default_factory=list)

    @property
    def model_calls(self) -> int:
        return (
            self.source_model_calls
            + self.integration_model_calls
            + self.missing_object_model_calls
        )


class FullCompilationSnapshot(StrictModel):
    """从所有内容来源节点一直整合到根节点的基础编译结果。"""

    schema_version: Literal["full-basic-compilation.v5"] = "full-basic-compilation.v5"
    created_at: datetime
    source: SourceMetadata
    region_tree_schema_version: str
    root_node_id: str = Field(pattern=r"^region-\d{4,}$")
    root_package: MemoryPackage
    node_results: list[NodeIntegrationResult]
    content_source_block_ids: list[BlockId]
    covered_block_ids: list[BlockId]
    uncovered_block_ids: list[BlockId]
    structural_context_block_ids: list[BlockId]
    model_calls: int = Field(ge=0)
    warnings: list[str] = Field(default_factory=list)


def package_warnings(package: MemoryPackage) -> list[str]:
    """返回不阻断产物、但值得人工查看的基础协议问题。"""

    used_evidence_ids = {
        evidence_id
        for item in package.assertions
        for evidence_id in item.evidence_ids
    }
    unused = {item.evidence_id for item in package.evidence} - used_evidence_ids
    warnings = []
    if unused:
        warnings.append(f"存在未被叙述引用的依据：{', '.join(sorted(unused))}")
    return warnings


def object_reference_ids(statement_template_markdown: str) -> list[str]:
    """按首次出现顺序读取模板中的对象 ID，并拒绝损坏的引用语法。"""

    matches = list(OBJECT_REFERENCE_PATTERN.finditer(statement_template_markdown))
    remainder = OBJECT_REFERENCE_PATTERN.sub("", statement_template_markdown)
    if "{{object:" in remainder:
        raise ValueError("statement_template_markdown 包含不完整的对象引用")
    object_ids = [match.group(1) for match in matches]
    invalid = [value for value in object_ids if not OBJECT_ID_PATTERN.fullmatch(value)]
    if invalid:
        raise ValueError(f"对象引用 ID 格式错误：{', '.join(sorted(set(invalid)))}")
    return list(dict.fromkeys(object_ids))


def assertion_object_ids(assertion: Assertion) -> list[str]:
    """返回一条叙述连接的全部对象，包括单独存储的观点持有者。"""

    values = [*assertion.referenced_object_ids]
    if assertion.holder_object_id:
        values.append(assertion.holder_object_id)
    return list(dict.fromkeys(values))


def object_assertion_ids(package: MemoryPackage, object_id: str) -> list[str]:
    """返回连接指定对象的叙述 ID。"""

    return [
        item.assertion_id
        for item in package.assertions
        if object_id in assertion_object_ids(item)
    ]


def object_evidence_ids(package: MemoryPackage, object_id: str) -> list[str]:
    """通过连接对象的叙述动态追溯对象依据，不在 Object 上重复存储。"""

    return list(
        dict.fromkeys(
            evidence_id
            for item in package.assertions
            if object_id in assertion_object_ids(item)
            for evidence_id in item.evidence_ids
        )
    )


def rewrite_object_references(
    statement_template_markdown: str,
    mapping: Mapping[str, str],
) -> str:
    """在局部 ID 重写或对象合并时同步改写正文模板引用。"""

    object_reference_ids(statement_template_markdown)
    return OBJECT_REFERENCE_PATTERN.sub(
        lambda match: f"{{{{object:{mapping.get(match.group(1), match.group(1))}}}}}",
        statement_template_markdown,
    )


def render_statement(
    assertion: Assertion,
    objects: Mapping[str, MemoryObject],
) -> str:
    """用对象当前规范名称渲染一条供人阅读的叙述。"""

    missing = set(assertion.referenced_object_ids) - set(objects)
    if missing:
        raise ValueError(f"叙述引用了不存在的对象：{', '.join(sorted(missing))}")
    return OBJECT_REFERENCE_PATTERN.sub(
        lambda match: objects[match.group(1)].label,
        assertion.statement_template_markdown,
    )


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
