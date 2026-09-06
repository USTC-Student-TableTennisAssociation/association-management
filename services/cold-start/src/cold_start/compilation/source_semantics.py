"""把整份来源定位到 Source Time，并把区域编译为 Assertion 与 Object Fragment。"""

from __future__ import annotations

import asyncio
import json
import re
import unicodedata
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, TypeVar

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

from cold_start.document.blocks import format_blocks
from cold_start.document.evidence_links import attached_evidence_block_ids
from cold_start.document.models import ParsedBlock
from cold_start.global_exploration.models import GlobalExplorationSnapshot, SourceMetadata
from cold_start.llm.base import ChatModel, commit_model_turn, reject_model_turn
from cold_start.llm.openai_compatible import ModelRepetitionError
from cold_start.llm.structured_output import ModelOutputError, normalize_json_document
from cold_start.progress import NullProgressReporter, ProgressReporter
from cold_start.region_tree.models import BlockId, RegionNode
from cold_start.region_tree.runtime import BlockIndex


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


AssertionKind = Literal["grounded", "reference"]
IdentityModeHint = Literal[
    "named_person",
    "role_type",
    "entity_type",
    "named_entity",
    "undetermined",
]
CLAIM_POLICY_VERSION = "source-claims-policy.v3"
FRAGMENT_POLICY_VERSION = "source-fragments-policy.v5"
SOURCE_SEMANTIC_POLICY_VERSION = "source-semantics-policy.v5"


def _normalize_source_time_text(value: str) -> str:
    """只规整格式空白，不解释或改写 Source Time 的时间语义。"""

    normalized = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value).strip())
    return re.sub(
        r"(?<=[\u3400-\u9fff\d])\s+(?=[\u3400-\u9fff\d])",
        "",
        normalized,
    )


class AtomicClaimDraft(StrictModel):
    """模型提交的一条完整知识单元或来源导航索引。"""

    kind: AssertionKind = "grounded"
    statement_markdown: str = Field(min_length=1, max_length=3_000)
    supporting_block_ids: list[BlockId] = Field(min_length=1, max_length=32)
    context_dependent: bool


class AtomicClaimSubmission(StrictModel):
    claims: list[AtomicClaimDraft] = Field(default_factory=list, max_length=1_000)


class MissingClaimSubmission(StrictModel):
    claims: list[AtomicClaimDraft] = Field(default_factory=list, max_length=1_000)


class SourceClaim(AtomicClaimDraft):
    claim_id: str = Field(pattern=r"^claim-\d+$")


class ObjectFragmentDraft(StrictModel):
    """模型在一次 SourceRegion 内提交的临时同指称名称组。"""

    fragment_key: str = Field(pattern=r"^F\d+$")
    surface_forms: list[str] = Field(min_length=1, max_length=100)
    identity_mode_hint: IdentityModeHint

    @model_validator(mode="after")
    def validate_surface_forms(self) -> ObjectFragmentDraft:
        normalized = [item.strip() for item in self.surface_forms]
        if any(not item for item in normalized):
            raise ValueError("surface_forms 不能包含空名称")
        if normalized != self.surface_forms:
            raise ValueError("surface_forms 不能包含首尾空白")
        if len(set(normalized)) != len(normalized):
            raise ValueError("同一 Fragment 不能重复 surface form")
        return self


class FragmentAssertionTemplateDraft(StrictModel):
    """模型生成的 Assertion 模板与语义 Object 链接。"""

    claim_id: str = Field(pattern=r"^claim-\d+$")
    kind: AssertionKind = "grounded"
    statement_template_markdown: str = Field(min_length=1, max_length=3_000)
    semantic_fragment_keys: list[str] = Field(default_factory=list, max_length=100)


class ObjectFragmentSubmission(StrictModel):
    fragments: list[ObjectFragmentDraft] = Field(default_factory=list, max_length=2_000)
    assertions: list[FragmentAssertionTemplateDraft] = Field(max_length=5_000)


class ObjectFragment(StrictModel):
    """Leaf compiler IR；未来由 Global Resolver 归并到 Global Object。"""

    fragment_id: str = Field(pattern=r"^fragment-\d+$")
    source_region_id: str = Field(pattern=r"^region-\d{4,}$")
    surface_forms: list[str] = Field(min_length=1, max_length=100)
    identity_mode_hint: IdentityModeHint

    @model_validator(mode="after")
    def validate_surface_forms(self) -> ObjectFragment:
        if any(not item.strip() or item != item.strip() for item in self.surface_forms):
            raise ValueError("surface_forms 必须是非空且无首尾空白的名称")
        if len(set(self.surface_forms)) != len(self.surface_forms):
            raise ValueError("同一 Fragment 不能重复 surface form")
        return self


class SourceAssertionDraft(StrictModel):
    claim_id: str = Field(pattern=r"^claim-\d+$")
    kind: AssertionKind = "grounded"
    statement_template_markdown: str = Field(min_length=1, max_length=3_000)
    semantic_fragment_ids: list[str] = Field(default_factory=list, max_length=100)
    supporting_block_ids: list[BlockId] = Field(min_length=1, max_length=32)
    context_dependent: bool

    @model_validator(mode="after")
    def validate_reference_mode(self) -> SourceAssertionDraft:
        if len(set(self.semantic_fragment_ids)) != len(self.semantic_fragment_ids):
            raise ValueError("semantic_fragment_ids 不能重复")
        if self.kind == "grounded" and self.semantic_fragment_ids:
            raise ValueError("grounded Assertion 不能使用 semantic Fragment 链接")
        if self.kind == "reference" and not self.semantic_fragment_ids:
            raise ValueError("Reference Assertion 至少需要一个 semantic Fragment 链接")
        if self.kind == "reference" and "{{fragment:" in self.statement_template_markdown:
            raise ValueError("Reference Assertion 不能使用 anchored Fragment token")
        return self


class SourceAssertion(SourceAssertionDraft):
    """最终 Leaf Assertion；必要时间语境保留在正文，不另建 Temporal metadata。"""


class SourceTimeSubmission(StrictModel):
    """模型对整份 Source 给出的保守时间锚点。"""

    source_time_text: str | None = Field(default=None, min_length=1, max_length=300)
    supporting_block_ids: list[BlockId] = Field(default_factory=list, max_length=32)

    @field_validator("source_time_text")
    @classmethod
    def normalize_source_time_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = _normalize_source_time_text(value)
        if not normalized:
            raise ValueError("source_time_text 不能仅包含空白")
        return normalized

    @model_validator(mode="after")
    def validate_null_evidence(self) -> SourceTimeSubmission:
        if self.source_time_text is None and self.supporting_block_ids:
            raise ValueError("source_time_text 为 null 时 supporting_block_ids 必须为空")
        if self.source_time_text is not None and not self.supporting_block_ids:
            raise ValueError("非空 source_time_text 必须提供 supporting_block_ids")
        if len(set(self.supporting_block_ids)) != len(self.supporting_block_ids):
            raise ValueError("supporting_block_ids 不能重复")
        return self


class SourceClaimCheckpoint(StrictModel):
    schema_version: Literal["source-claims.v8"] = "source-claims.v8"
    policy_version: Literal["source-claims-policy.v3"]
    source_sha256: str
    region_node_id: str = Field(pattern=r"^region-\d{4,}$")
    claims: list[SourceClaim]
    model_calls: int = Field(ge=0)


class SourceObjectFragmentCheckpoint(StrictModel):
    schema_version: Literal["source-object-fragments.v6"] = "source-object-fragments.v6"
    policy_version: Literal["source-fragments-policy.v5"]
    source_sha256: str
    region_node_id: str = Field(pattern=r"^region-\d{4,}$")
    fragments: list[ObjectFragment]
    assertions: list[SourceAssertion]
    model_calls: int = Field(ge=0)


class SourceTimeCheckpoint(SourceTimeSubmission):
    schema_version: Literal["source-time.v1"] = "source-time.v1"
    source_sha256: str
    model_calls: int = Field(ge=0)


class SourceStageStatus(StrictModel):
    source_node_id: str = Field(pattern=r"^region-\d{4,}$")
    initial_claims: bool
    reviewed_claims: bool
    object_fragments: bool
    complete: bool
    error: str | None = None


class FullSourceSemanticWorking(StrictModel):
    schema_version: Literal["source-semantics-working.v10"] = "source-semantics-working.v10"
    policy_version: Literal["source-semantics-policy.v5"]
    source_sha256: str
    source_node_ids: list[str]
    source_time: bool
    stages: list[SourceStageStatus]


class SourceSemanticSnapshot(StrictModel):
    """来源 Assertion、Leaf Object Fragment 与来源锚定时间。"""

    schema_version: Literal["source-semantics.v10"] = "source-semantics.v10"
    policy_version: Literal["source-semantics-policy.v5"]
    created_at: datetime
    source: SourceMetadata
    region_tree_schema_version: str
    region_node_id: str = Field(pattern=r"^region-\d{4,}$")
    label: str
    lineage_node_ids: list[str]
    source_pages: list[int]
    source_block_ids: list[BlockId]
    covered_block_ids: list[BlockId]
    unclaimed_block_ids: list[BlockId]
    initial_claim_count: int
    review_addition_count: int
    assertions: list[SourceAssertion]
    object_fragments: list[ObjectFragment]
    model_calls: int


class FullSourceSemanticSnapshot(StrictModel):
    schema_version: Literal["source-semantics-full.v10"] = "source-semantics-full.v10"
    policy_version: Literal["source-semantics-policy.v5"]
    created_at: datetime
    source: SourceMetadata
    source_time_text: str | None
    source_time_supporting_block_ids: list[BlockId]
    region_tree_schema_version: str
    source_node_ids: list[str]
    sources: list[SourceSemanticSnapshot]
    total_assertions: int
    total_object_fragments: int
    total_surface_forms: int
    model_calls: int

    @field_validator("source_time_text")
    @classmethod
    def normalize_source_time_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = _normalize_source_time_text(value)
        if not normalized:
            raise ValueError("source_time_text 不能仅包含空白")
        return normalized

    @model_validator(mode="after")
    def validate_source_time_evidence(self) -> FullSourceSemanticSnapshot:
        if self.source_time_text is None and self.source_time_supporting_block_ids:
            raise ValueError(
                "source_time_text 为 null 时 source_time_supporting_block_ids 必须为空"
            )
        if self.source_time_text is not None and not self.source_time_supporting_block_ids:
            raise ValueError("非空 source_time_text 必须提供 source_time_supporting_block_ids")
        if len(set(self.source_time_supporting_block_ids)) != len(
            self.source_time_supporting_block_ids
        ):
            raise ValueError("source_time_supporting_block_ids 不能重复")
        return self


@dataclass(frozen=True)
class SourceSemanticPaths:
    directory: Path
    model_streams: Path
    initial_claims_json: Path
    reviewed_claims_json: Path
    object_fragments_json: Path
    snapshot_json: Path
    report_markdown: Path


@dataclass(frozen=True)
class FullSourceSemanticPaths:
    directory: Path
    model_streams: Path
    sources: Path
    source_time_json: Path
    working_json: Path
    snapshot_json: Path
    report_markdown: Path


ASSERTION_STAGE_CONTRACT = """
本阶段只决定当前 SourceRegion 明确表达了哪些 Assertion，不决定 Object、名称同指或跨来源身份。

- grounded：一个能被独立检索和理解的内聚知识单元。共享主体、条件、例外或步骤链且通常共同被
  查询的内容保持在一起；主题、来源或生命周期明显不同时再拆分。
- reference：指向表格、名单、分工或流程清单原文的检索入口，只说明可在那里继续读取什么，
  不复写全部内容。
- supporting_block_ids 只列直接支持该 Assertion 的当前原文块，并保持原文顺序。
- 保留条件、否定、数量、时间以及建议、计划、可能等语气。能够从当前句自然补全主语时写成
  context_dependent=false；需要跨句身份推断或复杂重建时保留原表达并写 true。

名称括注、简称和脚注身份说明继续留在原文中，交给 Fragment Construction。输出只包含 schema
规定的 JSON 字段；正文优先使用中文弯引号，字符串中的 ASCII 双引号必须合法转义。

只输出一个 JSON 对象：
{"claims":[{"kind":"grounded","statement_markdown":"完整命题","supporting_block_ids":["p0001-b0001"],"context_dependent":false}]}
""".strip()


CLAIM_EXTRACTION_SYSTEM_PROMPT = f"""
{ASSERTION_STAGE_CONTRACT}

按原文顺序完成第一次覆盖。目录、纯标题、承接语或只描述文档结构的文字自身不形成 grounded
Assertion。完成最后一个 block 后立即提交完整 JSON，不要解释判断过程。
""".strip()


CONSERVATIVE_ATOMIC_FALLBACK_SYSTEM_PROMPT = f"""
{ASSERTION_STAGE_CONTRACT}

上一轮在粒度选择上发生重复。本轮按 block 顺序处理一次，采用稳定的保守边界：两个拆法都合理时，
选择更接近原文、更完整的一种；不要继续拆解共享条件、目的链、因果链或省略主语。遗漏交给下一遍
检查。完成最后一个 block 后立即提交完整 JSON，不要寻找唯一最优方案。
""".strip()


MISSING_CLAIMS_SYSTEM_PROMPT = f"""
{ASSERTION_STAGE_CONTRACT}

本遍只做覆盖差分。已有 Assertion 已冻结；只返回原文明确支持、但尚未表达的完整新增 Assertion，
没有遗漏时返回空数组。已被内聚 Assertion 覆盖的列表项、条件、步骤和子结论不重复提交，也不重新
评价已有 Assertion 的写法、顺序或分类。完成检查后立即提交完整 JSON。
""".strip()


OBJECT_FRAGMENT_SYSTEM_PROMPT = """
你负责从当前 SourceRegion 与 frozen Assertions 中提取需要跨命题维持同一身份的 source-local
referent，并生成 Assertion templates。Fragment 只是交给 Resolver 的候选，不是最终 Global Object。

只有当两次出现是否指向“同一个对象或同一种业务类型”是有意义的问题时，才提取 Fragment。
人物、组织、角色、活动、地点、实物、设备、文件、制度、流程和稳定群体通常适用。仅作为其他
对象的属性、状态、情绪、评价或程度出现的内容保留在 Assertion 正文中。边界不清楚但确实可能
具有长期身份时才提交候选；不要把所有名词或可讨论的抽象概念都提升为 Fragment。

同一局部 referent 的真实全称、稳定简称、缩写或明确别名进入同一 Fragment。人物、角色、类别与
实例分别表达。原文明示的全称、简称、别名和脚注身份关系在本阶段直接判断。surface_forms 必须逐字
来自当前输入。
如果附加脚注明确说明某个称呼所指的人物，模板可把正文称呼绑定到脚注中的人物 Fragment；
surface_forms 只保留可脱离该句复用的名称。

identity_mode_hint 只描述候选如果最终成为 Object 时适用的身份判断方式，不证明 Objecthood：
- named_person：具体人物身份；
- role_type：可由不同人物担任的稳定角色；
- entity_type：活动、实物或其他可复用类别；
- named_entity：其他具名实例或稳定对象。
- undetermined：候选可能具有长期身份，但当前 Region 不足以判断其身份方式。
属性、状态、情绪、评价或程度不得仅因难以分类而标为 undetermined。

grounded Assertion 中已识别的 referent 用 {{fragment:F1}} 标记，semantic_fragment_keys 为 []。
Reference Assertion 保持导航正文，并用 semantic_fragment_keys 列出它实际覆盖的 Fragment。
assertions 按输入顺序恰好覆盖全部 claim_id，保留原命题的事实、条件、时间和语气。

完成当前 Region 后立即提交 JSON 正文，只包含：
- fragments：fragment_key、surface_forms、identity_mode_hint；
- assertions：claim_id、kind、statement_template_markdown、semantic_fragment_keys。
""".strip()


SOURCE_TIME_SYSTEM_PROMPT = """
你只负责从整份 Source 中保守提取一个来源自身明确提供的时间锚点。

Source Time 用来帮助系统理解这份来源处在什么历史位置，以及来源中的“目前”“本届”等相对
表达；它不表示来源中全部 Assertion 在该时点成立，也不是 Assertion validity。

只有成文日期、署名日期、修订日期或“截至……”等明确描述来源自身时间的文字才可以采用。
非空 source_time_text 必须能在 supporting_block_ids 的原文中直接找到，只允许必要的空白或格式
规整。证据不充分或候选互相冲突时返回 null。

严禁根据正文事件的最大年份推断；严禁使用文件系统时间、PDF metadata、上传时间、编译时间、
当前系统时间或外部知识。不要输出 start/end、precision、kind、basis 或 validity。

只输出一个严格 JSON 对象，不要输出 Markdown 代码块、解释或其他字段：
{"source_time_text":"2026年春","supporting_block_ids":["p0006-b0008"]}

没有可靠来源时间：
{"source_time_text":null,"supporting_block_ids":[]}
""".strip()


OutputModel = TypeVar("OutputModel", bound=BaseModel)


class SourceSemanticCompiler:
    """以三遍流程编译一个内容来源节点；第三遍生成 Leaf Fragment IR。"""

    def __init__(
        self,
        *,
        model: ChatModel,
        exploration: GlobalExplorationSnapshot,
        blocks: tuple[ParsedBlock, ...],
        paths: SourceSemanticPaths,
        progress: ProgressReporter | None = None,
    ) -> None:
        self.model = model
        self.exploration = exploration
        self.blocks = blocks
        self.paths = paths
        self.progress = progress or NullProgressReporter()
        self.index = BlockIndex(blocks)
        self.nodes = {node.node_id: node for node in exploration.region_tree.nodes}

    async def compile(self, source_node_id: str) -> SourceSemanticSnapshot:
        node = self._source_node(source_node_id)
        source_blocks = self._owned_blocks(node)
        cached = _load_current_source_snapshot(self.paths, source_blocks)
        if cached is not None:
            self._validate_checkpoint_identity(cached.source.sha256, cached.region_node_id, node)
            return cached

        lineage = self._lineage(node)
        source_prompt = _source_prompt(
            document_context=self.exploration.document_context_markdown,
            lineage=lineage,
            node=node,
            blocks=source_blocks,
        )
        label = f"来源语义·{node.node_id}"

        initial = self._load_claim_checkpoint(self.paths.initial_claims_json, node, source_blocks)
        rebuilt_initial = initial is None
        if initial is None:
            self.progress.report(label, "第一遍：开始提取内聚知识单元与 Reference")
            submission, initial_calls = await self._request_atomic_json(
                system_prompt=CLAIM_EXTRACTION_SYSTEM_PROMPT,
                user_prompt=source_prompt,
                output_model=AtomicClaimSubmission,
                request_label=f"{label}·Assertion Discovery",
                validate=lambda value: _validate_atomic_submission(value, source_blocks),
            )
            initial = self._claim_checkpoint(
                node,
                submission.claims,
                source_blocks=source_blocks,
                model_calls=initial_calls,
            )
            self._write_json(self.paths.initial_claims_json, initial)
        self.progress.report(
            label,
            f"第一遍完成：{len(initial.claims)} 条命题",
        )

        reviewed = None
        if not rebuilt_initial:
            reviewed = self._load_claim_checkpoint(
                self.paths.reviewed_claims_json, node, source_blocks
            )
        rebuilt_reviewed = reviewed is None
        if reviewed is None:
            self.progress.report(label, "第二遍：只检查遗漏命题")
            additions, review_calls = await self._request_json(
                system_prompt=MISSING_CLAIMS_SYSTEM_PROMPT,
                user_prompt=_review_prompt(source_prompt, initial.claims),
                output_model=MissingClaimSubmission,
                request_label=f"{label}·遗漏扫描",
                validate=lambda value: _validate_missing_claims(
                    value, initial.claims, source_blocks
                ),
            )
            reviewed = self._claim_checkpoint(
                node,
                _merge_claims(initial.claims, additions.claims),
                source_blocks=source_blocks,
                model_calls=review_calls,
            )
            self._write_json(self.paths.reviewed_claims_json, reviewed)
        review_additions = max(0, len(reviewed.claims) - len(initial.claims))
        self.progress.report(
            label,
            f"第二遍完成：新增 {review_additions} 条命题",
        )

        object_fragments = None
        if not rebuilt_reviewed:
            object_fragments = self._load_object_fragments_checkpoint(
                node,
                reviewed.claims,
                source_blocks,
            )
        if object_fragments is None:
            self.progress.report(label, "第三遍：开始构造 Object Fragment 与命题模板")
            submission, fragment_calls = await self._request_json(
                system_prompt=OBJECT_FRAGMENT_SYSTEM_PROMPT,
                user_prompt=_fragment_prompt(
                    source_prompt,
                    reviewed.claims,
                ),
                output_model=ObjectFragmentSubmission,
                request_label=f"{label}·Object Fragment Construction",
                validate=lambda value: _validate_fragment_submission(
                    value,
                    reviewed.claims,
                    source_blocks=source_blocks,
                ),
            )
            fragments, assertions = _materialize_fragments(
                submission,
                reviewed.claims,
                source_region_id=node.node_id,
            )
            object_fragments = SourceObjectFragmentCheckpoint(
                policy_version=FRAGMENT_POLICY_VERSION,
                source_sha256=self.exploration.source.sha256,
                region_node_id=node.node_id,
                fragments=fragments,
                assertions=assertions,
                model_calls=fragment_calls,
            )
            self._write_json(self.paths.object_fragments_json, object_fragments)
        self.progress.report(
            label,
            (
                f"第三遍完成：{len(object_fragments.fragments)} 个 Object Fragment，"
                f"{sum(len(item.surface_forms) for item in object_fragments.fragments)} 个名称"
            ),
        )

        covered = _covered_block_ids(
            reviewed.claims,
            source_blocks,
        )
        source_ids = [block.block_id for block in source_blocks]
        model_calls = initial.model_calls + reviewed.model_calls + object_fragments.model_calls
        snapshot = SourceSemanticSnapshot(
            policy_version=SOURCE_SEMANTIC_POLICY_VERSION,
            created_at=datetime.now(UTC),
            source=self.exploration.source,
            region_tree_schema_version=self.exploration.region_tree.schema_version,
            region_node_id=node.node_id,
            label=node.label,
            lineage_node_ids=[item.node_id for item in lineage],
            source_pages=sorted({page for block in source_blocks for page in block.source_pages}),
            source_block_ids=source_ids,
            covered_block_ids=covered,
            unclaimed_block_ids=[item for item in source_ids if item not in covered],
            initial_claim_count=len(initial.claims),
            review_addition_count=review_additions,
            assertions=object_fragments.assertions,
            object_fragments=object_fragments.fragments,
            model_calls=model_calls,
        )
        self._write_json(self.paths.snapshot_json, snapshot)
        self.paths.report_markdown.write_text(
            _render_report(snapshot, source_blocks), encoding="utf-8"
        )
        self.progress.report(
            label,
            (
                f"完成：命题 {len(snapshot.assertions)}，"
                f"Object Fragment {len(snapshot.object_fragments)}，"
                f"本次模型调用 {model_calls} 次"
            ),
        )
        return snapshot

    async def _request_atomic_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        output_model: type[OutputModel],
        request_label: str,
        validate: Callable[[OutputModel], None] | None = None,
    ) -> tuple[OutputModel, int]:
        """Atomic repetition 使用一次保守 fallback，普通错误仍使用 clean retry。"""

        try:
            parsed = await self._request_json_once(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                output_model=output_model,
                request_label=request_label,
                validate=validate,
            )
            return parsed, 1
        except ModelRepetitionError:
            fallback_label = f"{request_label}·Atomic-Conservative-Fallback"
            self.progress.report(
                request_label,
                "检测到 Atomic reasoning 重复，改用唯一一次保守 fallback",
            )
            try:
                parsed = await self._request_json_once(
                    system_prompt=CONSERVATIVE_ATOMIC_FALLBACK_SYSTEM_PROMPT,
                    user_prompt=user_prompt,
                    output_model=output_model,
                    request_label=fallback_label,
                    validate=validate,
                )
            except (ModelRepetitionError, ValueError) as error:
                raise ModelOutputError(
                    f"{fallback_label}失败且不再重试：{_short_validation_error(error)}"
                ) from error
            return parsed, 2
        except ValueError as first_error:
            retry_note = (
                "\n\n上一次提交未通过确定性校验："
                f"{_short_validation_error(first_error)}\n"
                "请仅根据原始输入重新生成一次；不要复述或修补上一次正文。"
            )
            self.progress.report(
                request_label,
                f"输出校验失败，进行唯一一次 clean retry：{_short_validation_error(first_error)}",
            )
            try:
                parsed = await self._request_json_once(
                    system_prompt=system_prompt + retry_note,
                    user_prompt=user_prompt,
                    output_model=output_model,
                    request_label=f"{request_label}·clean-retry",
                    validate=validate,
                )
            except (ModelRepetitionError, ValueError) as error:
                raise ModelOutputError(
                    f"{request_label}初次输出和唯一一次 clean retry 均失败："
                    f"{_short_validation_error(error)}"
                ) from error
            return parsed, 2

    async def _request_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        output_model: type[OutputModel],
        request_label: str,
        validate: Callable[[OutputModel], None] | None = None,
    ) -> tuple[OutputModel, int]:
        """每个语义阶段最多进行一次 clean retry。"""

        last_error: Exception | None = None
        for attempt in range(1, 3):
            retry_note = ""
            if last_error is not None:
                retry_note = (
                    "\n\n上一次提交未通过确定性校验："
                    f"{_short_validation_error(last_error)}\n"
                    "请仅根据原始输入重新生成一次；不要复述或修补上一次正文。"
                )
                self.progress.report(
                    request_label,
                    f"输出校验失败，进行唯一一次 clean retry："
                    f"{_short_validation_error(last_error)}",
                )
            try:
                parsed = await self._request_json_once(
                    system_prompt=system_prompt + retry_note,
                    user_prompt=user_prompt,
                    output_model=output_model,
                    request_label=(
                        request_label if attempt == 1 else f"{request_label}·clean-retry"
                    ),
                    validate=validate,
                )
                return parsed, attempt
            except (ModelRepetitionError, ValueError) as error:
                last_error = error
        assert last_error is not None
        raise ModelOutputError(
            f"{request_label}初次输出和唯一一次 clean retry 均失败："
            f"{_short_validation_error(last_error)}"
        ) from last_error

    async def _request_json_once(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        output_model: type[OutputModel],
        request_label: str,
        validate: Callable[[OutputModel], None] | None = None,
    ) -> OutputModel:
        turn = await self.model.complete_turn(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            request_label=request_label,
            thinking="enabled",
        )
        try:
            if turn.tool_calls or not turn.content:
                raise ValueError(f"{request_label}没有返回 JSON 正文")
            normalized = normalize_json_document(turn.content)
            parsed = output_model.model_validate_json(normalized)
            if validate is not None:
                validate(parsed)
        except Exception:
            reject_model_turn(self.model, turn)
            raise
        commit_model_turn(self.model, turn)
        return parsed

    def _source_node(self, node_id: str) -> RegionNode:
        if node_id not in self.nodes:
            raise ValueError(f"区域树中不存在节点 {node_id}")
        node = self.nodes[node_id]
        if node.owned_source_role != "content_source" or not node.owned_segments:
            raise ValueError(f"{node_id} 没有可编译的 content_source 自有原文")
        return node

    def _lineage(self, node: RegionNode) -> list[RegionNode]:
        lineage: list[RegionNode] = []
        parent_id = node.parent_id
        while parent_id:
            parent = self.nodes[parent_id]
            lineage.append(parent)
            parent_id = parent.parent_id
        return list(reversed(lineage))

    def _owned_blocks(self, node: RegionNode) -> tuple[ParsedBlock, ...]:
        return _semantic_blocks_for_node(self.index, node)

    def _claim_checkpoint(
        self,
        node: RegionNode,
        claims: Sequence[AtomicClaimDraft | SourceClaim],
        *,
        source_blocks: Sequence[ParsedBlock],
        model_calls: int,
    ) -> SourceClaimCheckpoint:
        normalized = [
            SourceClaim(
                claim_id=f"claim-{position}",
                kind=item.kind,
                statement_markdown=item.statement_markdown.strip(),
                supporting_block_ids=list(dict.fromkeys(item.supporting_block_ids)),
                context_dependent=item.context_dependent,
            )
            for position, item in enumerate(claims, start=1)
        ]
        _validate_claim_blocks(normalized, source_blocks)
        return SourceClaimCheckpoint(
            policy_version=CLAIM_POLICY_VERSION,
            source_sha256=self.exploration.source.sha256,
            region_node_id=node.node_id,
            claims=normalized,
            model_calls=model_calls,
        )

    def _load_claim_checkpoint(
        self,
        path: Path,
        node: RegionNode,
        source_blocks: Sequence[ParsedBlock],
    ) -> SourceClaimCheckpoint | None:
        if not path.exists():
            return None
        raw = json.loads(path.read_text(encoding="utf-8"))
        if (
            not isinstance(raw, dict)
            or raw.get("schema_version") != "source-claims.v8"
            or raw.get("policy_version") != CLAIM_POLICY_VERSION
        ):
            return None
        checkpoint = SourceClaimCheckpoint.model_validate(raw)
        self._validate_checkpoint_identity(
            checkpoint.source_sha256, checkpoint.region_node_id, node
        )
        _validate_claim_blocks(checkpoint.claims, source_blocks)
        return checkpoint

    def _load_object_fragments_checkpoint(
        self,
        node: RegionNode,
        claims: Sequence[SourceClaim],
        source_blocks: Sequence[ParsedBlock],
    ) -> SourceObjectFragmentCheckpoint | None:
        if not self.paths.object_fragments_json.exists():
            return None
        raw = json.loads(self.paths.object_fragments_json.read_text(encoding="utf-8"))
        if (
            not isinstance(raw, dict)
            or raw.get("schema_version") != "source-object-fragments.v6"
            or raw.get("policy_version") != FRAGMENT_POLICY_VERSION
        ):
            return None
        try:
            checkpoint = SourceObjectFragmentCheckpoint.model_validate(raw)
            self._validate_checkpoint_identity(
                checkpoint.source_sha256, checkpoint.region_node_id, node
            )
            _validate_fragment_checkpoint(
                checkpoint,
                claims,
                source_blocks=source_blocks,
            )
            return checkpoint
        except (ValidationError, ValueError):
            return None

    def _validate_checkpoint_identity(
        self,
        source_sha256: str,
        region_node_id: str,
        node: RegionNode,
    ) -> None:
        if source_sha256 != self.exploration.source.sha256:
            raise ValueError("阶段断点属于另一份来源文件")
        if region_node_id != node.node_id:
            raise ValueError("阶段断点属于另一个来源节点")

    @staticmethod
    def _write_json(path: Path, value: BaseModel) -> None:
        path.write_text(value.model_dump_json(indent=2), encoding="utf-8")


class FullSourceSemanticRunner:
    """并行编译区域树中的全部内容来源，并复用每个来源的阶段断点。"""

    def __init__(
        self,
        *,
        model: ChatModel,
        exploration: GlobalExplorationSnapshot,
        blocks: tuple[ParsedBlock, ...],
        paths: FullSourceSemanticPaths,
        max_parallel_sources: int,
        source_node_ids: Sequence[str] | None = None,
        on_available: Callable[[FullSourceSemanticSnapshot, bool], Awaitable[None]] | None = None,
        progress: ProgressReporter | None = None,
    ) -> None:
        if max_parallel_sources < 1:
            raise ValueError("max_parallel_sources 必须大于 0")
        self.model = model
        self.exploration = exploration
        self.blocks = blocks
        self.paths = paths
        self.max_parallel_sources = max_parallel_sources
        self.requested_source_node_ids = tuple(source_node_ids or ())
        self.on_available = on_available
        self.progress = progress or NullProgressReporter()
        self.nodes = {node.node_id: node for node in exploration.region_tree.nodes}
        self.index = BlockIndex(blocks)
        self.errors: dict[str, str] = {}
        self._working_lock = asyncio.Lock()
        self._availability_lock = asyncio.Lock()
        self._available_count = -1

    async def run(self) -> FullSourceSemanticSnapshot:
        if self.exploration.region_tree.status != "frozen":
            raise ValueError("区域树尚未冻结，不能开始全部来源语义编译")
        cached = _load_current_full_snapshot(self.paths.snapshot_json)
        if cached is not None:
            source_time = self._load_source_time_checkpoint()
            if source_time is not None:
                self.paths.source_time_json.write_text(
                    source_time.model_dump_json(indent=2), encoding="utf-8"
                )
            self.paths.snapshot_json.write_text(cached.model_dump_json(indent=2), encoding="utf-8")
            self.paths.report_markdown.write_text(_render_full_report(cached), encoding="utf-8")
            if self.on_available is not None:
                await self.on_available(cached, True)
            return cached

        available_source_ids = [
            node_id
            for node_id in self.exploration.region_tree.content_node_ids
            if self.nodes[node_id].owned_source_role == "content_source"
            and self.nodes[node_id].owned_segments
            and _semantic_blocks_for_node(self.index, self.nodes[node_id])
        ]
        source_ids = self._select_source_ids(available_source_ids)
        self._validate_resume(source_ids)
        source_time = self._load_source_time_checkpoint()
        if source_time is None:
            self.progress.report("Source Time", "开始整份来源的一次保守时间锚点提取")
            source_time = await self._extract_source_time()
        self.paths.source_time_json.write_text(
            source_time.model_dump_json(indent=2), encoding="utf-8"
        )
        self.progress.report(
            "Source Time",
            (
                f"完成：{source_time.source_time_text}｜证据 "
                f"{', '.join(source_time.supporting_block_ids)}"
                if source_time.source_time_text is not None
                else "完成：来源未提供足够明确的时间锚点"
            ),
        )
        completed = [
            node_id
            for node_id in source_ids
            if _load_current_source_snapshot(_source_paths(self.paths, node_id)) is not None
        ]
        self.progress.report(
            "全部来源语义",
            (
                f"来源共 {len(source_ids)} 个，复用已完成 {len(completed)} 个；"
                f"并发上限 {self.max_parallel_sources}"
            ),
        )
        self._write_working(source_ids)
        await self._notify_available(source_ids, source_time)
        semaphore = asyncio.Semaphore(self.max_parallel_sources)

        async def compile_one(position: int, node_id: str) -> SourceSemanticSnapshot:
            async with semaphore:
                self.progress.report(
                    "全部来源语义",
                    f"开始 {position}/{len(source_ids)}：{node_id}",
                )
                compiler = SourceSemanticCompiler(
                    model=self.model,
                    exploration=self.exploration,
                    blocks=self.blocks,
                    paths=_source_paths(self.paths, node_id),
                    progress=self.progress,
                )
                try:
                    snapshot = await compiler.compile(node_id)
                except Exception as error:
                    self.errors[node_id] = str(error)
                    async with self._working_lock:
                        self._write_working(source_ids)
                    raise
                self.errors.pop(node_id, None)
                async with self._working_lock:
                    self._write_working(source_ids)
                await self._notify_available(source_ids, source_time)
                return snapshot

        outcomes = await asyncio.gather(
            *(
                compile_one(position, node_id)
                for position, node_id in enumerate(source_ids, start=1)
            ),
            return_exceptions=True,
        )
        failed_outcomes = [
            (node_id, outcome)
            for node_id, outcome in zip(source_ids, outcomes, strict=True)
            if isinstance(outcome, BaseException)
        ]
        self._write_working(source_ids)
        if failed_outcomes:
            summary = "；".join(
                f"{node_id}：{outcome}" for node_id, outcome in failed_outcomes
            )
            # Keep a concrete leaf failure in the cause chain so the CLI can classify it.
            raise RuntimeError("来源语义编译失败：" + summary) from failed_outcomes[0][1]

        snapshots = [outcome for outcome in outcomes if isinstance(outcome, SourceSemanticSnapshot)]
        full = self._full_snapshot(source_ids, snapshots, source_time)
        self.paths.snapshot_json.write_text(full.model_dump_json(indent=2), encoding="utf-8")
        self.paths.report_markdown.write_text(_render_full_report(full), encoding="utf-8")
        if self.on_available is not None:
            await self.on_available(full, True)
        self.progress.report(
            "全部来源语义",
            (
                f"完成：来源 {len(snapshots)}，命题 {full.total_assertions}，"
                f"Object Fragment {full.total_object_fragments}，"
                f"模型调用 {full.model_calls} 次"
            ),
        )
        return full

    async def _notify_available(
        self,
        source_ids: Sequence[str],
        source_time: SourceTimeCheckpoint,
    ) -> None:
        if self.on_available is None:
            return
        async with self._availability_lock:
            snapshots: list[SourceSemanticSnapshot] = []
            for node_id in source_ids:
                snapshot = _load_current_source_snapshot(_source_paths(self.paths, node_id))
                if snapshot is None:
                    break
                snapshots.append(snapshot)
            if len(snapshots) == self._available_count:
                return
            self._available_count = len(snapshots)
            if snapshots:
                await self.on_available(
                    self._full_snapshot(source_ids, snapshots, source_time),
                    False,
                )

    def _full_snapshot(
        self,
        source_ids: Sequence[str],
        snapshots: Sequence[SourceSemanticSnapshot],
        source_time: SourceTimeCheckpoint,
    ) -> FullSourceSemanticSnapshot:
        return FullSourceSemanticSnapshot(
            policy_version=SOURCE_SEMANTIC_POLICY_VERSION,
            created_at=datetime.now(UTC),
            source=self.exploration.source,
            source_time_text=source_time.source_time_text,
            source_time_supporting_block_ids=source_time.supporting_block_ids,
            region_tree_schema_version=self.exploration.region_tree.schema_version,
            source_node_ids=list(source_ids),
            sources=list(snapshots),
            total_assertions=sum(len(item.assertions) for item in snapshots),
            total_object_fragments=sum(len(item.object_fragments) for item in snapshots),
            total_surface_forms=sum(
                len(fragment.surface_forms)
                for item in snapshots
                for fragment in item.object_fragments
            ),
            model_calls=(source_time.model_calls + sum(item.model_calls for item in snapshots)),
        )

    async def _extract_source_time(self) -> SourceTimeCheckpoint:
        user_prompt = _source_time_prompt(self.exploration.source, self.blocks)
        last_error: Exception | None = None
        for attempt in range(1, 3):
            retry_note = ""
            if last_error is not None:
                retry_note = (
                    "\n\n上一次提交未通过确定性校验："
                    f"{_short_validation_error(last_error)}\n"
                    "请从原始全文重新判断一次，不要修补上一次正文。"
                )
                self.progress.report(
                    "Source Time",
                    "输出校验失败，进行唯一一次 clean retry："
                    + _short_validation_error(last_error),
                )
            try:
                turn = await self.model.complete_turn(
                    messages=[
                        {
                            "role": "system",
                            "content": SOURCE_TIME_SYSTEM_PROMPT + retry_note,
                        },
                        {"role": "user", "content": user_prompt},
                    ],
                    request_label=("Source Time" if attempt == 1 else "Source Time·clean-retry"),
                    thinking="enabled",
                )
                try:
                    if turn.tool_calls or not turn.content:
                        raise ValueError("Source Time 没有返回 JSON 正文")
                    submission = SourceTimeSubmission.model_validate_json(
                        normalize_json_document(turn.content)
                    )
                    _validate_source_time(submission, self.blocks)
                except Exception:
                    reject_model_turn(self.model, turn)
                    raise
                commit_model_turn(self.model, turn)
                return SourceTimeCheckpoint(
                    source_sha256=self.exploration.source.sha256,
                    source_time_text=submission.source_time_text,
                    supporting_block_ids=submission.supporting_block_ids,
                    model_calls=attempt,
                )
            except (ModelRepetitionError, ValidationError, ValueError) as error:
                last_error = error
        assert last_error is not None
        raise ModelOutputError(
            "Source Time 初次输出和唯一一次 clean retry 均失败："
            + _short_validation_error(last_error)
        ) from last_error

    def _load_source_time_checkpoint(self) -> SourceTimeCheckpoint | None:
        if not self.paths.source_time_json.exists():
            return None
        raw = json.loads(self.paths.source_time_json.read_text(encoding="utf-8"))
        if not isinstance(raw, dict) or raw.get("schema_version") != "source-time.v1":
            return None
        checkpoint = SourceTimeCheckpoint.model_validate(raw)
        if checkpoint.source_sha256 != self.exploration.source.sha256:
            raise ValueError("Source Time 断点属于另一份来源文件")
        _validate_source_time(checkpoint, self.blocks)
        return checkpoint

    def _select_source_ids(self, available: Sequence[str]) -> list[str]:
        if not self.requested_source_node_ids:
            return list(available)
        requested = set(self.requested_source_node_ids)
        unknown = requested - set(available)
        if unknown:
            raise ValueError(
                "--source-id 不是可编译的 content_source 节点：" + ", ".join(sorted(unknown))
            )
        return [node_id for node_id in available if node_id in requested]

    def _validate_resume(self, source_ids: Sequence[str]) -> None:
        if not self.paths.working_json.exists():
            return
        raw = json.loads(self.paths.working_json.read_text(encoding="utf-8"))
        version = raw.get("schema_version") if isinstance(raw, dict) else None
        if version != "source-semantics-working.v10":
            raise ValueError(f"不支持的来源语义工作断点版本：{version}")
        if raw.get("policy_version") != SOURCE_SEMANTIC_POLICY_VERSION:
            raise ValueError("来源语义工作断点使用了不同的编译策略版本")
        if raw.get("source_sha256") != self.exploration.source.sha256:
            raise ValueError("批量恢复目录属于另一份来源文件")
        if raw.get("source_node_ids") != list(source_ids):
            raise ValueError("批量恢复目录使用了不同的区域树内容来源集合")

    def _write_working(self, source_ids: Sequence[str]) -> None:
        stages: list[SourceStageStatus] = []
        for node_id in source_ids:
            paths = _source_paths(self.paths, node_id)
            complete = _load_current_source_snapshot(paths) is not None
            stages.append(
                SourceStageStatus(
                    source_node_id=node_id,
                    initial_claims=paths.initial_claims_json.exists(),
                    reviewed_claims=paths.reviewed_claims_json.exists(),
                    object_fragments=paths.object_fragments_json.exists(),
                    complete=complete,
                    error=self.errors.get(node_id),
                )
            )
        working = FullSourceSemanticWorking(
            policy_version=SOURCE_SEMANTIC_POLICY_VERSION,
            source_sha256=self.exploration.source.sha256,
            source_node_ids=list(source_ids),
            source_time=self._load_source_time_checkpoint() is not None,
            stages=stages,
        )
        self.paths.working_json.write_text(working.model_dump_json(indent=2), encoding="utf-8")


def create_source_semantic_paths(
    run_directory: Path,
    source_node_id: str,
) -> SourceSemanticPaths:
    directory = (
        run_directory.expanduser().resolve()
        / "source-semantic-compilations"
        / f"{datetime.now(UTC):%Y%m%dT%H%M%S%fZ}-{source_node_id}"
    )
    directory.mkdir(parents=True, exist_ok=False)
    model_streams = directory / "model-streams"
    model_streams.mkdir()
    return _paths(directory)


def open_source_semantic_paths(directory: Path) -> SourceSemanticPaths:
    resolved = directory.expanduser().resolve()
    if not resolved.is_dir():
        raise ValueError(f"来源语义编译目录不存在：{resolved}")
    model_streams = resolved / "model-streams"
    model_streams.mkdir(exist_ok=True)
    return _paths(resolved)


def create_full_source_semantic_paths(run_directory: Path) -> FullSourceSemanticPaths:
    directory = (
        run_directory.expanduser().resolve()
        / "source-semantic-compilations"
        / f"{datetime.now(UTC):%Y%m%dT%H%M%S%fZ}-full"
    )
    directory.mkdir(parents=True, exist_ok=False)
    model_streams = directory / "model-streams"
    sources = directory / "sources"
    model_streams.mkdir()
    sources.mkdir()
    return _full_paths(directory)


def open_full_source_semantic_paths(directory: Path) -> FullSourceSemanticPaths:
    resolved = directory.expanduser().resolve()
    if not resolved.is_dir():
        raise ValueError(f"全部来源语义编译目录不存在：{resolved}")
    model_streams = resolved / "model-streams"
    sources = resolved / "sources"
    model_streams.mkdir(exist_ok=True)
    sources.mkdir(exist_ok=True)
    return _full_paths(resolved)


def _paths(directory: Path, *, model_streams: Path | None = None) -> SourceSemanticPaths:
    return SourceSemanticPaths(
        directory=directory,
        model_streams=model_streams or directory / "model-streams",
        initial_claims_json=directory / "01-initial-claims.json",
        reviewed_claims_json=directory / "02-reviewed-claims.json",
        object_fragments_json=directory / "03-object-fragments.json",
        snapshot_json=directory / "source-semantics.json",
        report_markdown=directory / "source-semantics.md",
    )


def _full_paths(directory: Path) -> FullSourceSemanticPaths:
    return FullSourceSemanticPaths(
        directory=directory,
        model_streams=directory / "model-streams",
        sources=directory / "sources",
        source_time_json=directory / "source-time.json",
        working_json=directory / "working.json",
        snapshot_json=directory / "source-semantics-full.json",
        report_markdown=directory / "source-semantics-full.md",
    )


def _source_paths(paths: FullSourceSemanticPaths, node_id: str) -> SourceSemanticPaths:
    directory = paths.sources / node_id
    directory.mkdir(parents=True, exist_ok=True)
    return _paths(directory, model_streams=paths.model_streams)


def _load_current_source_snapshot(
    paths: SourceSemanticPaths,
    source_blocks: Sequence[ParsedBlock] | None = None,
) -> SourceSemanticSnapshot | None:
    if not paths.snapshot_json.exists() or not paths.object_fragments_json.exists():
        return None
    if not paths.initial_claims_json.exists() or not paths.reviewed_claims_json.exists():
        return None
    initial_raw = json.loads(paths.initial_claims_json.read_text(encoding="utf-8"))
    if (
        not isinstance(initial_raw, dict)
        or initial_raw.get("schema_version") != "source-claims.v8"
        or initial_raw.get("policy_version") != CLAIM_POLICY_VERSION
    ):
        return None
    try:
        initial = SourceClaimCheckpoint.model_validate(initial_raw)
        if source_blocks is not None:
            _validate_claim_blocks(initial.claims, source_blocks)
    except ValidationError:
        return None
    except ValueError:
        return None
    reviewed_raw = json.loads(paths.reviewed_claims_json.read_text(encoding="utf-8"))
    if (
        not isinstance(reviewed_raw, dict)
        or reviewed_raw.get("schema_version") != "source-claims.v8"
        or reviewed_raw.get("policy_version") != CLAIM_POLICY_VERSION
    ):
        return None
    try:
        reviewed = SourceClaimCheckpoint.model_validate(reviewed_raw)
        if reviewed.source_sha256 != initial.source_sha256:
            return None
        if reviewed.region_node_id != initial.region_node_id:
            return None
        if source_blocks is not None:
            _validate_claim_blocks(reviewed.claims, source_blocks)
    except ValidationError:
        return None
    except ValueError:
        return None
    raw = json.loads(paths.snapshot_json.read_text(encoding="utf-8"))
    if (
        not isinstance(raw, dict)
        or raw.get("schema_version") != "source-semantics.v10"
        or raw.get("policy_version") != SOURCE_SEMANTIC_POLICY_VERSION
    ):
        return None
    try:
        snapshot = SourceSemanticSnapshot.model_validate(raw)
        _validate_snapshot_fragments(snapshot, reviewed, source_blocks=source_blocks)
        return snapshot
    except ValidationError:
        return None
    except ValueError:
        return None


def _load_current_full_snapshot(path: Path) -> FullSourceSemanticSnapshot | None:
    if not path.exists():
        return None
    raw = json.loads(path.read_text(encoding="utf-8"))
    if (
        not isinstance(raw, dict)
        or raw.get("schema_version") != "source-semantics-full.v10"
        or raw.get("policy_version") != SOURCE_SEMANTIC_POLICY_VERSION
    ):
        return None
    try:
        return FullSourceSemanticSnapshot.model_validate(raw)
    except ValidationError:
        return None


def _source_prompt(
    *,
    document_context: str,
    lineage: Sequence[RegionNode],
    node: RegionNode,
    blocks: tuple[ParsedBlock, ...],
) -> str:
    path = "\n".join(
        f"- {item.node_id}｜{item.label}：{item.introduction}" for item in [*lineage, node]
    )
    return f"""
[STAGE: extract_cohesive_source_assertions]

文档背景（只用于理解简称和省略，不能作为新命题依据）：
{document_context}

区域路径（只用于理解当前原文的主题和省略主语）：
{path}

当前来源原文（唯一事实依据）：
{format_blocks(blocks)}
""".strip()


def _semantic_blocks_for_node(
    index: BlockIndex,
    node: RegionNode,
) -> tuple[ParsedBlock, ...]:
    """Return primary Region blocks plus parser-linked auxiliary evidence."""

    physical: list[ParsedBlock] = []
    for segment in node.owned_segments:
        physical.extend(index.slice(segment.start_block_id, segment.end_block_id))
    linked_evidence_ids = attached_evidence_block_ids(index.blocks)
    by_id = {block.block_id: block for block in index.blocks}
    semantic: list[ParsedBlock] = []
    seen: set[str] = set()
    for block in physical:
        if block.block_id in linked_evidence_ids or block.block_id in seen:
            continue
        semantic.append(block)
        seen.add(block.block_id)
        for evidence in block.attached_evidence:
            if evidence.block_id in seen:
                continue
            target = by_id.get(evidence.block_id)
            if target is None:
                raise ValueError(
                    f"{block.block_id} 引用了不存在的附加证据 {evidence.block_id}"
                )
            semantic.append(target)
            seen.add(target.block_id)
    return tuple(semantic)


def _review_prompt(source_prompt: str, claims: Sequence[SourceClaim]) -> str:
    rendered = (
        "\n".join(
            (
                f"- {item.claim_id}｜kind={item.kind}｜{item.statement_markdown}｜"
                f"context_dependent={str(item.context_dependent).lower()}｜"
                f"依据 {', '.join(item.supporting_block_ids)}"
            )
            for item in claims
        )
        or "（第一次没有提取出命题）"
    )
    return f"""
[STAGE: find_missing_source_assertions]

第一次阅读材料：
{source_prompt}

已经冻结的命题：
{rendered}

只报告遗漏的新增命题，不要重新输出或修改以上命题。
""".strip()


def _fragment_prompt(
    source_prompt: str,
    claims: Sequence[SourceClaim],
) -> str:
    rendered = (
        "\n".join(
            (
                f"- {item.claim_id}｜kind={item.kind}｜{item.statement_markdown}｜"
                f"context_dependent={str(item.context_dependent).lower()}"
            )
            for item in claims
        )
        or "（当前来源没有现实命题；assertions 必须为空，但仍可从命名语境构造 Fragment）"
    )
    return f"""
[STAGE: construct_object_fragments]

来源上下文：
{source_prompt}

已经冻结的命题：
{rendered}

一次完成 source-local referent 分组与所有命题的 Fragment template。名称括注、简称和
附加脚注都直接在当前原文中判断，不依赖上一阶段提供身份结论。
""".strip()


def _source_time_prompt(source: SourceMetadata, blocks: Sequence[ParsedBlock]) -> str:
    rendered_blocks = format_blocks(list(blocks))
    if len(rendered_blocks) > 200_000:
        raise ValueError(
            "整份 Source 超过 Source Time 单次调用的安全上下文预算；本轮不会退化为逐区域时间提取"
        )
    return f"""
[STAGE: extract_source_time]

来源标题：{source.title}
来源路径仅用于标识，不是时间证据：{source.path}

整份来源原文（唯一时间证据）：
{rendered_blocks}
""".strip()


def _source_time_comparable(value: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", value))


def _validate_source_time(
    submission: SourceTimeSubmission,
    blocks: Sequence[ParsedBlock],
) -> None:
    block_by_id = {item.block_id: item for item in blocks}
    evidence = []
    for block_id in submission.supporting_block_ids:
        block = block_by_id.get(block_id)
        if block is None:
            raise ValueError(f"Source Time 引用了不存在的 SourceBlock：{block_id}")
        evidence.append(block)
    if [item.order for item in evidence] != sorted(item.order for item in evidence):
        raise ValueError("Source Time supporting_block_ids 必须按原文顺序排列")
    if submission.source_time_text is None:
        return
    expected = _source_time_comparable(submission.source_time_text)
    if not expected or not any(
        expected in _source_time_comparable(item.markdown) for item in evidence
    ):
        raise ValueError(
            "source_time_text 必须能在至少一个 supporting SourceBlock 中直接找到，"
            "只允许空白或 Unicode 格式规整"
        )


def _validate_snapshot_fragments(
    snapshot: SourceSemanticSnapshot,
    reviewed: SourceClaimCheckpoint,
    *,
    source_blocks: Sequence[ParsedBlock] | None = None,
) -> None:
    """确认当前快照仍满足 reviewed claims 与当前 Fragment 协议。"""

    if snapshot.source.sha256 != reviewed.source_sha256:
        raise ValueError("最终快照与 reviewed claims 断点属于不同来源")
    if snapshot.region_node_id != reviewed.region_node_id:
        raise ValueError("最终快照与 reviewed claims 断点属于不同来源节点")
    checkpoint = SourceObjectFragmentCheckpoint(
        policy_version=FRAGMENT_POLICY_VERSION,
        source_sha256=snapshot.source.sha256,
        region_node_id=snapshot.region_node_id,
        fragments=snapshot.object_fragments,
        assertions=[
            SourceAssertion(
                claim_id=item.claim_id,
                kind=item.kind,
                statement_template_markdown=item.statement_template_markdown,
                semantic_fragment_ids=item.semantic_fragment_ids,
                supporting_block_ids=item.supporting_block_ids,
                context_dependent=item.context_dependent,
            )
            for item in snapshot.assertions
        ],
        model_calls=0,
    )
    _validate_fragment_checkpoint(
        checkpoint,
        reviewed.claims,
        source_blocks=source_blocks or (),
        validate_surface_grounding=source_blocks is not None,
    )


def _validate_claim_blocks(
    claims: Sequence[AtomicClaimDraft | SourceClaim],
    source_blocks: Sequence[ParsedBlock],
) -> None:
    allowed = {block.block_id for block in source_blocks}
    for position, claim in enumerate(claims, start=1):
        unknown = set(claim.supporting_block_ids) - allowed
        if unknown:
            claim_label = getattr(claim, "claim_id", f"第 {position} 条命题草稿")
            raise ValueError(
                f"{claim_label} 引用了当前来源之外的原文块：{', '.join(sorted(unknown))}"
            )


def _validate_atomic_submission(
    submission: AtomicClaimSubmission,
    source_blocks: Sequence[ParsedBlock],
) -> None:
    _validate_claim_blocks(submission.claims, source_blocks)


def _short_validation_error(error: Exception) -> str:
    if isinstance(error, ModelRepetitionError):
        return "检测到模型输出重复"
    if isinstance(error, ValidationError):
        first = error.errors(include_input=False)[0]
        location = ".".join(map(str, first.get("loc", ()))) or "JSON"
        message = str(first.get("msg", first.get("type", "校验失败")))
        return f"{location}: {message}"[:500]
    return re.sub(r"\s+", " ", str(error)).strip()[:500] or type(error).__name__


_FRAGMENT_REFERENCE_PATTERN = re.compile(r"\{\{fragment:([^{}]+)\}\}")


def _fragment_reference_ids(template: str) -> list[str]:
    references = [match.group(1) for match in _FRAGMENT_REFERENCE_PATTERN.finditer(template)]
    remainder = _FRAGMENT_REFERENCE_PATTERN.sub("", template)
    if "{{fragment:" in remainder:
        raise ValueError("statement_template_markdown 包含不完整的 Fragment 引用")
    if "{{object:" in template:
        raise ValueError("Leaf IR 不能提前引用 Global Object")
    return list(dict.fromkeys(references))


def _fragment_grounding_texts(
    source_blocks: Sequence[ParsedBlock],
    claims: Sequence[SourceClaim],
) -> tuple[str, ...]:
    """返回 Fragment surface form 允许逐字取自的当前编译上下文。"""

    return (
        *(block.markdown for block in source_blocks),
        *(claim.statement_markdown for claim in claims),
    )


def _validate_fragment_submission(
    submission: ObjectFragmentSubmission,
    claims: Sequence[SourceClaim],
    *,
    source_blocks: Sequence[ParsedBlock] = (),
) -> None:
    expected_claim_ids = [item.claim_id for item in claims]
    submitted_claim_ids = [item.claim_id for item in submission.assertions]
    if submitted_claim_ids != expected_claim_ids:
        raise ValueError("Fragment assertions 必须按原顺序恰好覆盖每个 frozen claim")

    fragment_keys = [item.fragment_key for item in submission.fragments]
    if len(set(fragment_keys)) != len(fragment_keys):
        raise ValueError("fragment_key 不能重复")
    allowed_keys = set(fragment_keys)
    surface_to_key: dict[str, str] = {}
    grounding_texts = _fragment_grounding_texts(source_blocks, claims)
    for fragment in submission.fragments:
        for surface_form in fragment.surface_forms:
            previous = surface_to_key.setdefault(surface_form, fragment.fragment_key)
            if previous != fragment.fragment_key:
                raise ValueError(f"surface form {surface_form!r} 被分到多个 Fragment")
            if source_blocks and not any(surface_form in text for text in grounding_texts):
                raise ValueError(
                    f"surface form {surface_form!r} 未在当前 SourceRegion、"
                    "或 frozen claims 出现"
                )

    for assertion in submission.assertions:
        claim = next(item for item in claims if item.claim_id == assertion.claim_id)
        if assertion.kind != claim.kind:
            raise ValueError(f"{assertion.claim_id} 的 kind 与 frozen claim 不一致")
        anchored_keys = _fragment_reference_ids(assertion.statement_template_markdown)
        if assertion.kind == "reference" and anchored_keys:
            raise ValueError(
                f"{assertion.claim_id} 是 Reference Assertion，不能使用 anchored Fragment token"
            )
        unknown = set(anchored_keys)
        unknown -= allowed_keys
        if unknown:
            raise ValueError(
                f"{assertion.claim_id} 引用了不存在的 Fragment：" + ", ".join(sorted(unknown))
            )
        semantic_keys = assertion.semantic_fragment_keys
        if len(set(semantic_keys)) != len(semantic_keys):
            raise ValueError(f"{assertion.claim_id} 重复提交 semantic_fragment_keys")
        unknown_semantic = set(semantic_keys) - allowed_keys
        if unknown_semantic:
            raise ValueError(
                f"{assertion.claim_id} 引用了不存在的 semantic Fragment："
                + ", ".join(sorted(unknown_semantic))
            )
        if assertion.kind == "grounded" and semantic_keys:
            raise ValueError(f"{assertion.claim_id} 是 grounded Assertion，不能使用 semantic links")
        if assertion.kind == "reference" and not semantic_keys:
            raise ValueError(
                f"{assertion.claim_id} 是 Reference Assertion，至少需要一个 semantic link"
            )
        if assertion.kind == "grounded":
            _validate_no_self_identity_collapse(
                assertion.statement_template_markdown,
                assertion.claim_id,
            )

def _materialize_fragments(
    submission: ObjectFragmentSubmission,
    claims: Sequence[SourceClaim],
    *,
    source_region_id: str,
) -> tuple[list[ObjectFragment], list[SourceAssertion]]:
    """只稳定化 Fragment ID；不进行任何语义 substring replacement。"""

    claim_map = {item.claim_id: item for item in claims}
    key_to_id = {
        item.fragment_key: f"fragment-{position}"
        for position, item in enumerate(submission.fragments, start=1)
    }
    fragments = [
        ObjectFragment(
            fragment_id=key_to_id[item.fragment_key],
            source_region_id=source_region_id,
            surface_forms=item.surface_forms,
            identity_mode_hint=item.identity_mode_hint,
        )
        for item in submission.fragments
    ]

    assertions: list[SourceAssertion] = []
    for item in submission.assertions:
        claim = claim_map[item.claim_id]
        template = _FRAGMENT_REFERENCE_PATTERN.sub(
            lambda match: f"{{{{fragment:{key_to_id[match.group(1)]}}}}}",
            item.statement_template_markdown,
        )
        assertions.append(
            SourceAssertion(
                claim_id=item.claim_id,
                kind=item.kind,
                statement_template_markdown=template,
                semantic_fragment_ids=[key_to_id[key] for key in item.semantic_fragment_keys],
                supporting_block_ids=claim.supporting_block_ids,
                context_dependent=claim.context_dependent,
            )
        )
    return fragments, assertions


def _validate_fragment_checkpoint(
    checkpoint: SourceObjectFragmentCheckpoint,
    claims: Sequence[SourceClaim],
    *,
    source_blocks: Sequence[ParsedBlock] = (),
    validate_surface_grounding: bool = True,
) -> None:
    expected_fragment_ids = [
        f"fragment-{position}" for position in range(1, len(checkpoint.fragments) + 1)
    ]
    fragment_ids = [item.fragment_id for item in checkpoint.fragments]
    if fragment_ids != expected_fragment_ids:
        raise ValueError("Object Fragment 断点的稳定 ID 顺序无效")
    if any(item.source_region_id != checkpoint.region_node_id for item in checkpoint.fragments):
        raise ValueError("Object Fragment 断点包含其他 SourceRegion 的 Fragment")

    surface_to_fragment: dict[str, str] = {}
    grounding_texts = _fragment_grounding_texts(source_blocks, claims)
    for fragment in checkpoint.fragments:
        for surface_form in fragment.surface_forms:
            previous = surface_to_fragment.setdefault(surface_form, fragment.fragment_id)
            if previous != fragment.fragment_id:
                raise ValueError(f"surface form {surface_form!r} 被分到多个 Fragment")
            if validate_surface_grounding and not any(
                surface_form in text for text in grounding_texts
            ):
                raise ValueError(
                    f"surface form {surface_form!r} 未在当前 SourceRegion、"
                    "或 frozen claims 出现"
                )

    expected_claim_ids = [item.claim_id for item in claims]
    checkpoint_claim_ids = [item.claim_id for item in checkpoint.assertions]
    if checkpoint_claim_ids != expected_claim_ids:
        raise ValueError("Object Fragment 断点没有按顺序覆盖全部 frozen claims")
    claim_map = {item.claim_id: item for item in claims}
    allowed_fragment_ids = set(fragment_ids)
    for assertion in checkpoint.assertions:
        claim = claim_map[assertion.claim_id]
        if assertion.supporting_block_ids != claim.supporting_block_ids:
            raise ValueError(f"{assertion.claim_id} 的 supporting blocks 已发生变化")
        if assertion.context_dependent != claim.context_dependent:
            raise ValueError(f"{assertion.claim_id} 的 context_dependent 已发生变化")
        if assertion.kind != claim.kind:
            raise ValueError(f"{assertion.claim_id} 的 kind 已发生变化")
        anchored_ids = _fragment_reference_ids(assertion.statement_template_markdown)
        if assertion.kind == "reference" and anchored_ids:
            raise ValueError(
                f"{assertion.claim_id} 是 Reference Assertion，不能使用 anchored Fragment token"
            )
        unknown = set(anchored_ids)
        unknown -= allowed_fragment_ids
        if unknown:
            raise ValueError(
                f"{assertion.claim_id} 引用了不存在的稳定 Fragment：" + ", ".join(sorted(unknown))
            )
        unknown_semantic = set(assertion.semantic_fragment_ids) - allowed_fragment_ids
        if unknown_semantic:
            raise ValueError(
                f"{assertion.claim_id} 引用了不存在的 semantic Fragment："
                + ", ".join(sorted(unknown_semantic))
            )
        if assertion.kind == "grounded":
            _validate_no_self_identity_collapse(
                assertion.statement_template_markdown,
                assertion.claim_id,
            )


def _merge_claims(
    existing: Sequence[SourceClaim],
    additions: Sequence[AtomicClaimDraft],
) -> list[AtomicClaimDraft | SourceClaim]:
    merged: list[AtomicClaimDraft | SourceClaim] = list(existing)
    signatures = {_claim_signature(item) for item in existing}
    for item in additions:
        signature = _claim_signature(item)
        if signature in signatures:
            continue
        signatures.add(signature)
        merged.append(item)
    return merged


def _validate_missing_claims(
    submission: MissingClaimSubmission,
    existing: Sequence[SourceClaim],
    source_blocks: Sequence[ParsedBlock],
) -> None:
    _validate_claim_blocks(submission.claims, source_blocks)
    existing_normalized = [
        (
            item.kind,
            _claim_text_normalized(item.statement_markdown),
            set(item.supporting_block_ids),
        )
        for item in existing
    ]
    for addition in submission.claims:
        addition_text = _claim_text_normalized(addition.statement_markdown)
        addition_blocks = set(addition.supporting_block_ids)
        for kind, existing_text, existing_blocks in existing_normalized:
            if kind != addition.kind or not addition_blocks.issubset(existing_blocks):
                continue
            if addition_text == existing_text or addition_text in existing_text:
                raise ValueError(
                    "Missing Review 新增命题已由同一 supporting blocks 的 frozen Assertion 明确覆盖"
                )


def _claim_text_normalized(value: str) -> str:
    return re.sub(r"[\s，,。.!！?？:：;；、]", "", value).casefold()


def _validate_no_self_identity_collapse(template: str, claim_id: str) -> None:
    token = r"\{\{fragment:([^{}]+)\}\}"
    match = re.search(rf"{token}\s*(?:为|是)\s*{token}", template)
    if match is not None and match.group(1) == match.group(2):
        raise ValueError(f"{claim_id} 的 Fragment template 把不同语义边界折叠为 self-identity")


def _claim_signature(
    item: AtomicClaimDraft | SourceClaim,
) -> tuple[str, str, tuple[str, ...]]:
    text = _claim_text_normalized(item.statement_markdown)
    return item.kind, text, tuple(dict.fromkeys(item.supporting_block_ids))


def _covered_block_ids(
    claims: Sequence[SourceClaim],
    blocks: Sequence[ParsedBlock],
) -> list[str]:
    covered = {block_id for claim in claims for block_id in claim.supporting_block_ids}
    return [block.block_id for block in blocks if block.block_id in covered]


def _render_report(
    snapshot: SourceSemanticSnapshot,
    blocks: Sequence[ParsedBlock],
) -> str:
    lines = [
        f"# {snapshot.label}",
        "",
        (
            "> 来源语义产物：Object Fragment 是当前 SourceRegion 中未来应归属于同一 "
            "Global Object 的 reusable names；它只是 Leaf compiler IR。"
        ),
        f"> 区域：`{snapshot.region_node_id}`",
        f"> 初次命题：{snapshot.initial_claim_count}",
        f"> 遗漏扫描新增：{snapshot.review_addition_count}",
        f"> 最终命题：{len(snapshot.assertions)}",
        f"> Object Fragment：{len(snapshot.object_fragments)}",
        f"> Surface form：{sum(len(item.surface_forms) for item in snapshot.object_fragments)}",
        "",
        "## Assertion",
        "",
    ]
    for claim in snapshot.assertions:
        context_marker = "｜依赖 SourceRegion 上下文" if claim.context_dependent else ""
        semantic_links = (
            "｜semantic links " + ", ".join(claim.semantic_fragment_ids)
            if claim.semantic_fragment_ids
            else ""
        )
        lines.append(
            f"- `{claim.claim_id}` `{claim.kind}` {claim.statement_template_markdown}｜"
            f"依据 `{'`, `'.join(claim.supporting_block_ids)}`"
            f"{semantic_links}{context_marker}"
        )
    if not snapshot.assertions:
        lines.append("无。")

    lines.extend(["", "## Object Fragment", ""])
    for item in snapshot.object_fragments:
        lines.append(
            f"- `{item.fragment_id}`｜" + " = ".join(f"**{name}**" for name in item.surface_forms)
        )
    if not snapshot.object_fragments:
        lines.append("无。")

    claims_by_block: dict[str, list[str]] = {block.block_id: [] for block in blocks}
    for claim in snapshot.assertions:
        for block_id in claim.supporting_block_ids:
            claims_by_block[block_id].append(claim.claim_id)
    lines.extend(["", "## 原文逐块命题覆盖", ""])
    for block in blocks:
        claim_ids = claims_by_block[block.block_id]
        marker = "有命题" if claim_ids else "无命题"
        references = claim_ids
        suffix = f"：{', '.join(references)}" if references else ""
        lines.extend(
            [
                f"### `{block.block_id}`｜{marker}{suffix}",
                "",
                block.markdown,
                "",
            ]
        )
    return "\n".join(lines).rstrip() + "\n"


def _render_full_report(snapshot: FullSourceSemanticSnapshot) -> str:
    lines = [
        "# 全部来源语义编译",
        "",
        f"> Source Time：{snapshot.source_time_text or '未提取到明确时间锚点'}",
        (
            "> Source Time evidence："
            + (", ".join(f"`{item}`" for item in snapshot.source_time_supporting_block_ids) or "无")
        ),
        f"> 来源节点：{len(snapshot.sources)}",
        f"> Assertion：{snapshot.total_assertions}",
        f"> Object Fragment：{snapshot.total_object_fragments}",
        f"> Surface form：{snapshot.total_surface_forms}",
        f"> 模型调用：{snapshot.model_calls}",
        "",
        "## 来源索引",
        "",
    ]
    lines.extend(
        (
            f"- `{item.region_node_id}` **{item.label}**｜命题 {len(item.assertions)}｜"
            f"Fragment {len(item.object_fragments)}｜遗漏扫描新增 {item.review_addition_count}｜"
            f"原文块覆盖 {len(item.covered_block_ids)}/{len(item.source_block_ids)}"
        )
        for item in snapshot.sources
    )
    return "\n".join(lines).rstrip() + "\n"
