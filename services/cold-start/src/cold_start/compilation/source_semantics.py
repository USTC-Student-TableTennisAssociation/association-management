"""先提取来源原子命题，再为命题建立局部 Object 引用。"""

from __future__ import annotations

import asyncio
import calendar
import json
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from cold_start.document.blocks import format_blocks
from cold_start.document.models import ParsedBlock
from cold_start.global_exploration.models import GlobalExplorationSnapshot, SourceMetadata
from cold_start.llm.base import ChatModel
from cold_start.llm.openai_compatible import ModelRepetitionError
from cold_start.progress import NullProgressReporter, ProgressReporter
from cold_start.region_tree.models import BlockId, RegionNode
from cold_start.region_tree.runtime import BlockIndex


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AtomicClaimDraft(StrictModel):
    """模型提交的一条忠实原子命题，不含最终记忆协议字段。"""

    statement_markdown: str = Field(min_length=1, max_length=3_000)
    supporting_block_ids: list[BlockId] = Field(min_length=1, max_length=32)


class AtomicClaimSubmission(StrictModel):
    claims: list[AtomicClaimDraft] = Field(default_factory=list, max_length=1_000)


class SourceClaim(AtomicClaimDraft):
    claim_id: str = Field(pattern=r"^claim-\d+$")


class SourceObject(StrictModel):
    """程序根据字面 mention 生成的局部 provisional Object。"""

    object_id: str = Field(pattern=r"^obj-\d+$")
    label: str = Field(min_length=1, max_length=150)
    aliases: list[str] = Field(default_factory=list, max_length=100)


class ObjectMentionDraft(StrictModel):
    """模型只提交冻结命题中可确定定位的字面 mention。"""

    claim_id: str = Field(pattern=r"^claim-\d+$")
    span_text: str = Field(min_length=1, max_length=150)
    occurrence_index: int = Field(ge=0, le=1_000)


class ObjectMentionSubmission(StrictModel):
    mentions: list[ObjectMentionDraft] = Field(default_factory=list, max_length=5_000)


class SourceObjectMention(ObjectMentionDraft):
    mention_id: str = Field(pattern=r"^mention-\d+$")
    object_id: str = Field(pattern=r"^obj-\d+$")
    start: int = Field(ge=0)
    end: int = Field(gt=0)


class SourceAssertionDraft(StrictModel):
    claim_id: str = Field(pattern=r"^claim-\d+$")
    statement_template_markdown: str = Field(min_length=1, max_length=3_000)
    supporting_block_ids: list[BlockId] = Field(min_length=1, max_length=32)


TemporalKind = Literal["point", "range", "recurring", "relative", "contextual", "unknown"]
TemporalPrecision = Literal[
    "day", "month", "year", "academic_year", "semester", "unspecified"
]
TemporalDerivation = Literal[
    "source_explicit", "contextual_inference", "unresolved"
]


class TemporalAnnotation(StrictModel):
    """来源中时间表达的可检索标准化，不表示事实真实性。"""

    raw_expression: str = Field(min_length=1, max_length=300)
    kind: TemporalKind
    normalized_text: str = Field(min_length=1, max_length=300)
    start: str | None
    end: str | None
    precision: TemporalPrecision
    derivation: TemporalDerivation
    basis_markdown: str = Field(min_length=1, max_length=2_000)

    @model_validator(mode="after")
    def validate_absolute_bounds(self) -> TemporalAnnotation:
        if self.start is not None:
            _validate_absolute_time(self.start, "start")
        if self.end is not None:
            _validate_absolute_time(self.end, "end")
        if self.start is not None and self.end is not None:
            if _time_lower_bound(self.start) > _time_upper_bound(self.end):
                raise ValueError("start 不能晚于 end")
        if self.derivation == "unresolved" and (
            self.start is not None or self.end is not None
        ):
            raise ValueError("unresolved 时间不能填写 start/end")
        return self


class TemporalClaimAnnotations(StrictModel):
    claim_id: str = Field(pattern=r"^claim-\d+$")
    temporal_annotations: list[TemporalAnnotation] = Field(
        default_factory=list, max_length=100
    )


class TemporalAnnotationSubmission(StrictModel):
    claims: list[TemporalClaimAnnotations] = Field(max_length=1_000)


class SourceAssertion(SourceAssertionDraft):
    temporal_annotations: list[TemporalAnnotation] = Field(default_factory=list)


class SourceClaimCheckpoint(StrictModel):
    schema_version: Literal["source-claims.v2"] = "source-claims.v2"
    source_sha256: str
    region_node_id: str = Field(pattern=r"^region-\d{4,}$")
    claims: list[SourceClaim]
    model_calls: int = Field(ge=0)


class SourceObjectMentionCheckpoint(StrictModel):
    schema_version: Literal["source-object-mentions.v1"] = "source-object-mentions.v1"
    source_sha256: str
    region_node_id: str = Field(pattern=r"^region-\d{4,}$")
    objects: list[SourceObject]
    mentions: list[SourceObjectMention]
    assertions: list[SourceAssertionDraft]
    model_calls: int = Field(ge=0)


class SourceTemporalAnnotationCheckpoint(StrictModel):
    schema_version: Literal["source-temporal-annotations.v1"] = (
        "source-temporal-annotations.v1"
    )
    source_sha256: str
    region_node_id: str = Field(pattern=r"^region-\d{4,}$")
    claims: list[TemporalClaimAnnotations]
    model_calls: int = Field(ge=0)


class SourceStageStatus(StrictModel):
    source_node_id: str = Field(pattern=r"^region-\d{4,}$")
    initial_claims: bool
    reviewed_claims: bool
    object_mentions: bool
    temporal_annotations: bool
    complete: bool
    error: str | None = None


class FullSourceSemanticWorking(StrictModel):
    schema_version: Literal["source-semantics-working.v4"] = "source-semantics-working.v4"
    source_sha256: str
    source_node_ids: list[str]
    stages: list[SourceStageStatus]


class SourceSemanticSnapshot(StrictModel):
    """来源原子命题及其可追溯的字面 Object mention。"""

    schema_version: Literal["source-semantics.v4"] = "source-semantics.v4"
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
    objects: list[SourceObject]
    object_mentions: list[SourceObjectMention]
    model_calls: int


class FullSourceSemanticSnapshot(StrictModel):
    schema_version: Literal["source-semantics-full.v4"] = "source-semantics-full.v4"
    created_at: datetime
    source: SourceMetadata
    region_tree_schema_version: str
    source_node_ids: list[str]
    sources: list[SourceSemanticSnapshot]
    total_assertions: int
    total_objects: int
    total_object_mentions: int
    model_calls: int


@dataclass(frozen=True)
class SourceSemanticPaths:
    directory: Path
    model_streams: Path
    initial_claims_json: Path
    reviewed_claims_json: Path
    object_mentions_json: Path
    temporal_annotations_json: Path
    snapshot_json: Path
    report_markdown: Path


@dataclass(frozen=True)
class FullSourceSemanticPaths:
    directory: Path
    model_streams: Path
    sources: Path
    working_json: Path
    snapshot_json: Path
    report_markdown: Path


CLAIM_EXTRACTION_SYSTEM_PROMPT = """
你只负责从当前来源原文提取现实世界中的原子命题。

一次只做这一个核心判断：原文对现实中的组织、人物、活动、工作、制度、历史、状态、
做法、结果、目标或观点明确说了什么。目录、章节导航、承接语和“本章将介绍……”之类
只描述文档结构的文字不形成命题。

要求：
- 每条 statement_markdown 是脱离列表符号后仍可独立理解的完整命题；
- 两项信息能够分别成立或分别变化时拆开；条件、否定、例外、数量、时间表达和“建议”
  “计划”“可能”等原文语气必须保留，不能擅自补足；
- supporting_block_ids 只列直接支持该命题的当前来源块；
- 不判断 Object，不建立 Relation，不分类 record/viewpoint，不结构化时间，不评价长期价值；
- 不分配任何 ID，不输出最终数据库协议，也不进行全局自检；
- 遇到两种都合理的措辞时，选择最贴近原文且较保守的一种，提交后不要重新打开判断。

JSON 字符串要求：
- 原文使用中文弯引号“”时优先保留，不要主动转换成 ASCII 双引号 \"；
- statement_markdown 中确实需要 ASCII 双引号时，必须按 JSON string 规则写成 \\\"；
- JSON 结构边界的双引号与自然语言内容中的 ASCII 双引号必须区分；
- 输出必须是标准 JSON parser 可以直接解析的完整对象。

错误：
{"statement_markdown":"协会呈现"两极化"结构"}

正确之一：
{"statement_markdown":"协会呈现“两极化”结构"}

或合法转义：
{"statement_markdown":"协会呈现\\\"两极化\\\"结构"}

只输出一个 JSON 对象，不要输出 Markdown 代码块、说明或其他正文：
{"claims":[{"statement_markdown":"完整原子命题","supporting_block_ids":["p0001-b0001"]}]}
""".strip()


CONSERVATIVE_ATOMIC_FALLBACK_SYSTEM_PROMPT = """
上一轮完整原子化推理发生重复。本轮只使用保守原子化策略稳定完成第一次命题抽取，
不寻找唯一最优的原子化方案。

按当前 source 原文 block 的顺序处理，每个 block 只处理一次。只提取原文明确表达的现实命题；
标题、目录、纯导航和交叉引用不形成现实命题。明显具有不同主语或不同谓词的独立事实可以拆开。

如果进一步拆分需要判断以下任何问题，立即停止拆分并保留较完整、较接近原文的表达：
- 是否因为信息能够分别成立或分别变化而继续拆分；
- 是否需要重复共享条件或重建省略主语；
- 是否需要继续拆解目的链、因果链或手段→目标链；
- 是否需要比较两个都合理的粒度方案；
- 是否需要反复处理代词回指；
- 是否需要判断文档元数据还能否继续细拆。

不追求最小原子粒度。两种表达都合理时，选择更接近原文、信息保留更多、改写更少的一种。
不要返回已经处理过的 block，不做第二轮全局检查，不证明是否还有遗漏；遗漏事实由后续 Missing
阶段检查。处理完最后一个 block 后立即提交。

粒度示例一：
原文：随着社团规模的发展，长久以来存在的组织架构不合理、经验传承断层等问题日益凸显，
制约了协会进一步服务同学的能力，也消耗了骨干成员的热情。
可以输出：
- 随着社团规模的发展，长久以来存在的组织架构不合理、经验传承断层等问题日益凸显。
- 这些问题制约了协会进一步服务同学的能力。
- 这些问题消耗了骨干成员的热情。
不要为了理论原子性，把组织架构不合理和经验传承断层拆成两套带重复条件的命题。

粒度示例二：
原文：记录过去的探索、改革思路及教训，为后来者提供可复用的参考，终结“代际失忆”。
可以保留为一条完整目标命题，不再讨论记录→提供参考→终结失忆是否需要拆成三条。

每条 claim 只使用：
- statement_markdown：忠实、可用的现实命题；
- supporting_block_ids：直接支持该命题的当前来源块。

JSON 字符串要求：
- 原文使用中文弯引号“”时优先保留，不要主动转换成 ASCII 双引号 "；
- statement_markdown 中确实需要 ASCII 双引号时，必须按 JSON string 规则写成 \\\"；
- 输出必须是标准 JSON parser 可以直接解析的完整对象。

只输出一个 JSON 对象，不要输出 Markdown 代码块、说明或其他正文：
{"claims":[{"statement_markdown":"较完整且贴近原文的命题","supporting_block_ids":["p0001-b0001"]}]}
""".strip()


MISSING_CLAIMS_SYSTEM_PROMPT = """
你只负责检查已有原子命题是否遗漏了当前来源明确表达的现实命题。

已有命题已经冻结：不得删除、改写、合并、重排或重新分类它们。只提交原文明确支持、
且现有命题尚未表达的增量命题；没有遗漏时提交空数组。不要为了覆盖标题、目录、承接语、
例子标签或文档说明而制造命题。

不判断 Object、Relation、record/viewpoint、结构化时间或业务价值，不重新输出已有命题。
每个 claims 元素只能使用 statement_markdown 和 supporting_block_ids，不得输出 id、claim_id、
text、content、source，也不得自行发明其他字段。

只输出一个 JSON 对象，不要输出 Markdown 代码块、说明或其他正文。

无遗漏：
{"claims":[]}

有遗漏：
{
  "claims": [
    {
      "statement_markdown": "完整原子命题",
      "supporting_block_ids": ["p0001-b0001"]
    }
  ]
}
""".strip()


OBJECT_MENTION_SYSTEM_PROMPT = """
你只负责按已经冻结的 Assertions 当前给出的顺序，识别原文字面 Object mention。

每条 claim 只处理一次。在当前 claim 中，识别字面上合理指向人物、组织、角色、具名活动、
活动类别、流程、工作事项、制度、档案、历史事件、平台或稳定群体等“对象性事物”的连续文本。
如果某个 mention 的唯一疑问只是它是否足够长期、是否足够重要、后续是否还会出现，或最终
是否值得成为基础 Object，不要继续判断这些问题，直接保留该 mention，然后继续向后处理。
明显只是数量、时间、属性、结果、程度、评价或修辞性描述的文字不标记。

输出规则：
- 只输出 claim_id、span_text 和 occurrence_index；occurrence_index 是 span_text 在该命题中
  作为普通连续子串从左到右第几次出现，从 0 开始；即使某次出现嵌套在更长 mention 内，
  也仍然计入 occurrence；
- span_text 必须是对应冻结命题中逐字存在的连续原文，不得改写、补全、纠错或只从来源上下文复制；
- 同一命题中不要提交相互重叠的 mention；共享后缀或嵌套无法稳定表达时，保留更粗但完整的字面 mention；
- 当前 claim 处理结束后继续下一条，不返回已经处理过的 claim；
- 最后一条 claim 处理结束后立即输出，不进行第二轮扫描或全局遗漏检查；
- 不重新打开已经处理过的 claim。

嵌套子串示例：
原句：副会长协助会长完成重大决策。
正确输出：
{
  "mentions": [
    {"claim_id":"claim-1","span_text":"副会长","occurrence_index":0},
    {"claim_id":"claim-1","span_text":"会长","occurrence_index":1}
  ]
}

禁止进行 label 优化、alias 搜集、Object 合并、canonical naming、全局价值判断、
KEEP/REJECT、confidence、needs_review、Relation 分析或 statement template 重写。

只输出一个 JSON 对象，不要输出 Markdown 代码块、说明或其他正文：
{"mentions":[{"claim_id":"claim-1","span_text":"继往开来杯","occurrence_index":0}]}
""".strip()


TEMPORAL_ANNOTATION_SYSTEM_PROMPT = """
你只负责对已经冻结的 Assertions 做来源锚定的时间表达标准化。

基础层保存的是“来源声称了什么”，不是系统确认现实一定如此。你只回答来源怎样描述
每条 Assertion 的时间，以及这个时间表达如何被保守地标准化。不得判断事实真假、来源质量、
Assertion 当前是否仍有效，也不得输出 fact_confidence、truth_confidence、source_reliability、
source_quality、可信度评分或任何 confidence 字段。

按 frozen claims 当前顺序处理：
1. 每条 claim 只处理一次，并且必须在输出中恰好出现一次；
2. 只识别当前 claim 或其 supporting blocks 中实际出现的时间表达；
3. 同一 claim 可以有零个、一个或多个 temporal_annotations；
4. 没有时间表达时返回空数组，不得根据一般现在时、定义句或规则句生成“持续适用”、
   “长期有效”“当前有效”或 general；
5. 来源日期不是 Assertion 时间。只有 claim/supporting blocks 出现“目前”“本届”“当时”
   等表达时，才可以使用可靠的文档背景、来源元数据或区域路径作为 contextual anchor；
6. raw_expression 必须逐字来自当前 claim 或其 supporting blocks；标准化后仍须保留来源的
   “约”“前后”等模糊性；
7. 对每个时间表达只分类和标准化一次，不回到之前 claim，不做第二轮全局检查，
   不证明没有遗漏；最后一条 claim 完成后立即输出 JSON。

kind 只允许：
- point：明确或近似时点，例如“2026年1月28日”“约2025年”；
- range：可标准化范围，例如“2025-2026学年”“2022年至2023年”；
- recurring：周期时间，例如“每周”“每年五月”“每学期末”；
- relative：相对事件时间，例如“活动前至少7天”“卸任前”“结项后”；
- contextual：必须依赖可靠来源上下文理解，例如“目前”“本届”“当时”；
- unknown：明确具有时间含义但无法安全定位，例如“长期以来”“早期”“曾经”。

precision 只允许 day、month、year、academic_year、semester、unspecified。

derivation 只允许：
- source_explicit：来源时间文字本身足以完成标准化，包括无法绝对化的 recurring/relative；
- contextual_inference：来源有相对表达，绝对化还使用了可靠上下文；basis_markdown 必须说明
  原始表达、anchor 和推导；
- unresolved：存在时间表达但上下文不足；start/end 必须为 null，不能猜年份。

start/end 只在可以安全得到绝对时间时填写，只允许 YYYY、YYYY-MM、YYYY-MM-DD；其余填 null。
当“保留模糊表达”和“猜一个具体时间”都可行时，始终保留模糊表达。即使 derivation 是
source_explicit，也必须填写非空 basis_markdown，解释标准化直接依据的来源文字。

JSON 字符串要求：
- basis_markdown 等自然语言字段引用来源文字时优先使用中文弯引号“”，不要直接写未转义的
  ASCII 双引号 "；
- 字符串内容确实需要 ASCII 双引号时，必须按 JSON string 规则写成 \\\"；
- JSON 结构边界的双引号与自然语言内容中的 ASCII 双引号必须区分；
- 输出必须是标准 JSON parser 可以直接解析的完整对象。

错误：
{"basis_markdown":"表格中"继往开来"的举办时间为"秋季学期"。"}

正确之一：
{"basis_markdown":"表格中“继往开来”的举办时间为“秋季学期”。"}

或合法转义：
{"basis_markdown":"表格中\\\"继往开来\\\"的举办时间为\\\"秋季学期\\\"。"}

不得新增、删除或修改 claim_id，不得输出或修改 statement、supporting_block_ids、Object、
Mention 或其他字段。只输出一个严格 JSON 对象，不要输出 Markdown 代码块、说明或其他正文：
{
  "claims": [
    {"claim_id":"claim-1","temporal_annotations":[]},
    {
      "claim_id":"claim-2",
      "temporal_annotations":[
        {
          "raw_expression":"2025-2026学年",
          "kind":"range",
          "normalized_text":"2025-2026学年",
          "start":"2025",
          "end":"2026",
          "precision":"academic_year",
          "derivation":"source_explicit",
          "basis_markdown":"来源明确写出“2025-2026学年”。"
        }
      ]
    }
  ]
}
""".strip()

OutputModel = TypeVar("OutputModel", bound=BaseModel)


class SourceSemanticCompiler:
    """以单调的四遍流程编译一个内容来源节点。"""

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
        cached = _load_current_source_snapshot(self.paths)
        if cached is not None:
            self._validate_checkpoint_identity(
                cached.source.sha256, cached.region_node_id, node
            )
            return cached

        lineage = self._lineage(node)
        source_prompt = _source_prompt(
            document_context=self.exploration.document_context_markdown,
            lineage=lineage,
            node=node,
            blocks=source_blocks,
        )
        label = f"来源语义·{node.node_id}"

        initial = self._load_claim_checkpoint(
            self.paths.initial_claims_json, node, source_blocks
        )
        rebuilt_initial = initial is None
        if initial is None:
            self.progress.report(label, "第一遍：开始提取原子现实命题")
            submission, initial_calls = await self._request_atomic_json(
                system_prompt=CLAIM_EXTRACTION_SYSTEM_PROMPT,
                user_prompt=source_prompt,
                output_model=AtomicClaimSubmission,
                request_label=f"{label}·原子命题",
                validate=lambda value: _validate_claim_blocks(
                    value.claims, source_blocks
                ),
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
                output_model=AtomicClaimSubmission,
                request_label=f"{label}·遗漏扫描",
                validate=lambda value: _validate_claim_blocks(
                    value.claims, source_blocks
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

        object_mentions = None
        if not rebuilt_reviewed:
            object_mentions = self._load_object_mentions_checkpoint(
                node, reviewed.claims
            )
        if object_mentions is None:
            self.progress.report(label, "第三遍：开始高召回发现 Object mention")
            submission, mention_calls = await self._request_json(
                system_prompt=OBJECT_MENTION_SYSTEM_PROMPT,
                user_prompt=_object_prompt(source_prompt, reviewed.claims),
                output_model=ObjectMentionSubmission,
                request_label=f"{label}·Object Mention",
                validate=lambda value: _validate_mention_submission(
                    value, reviewed.claims
                ),
            )
            objects, mentions, assertions = _materialize_mentions(
                submission, reviewed.claims
            )
            object_mentions = SourceObjectMentionCheckpoint(
                source_sha256=self.exploration.source.sha256,
                region_node_id=node.node_id,
                objects=objects,
                mentions=mentions,
                assertions=assertions,
                model_calls=mention_calls,
            )
            self._write_json(self.paths.object_mentions_json, object_mentions)
        self.progress.report(
            label,
            (
                f"第三遍完成：{len(object_mentions.mentions)} 个 mention，"
                f"{len(object_mentions.objects)} 个 provisional Object"
            ),
        )

        temporal = None
        if not rebuilt_reviewed:
            temporal = self._load_temporal_checkpoint(
                node, reviewed.claims, source_blocks
            )
        if temporal is None:
            self.progress.report(label, "第四遍：开始来源锚定的时间表达标准化")
            temporal_submission, temporal_calls = await self._request_json(
                system_prompt=TEMPORAL_ANNOTATION_SYSTEM_PROMPT,
                user_prompt=_temporal_prompt(source_prompt, reviewed.claims, source_blocks),
                output_model=TemporalAnnotationSubmission,
                request_label=f"{label}·Temporal Annotation",
                validate=lambda value: _validate_temporal_submission(
                    value, reviewed.claims, source_blocks
                ),
            )
            temporal = SourceTemporalAnnotationCheckpoint(
                source_sha256=self.exploration.source.sha256,
                region_node_id=node.node_id,
                claims=temporal_submission.claims,
                model_calls=temporal_calls,
            )
            self._write_json(self.paths.temporal_annotations_json, temporal)
        temporal_count = sum(
            len(item.temporal_annotations) for item in temporal.claims
        )
        self.progress.report(
            label,
            f"第四遍完成：{temporal_count} 个 Temporal Annotation",
        )

        covered = _covered_block_ids(reviewed.claims, source_blocks)
        source_ids = [block.block_id for block in source_blocks]
        model_calls = (
            initial.model_calls
            + reviewed.model_calls
            + object_mentions.model_calls
            + temporal.model_calls
        )
        snapshot = SourceSemanticSnapshot(
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
            assertions=_attach_temporal_annotations(
                object_mentions.assertions, temporal.claims
            ),
            objects=object_mentions.objects,
            object_mentions=object_mentions.mentions,
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
                f"Object mention {len(snapshot.object_mentions)}，"
                f"Temporal Annotation {temporal_count}，"
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
                raise ValueError(
                    f"{fallback_label}失败且不再重试："
                    f"{_short_validation_error(error)}"
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
                f"输出校验失败，进行唯一一次 clean retry："
                f"{_short_validation_error(first_error)}",
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
                raise ValueError(
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
                        request_label
                        if attempt == 1
                        else f"{request_label}·clean-retry"
                    ),
                    validate=validate,
                )
                return parsed, attempt
            except (ModelRepetitionError, ValueError) as error:
                last_error = error
        assert last_error is not None
        raise ValueError(
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
        if turn.tool_calls or not turn.content:
            raise ValueError(f"{request_label}没有返回 JSON 正文")
        normalized = normalize_json_fence(turn.content)
        parsed = output_model.model_validate_json(normalized)
        if validate is not None:
            validate(parsed)
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
        blocks: list[ParsedBlock] = []
        for segment in node.owned_segments:
            blocks.extend(self.index.slice(segment.start_block_id, segment.end_block_id))
        return tuple(blocks)

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
                statement_markdown=item.statement_markdown.strip(),
                supporting_block_ids=list(dict.fromkeys(item.supporting_block_ids)),
            )
            for position, item in enumerate(claims, start=1)
        ]
        _validate_claim_blocks(normalized, source_blocks)
        return SourceClaimCheckpoint(
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
        checkpoint = SourceClaimCheckpoint.model_validate_json(path.read_text(encoding="utf-8"))
        self._validate_checkpoint_identity(
            checkpoint.source_sha256, checkpoint.region_node_id, node
        )
        _validate_claim_blocks(checkpoint.claims, source_blocks)
        return checkpoint

    def _load_object_mentions_checkpoint(
        self,
        node: RegionNode,
        claims: Sequence[SourceClaim],
    ) -> SourceObjectMentionCheckpoint | None:
        if not self.paths.object_mentions_json.exists():
            return None
        checkpoint = SourceObjectMentionCheckpoint.model_validate_json(
            self.paths.object_mentions_json.read_text(encoding="utf-8")
        )
        self._validate_checkpoint_identity(
            checkpoint.source_sha256, checkpoint.region_node_id, node
        )
        _validate_mention_checkpoint(checkpoint, claims)
        return checkpoint

    def _load_temporal_checkpoint(
        self,
        node: RegionNode,
        claims: Sequence[SourceClaim],
        source_blocks: Sequence[ParsedBlock],
    ) -> SourceTemporalAnnotationCheckpoint | None:
        if not self.paths.temporal_annotations_json.exists():
            return None
        checkpoint = SourceTemporalAnnotationCheckpoint.model_validate_json(
            self.paths.temporal_annotations_json.read_text(encoding="utf-8")
        )
        self._validate_checkpoint_identity(
            checkpoint.source_sha256, checkpoint.region_node_id, node
        )
        _validate_temporal_submission(
            TemporalAnnotationSubmission(claims=checkpoint.claims),
            claims,
            source_blocks,
        )
        return checkpoint

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
        self.progress = progress or NullProgressReporter()
        self.nodes = {node.node_id: node for node in exploration.region_tree.nodes}
        self.errors: dict[str, str] = {}
        self._working_lock = asyncio.Lock()

    async def run(self) -> FullSourceSemanticSnapshot:
        if self.exploration.region_tree.status != "frozen":
            raise ValueError("区域树尚未冻结，不能开始全部来源语义编译")
        cached = _load_current_full_snapshot(self.paths.snapshot_json)
        if cached is not None:
            return cached

        available_source_ids = [
            node_id
            for node_id in self.exploration.region_tree.content_node_ids
            if self.nodes[node_id].owned_source_role == "content_source"
            and self.nodes[node_id].owned_segments
        ]
        source_ids = self._select_source_ids(available_source_ids)
        self._validate_resume(source_ids)
        completed = [
            node_id
            for node_id in source_ids
            if _load_current_source_snapshot(
                _source_paths(self.paths, node_id)
            ) is not None
        ]
        self.progress.report(
            "全部来源语义",
            (
                f"来源共 {len(source_ids)} 个，复用已完成 {len(completed)} 个；"
                f"并发上限 {self.max_parallel_sources}"
            ),
        )
        self._write_working(source_ids)
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
                return snapshot

        outcomes = await asyncio.gather(
            *(
                compile_one(position, node_id)
                for position, node_id in enumerate(source_ids, start=1)
            ),
            return_exceptions=True,
        )
        failures = [
            f"{node_id}：{outcome}"
            for node_id, outcome in zip(source_ids, outcomes, strict=True)
            if isinstance(outcome, BaseException)
        ]
        self._write_working(source_ids)
        if failures:
            raise RuntimeError("来源语义编译失败：" + "；".join(failures))

        snapshots = [
            outcome
            for outcome in outcomes
            if isinstance(outcome, SourceSemanticSnapshot)
        ]
        full = FullSourceSemanticSnapshot(
            created_at=datetime.now(UTC),
            source=self.exploration.source,
            region_tree_schema_version=self.exploration.region_tree.schema_version,
            source_node_ids=source_ids,
            sources=snapshots,
            total_assertions=sum(len(item.assertions) for item in snapshots),
            total_objects=sum(len(item.objects) for item in snapshots),
            total_object_mentions=sum(len(item.object_mentions) for item in snapshots),
            model_calls=sum(item.model_calls for item in snapshots),
        )
        self.paths.snapshot_json.write_text(full.model_dump_json(indent=2), encoding="utf-8")
        self.paths.report_markdown.write_text(_render_full_report(full), encoding="utf-8")
        self.progress.report(
            "全部来源语义",
            (
                f"完成：来源 {len(snapshots)}，命题 {full.total_assertions}，"
                f"Object mention {full.total_object_mentions}，"
                f"模型调用 {full.model_calls} 次"
            ),
        )
        return full

    def _select_source_ids(self, available: Sequence[str]) -> list[str]:
        if not self.requested_source_node_ids:
            return list(available)
        requested = set(self.requested_source_node_ids)
        unknown = requested - set(available)
        if unknown:
            raise ValueError(
                "--source-id 不是可编译的 content_source 节点："
                + ", ".join(sorted(unknown))
            )
        return [node_id for node_id in available if node_id in requested]

    def _validate_resume(self, source_ids: Sequence[str]) -> None:
        if not self.paths.working_json.exists():
            return
        raw = json.loads(self.paths.working_json.read_text(encoding="utf-8"))
        version = raw.get("schema_version") if isinstance(raw, dict) else None
        if version not in {"source-semantics-working.v3", "source-semantics-working.v4"}:
            raise ValueError(f"不支持的来源语义工作断点版本：{version}")
        if raw.get("source_sha256") != self.exploration.source.sha256:
            raise ValueError("批量恢复目录属于另一份来源文件")
        if raw.get("source_node_ids") != list(source_ids):
            raise ValueError("批量恢复目录使用了不同的区域树内容来源集合")

    def _write_working(self, source_ids: Sequence[str]) -> None:
        stages: list[SourceStageStatus] = []
        for node_id in source_ids:
            paths = _source_paths(self.paths, node_id)
            temporal_exists = paths.temporal_annotations_json.exists()
            complete = _load_current_source_snapshot(paths) is not None
            stages.append(
                SourceStageStatus(
                    source_node_id=node_id,
                    initial_claims=paths.initial_claims_json.exists(),
                    reviewed_claims=paths.reviewed_claims_json.exists(),
                    object_mentions=paths.object_mentions_json.exists(),
                    temporal_annotations=temporal_exists,
                    complete=complete,
                    error=self.errors.get(node_id),
                )
            )
        working = FullSourceSemanticWorking(
            source_sha256=self.exploration.source.sha256,
            source_node_ids=list(source_ids),
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
        object_mentions_json=directory / "03-object-mentions.json",
        temporal_annotations_json=directory / "04-temporal-annotations.json",
        snapshot_json=directory / "source-semantics.json",
        report_markdown=directory / "source-semantics.md",
    )


def _full_paths(directory: Path) -> FullSourceSemanticPaths:
    return FullSourceSemanticPaths(
        directory=directory,
        model_streams=directory / "model-streams",
        sources=directory / "sources",
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
) -> SourceSemanticSnapshot | None:
    if not paths.snapshot_json.exists() or not paths.temporal_annotations_json.exists():
        return None
    raw = json.loads(paths.snapshot_json.read_text(encoding="utf-8"))
    if isinstance(raw, dict) and raw.get("schema_version") == "source-semantics.v3":
        return None
    return SourceSemanticSnapshot.model_validate(raw)


def _load_current_full_snapshot(path: Path) -> FullSourceSemanticSnapshot | None:
    if not path.exists():
        return None
    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, dict) and raw.get("schema_version") == "source-semantics-full.v3":
        return None
    return FullSourceSemanticSnapshot.model_validate(raw)


def _source_prompt(
    *,
    document_context: str,
    lineage: Sequence[RegionNode],
    node: RegionNode,
    blocks: tuple[ParsedBlock, ...],
) -> str:
    path = "\n".join(
        f"- {item.node_id}｜{item.label}：{item.introduction}"
        for item in [*lineage, node]
    )
    return f"""
[STAGE: extract_atomic_source_claims]

文档背景（只用于理解简称和省略，不能作为新命题依据）：
{document_context}

区域路径（只用于理解当前原文的主题和省略主语）：
{path}

当前来源原文（唯一事实依据）：
{format_blocks(blocks)}
""".strip()


def _review_prompt(source_prompt: str, claims: Sequence[SourceClaim]) -> str:
    rendered = "\n".join(
        f"- {item.claim_id}｜{item.statement_markdown}｜依据 {', '.join(item.supporting_block_ids)}"
        for item in claims
    ) or "（第一次没有提取出命题）"
    return f"""
[STAGE: find_missing_atomic_claims]

第一次阅读材料：
{source_prompt}

已经冻结的命题：
{rendered}

只报告遗漏的新增命题，不要重新输出或修改以上命题。
""".strip()


def _object_prompt(source_prompt: str, claims: Sequence[SourceClaim]) -> str:
    rendered = "\n".join(
        f"- {item.claim_id}｜{item.statement_markdown}"
        for item in claims
    ) or "（当前来源没有现实命题，应提交空 mentions）"
    return f"""
[STAGE: discover_object_mentions]

来源上下文：
{source_prompt}

已经冻结的命题：
{rendered}

按以上冻结命题的当前顺序提交原文字面 Object mention，每条 claim 只处理一次。
只从“已经冻结的命题”取 span_text；来源上下文只帮助理解，不能作为 span 来源。
""".strip()


def _temporal_prompt(
    source_prompt: str,
    claims: Sequence[SourceClaim],
    source_blocks: Sequence[ParsedBlock],
) -> str:
    del source_blocks  # 原文及 block_id 已完整包含在 source_prompt 中。
    rendered = "\n".join(
        (
            f"- {item.claim_id}｜{item.statement_markdown}｜"
            f"supporting blocks: {', '.join(item.supporting_block_ids)}"
        )
        for item in claims
    ) or "（当前来源没有 frozen claim，必须提交空 claims）"
    return f"""
[STAGE: annotate_source_temporals]

来源上下文：
{source_prompt}

已经冻结的 plain claims：
{rendered}

只为以上每条 frozen claim 返回 temporal_annotations。时间理解只能使用该 claim 的正文、
它列出的 supporting blocks，以及解释相对表达所必需的可靠来源上下文。
""".strip()


_ABSOLUTE_TIME_PATTERN = re.compile(
    r"^(?P<year>\d{4})(?:-(?P<month>\d{2})(?:-(?P<day>\d{2}))?)?$"
)


def _absolute_time_parts(value: str, field_name: str) -> tuple[int, int | None, int | None]:
    match = _ABSOLUTE_TIME_PATTERN.fullmatch(value)
    if match is None:
        raise ValueError(f"{field_name} 只允许 YYYY、YYYY-MM 或 YYYY-MM-DD")
    year = int(match.group("year"))
    month_text = match.group("month")
    day_text = match.group("day")
    month = int(month_text) if month_text is not None else None
    day = int(day_text) if day_text is not None else None
    if month is not None and not 1 <= month <= 12:
        raise ValueError(f"{field_name} 的月份无效")
    if day is not None:
        assert month is not None
        if not 1 <= day <= calendar.monthrange(year, month)[1]:
            raise ValueError(f"{field_name} 的日期无效")
    return year, month, day


def _validate_absolute_time(value: str, field_name: str) -> None:
    _absolute_time_parts(value, field_name)


def _time_lower_bound(value: str) -> tuple[int, int, int]:
    year, month, day = _absolute_time_parts(value, "时间")
    return year, month or 1, day or 1


def _time_upper_bound(value: str) -> tuple[int, int, int]:
    year, month, day = _absolute_time_parts(value, "时间")
    if month is None:
        return year, 12, 31
    if day is None:
        return year, month, calendar.monthrange(year, month)[1]
    return year, month, day


def _validate_temporal_submission(
    submission: TemporalAnnotationSubmission,
    claims: Sequence[SourceClaim],
    source_blocks: Sequence[ParsedBlock],
) -> None:
    expected_ids = [claim.claim_id for claim in claims]
    submitted_ids = [item.claim_id for item in submission.claims]
    duplicates = sorted(
        {claim_id for claim_id in submitted_ids if submitted_ids.count(claim_id) > 1}
    )
    if duplicates:
        raise ValueError("Temporal 重复提交 claim_id：" + ", ".join(duplicates))
    unknown = sorted(set(submitted_ids) - set(expected_ids))
    if unknown:
        raise ValueError("Temporal 提交了未知 claim_id：" + ", ".join(unknown))
    missing = [claim_id for claim_id in expected_ids if claim_id not in submitted_ids]
    if missing:
        raise ValueError("Temporal 遗漏 claim_id：" + ", ".join(missing))

    claim_map = {claim.claim_id: claim for claim in claims}
    block_map = {block.block_id: block for block in source_blocks}
    for item in submission.claims:
        claim = claim_map[item.claim_id]
        evidence_texts = [
            block_map[block_id].markdown
            for block_id in claim.supporting_block_ids
            if block_id in block_map
        ]
        for annotation in item.temporal_annotations:
            grounded = annotation.raw_expression in claim.statement_markdown or any(
                annotation.raw_expression in text for text in evidence_texts
            )
            if not grounded:
                raise ValueError(
                    f"{item.claim_id} 的 raw_expression "
                    f"{annotation.raw_expression!r} 不存在于 claim 或 supporting blocks"
                )


def _attach_temporal_annotations(
    assertions: Sequence[SourceAssertionDraft],
    temporal_claims: Sequence[TemporalClaimAnnotations],
) -> list[SourceAssertion]:
    annotations = {
        item.claim_id: item.temporal_annotations for item in temporal_claims
    }
    return [
        SourceAssertion(
            **assertion.model_dump(),
            temporal_annotations=annotations[assertion.claim_id],
        )
        for assertion in assertions
    ]


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
                f"{claim_label} 引用了当前来源之外的原文块："
                f"{', '.join(sorted(unknown))}"
            )


def normalize_json_fence(content: str) -> str:
    """只剥除包裹整个正文的单层 Markdown JSON fence。"""

    stripped = content.strip()
    match = re.fullmatch(
        r"```(?:json)?[ \t]*\r?\n(?P<body>[\s\S]*?)\r?\n```[ \t]*",
        stripped,
        flags=re.IGNORECASE,
    )
    return match.group("body").strip() if match else stripped


def _short_validation_error(error: Exception) -> str:
    if isinstance(error, ModelRepetitionError):
        return "检测到模型输出重复"
    if isinstance(error, ValidationError):
        first = error.errors(include_input=False)[0]
        location = ".".join(map(str, first.get("loc", ()))) or "JSON"
        message = str(first.get("msg", first.get("type", "校验失败")))
        return f"{location}: {message}"[:500]
    return re.sub(r"\s+", " ", str(error)).strip()[:500] or type(error).__name__


def _claim_occurrences(statement: str, span_text: str) -> list[tuple[int, int]]:
    positions: list[tuple[int, int]] = []
    cursor = 0
    while True:
        start = statement.find(span_text, cursor)
        if start < 0:
            return positions
        end = start + len(span_text)
        positions.append((start, end))
        cursor = start + 1


def _resolve_mentions(
    submission: ObjectMentionSubmission,
    claims: Sequence[SourceClaim],
) -> list[tuple[ObjectMentionDraft, int, int]]:
    claim_map = {claim.claim_id: claim for claim in claims}
    resolved: list[tuple[ObjectMentionDraft, int, int]] = []
    seen: set[tuple[str, int, int]] = set()
    for mention in submission.mentions:
        claim = claim_map.get(mention.claim_id)
        if claim is None:
            raise ValueError(f"mention 引用了不存在的 {mention.claim_id}")
        positions = _claim_occurrences(claim.statement_markdown, mention.span_text)
        if mention.occurrence_index >= len(positions):
            raise ValueError(
                f"{mention.claim_id} 中不存在 span {mention.span_text!r} "
                f"的第 {mention.occurrence_index} 次出现"
            )
        start, end = positions[mention.occurrence_index]
        key = (mention.claim_id, start, end)
        if key in seen:
            raise ValueError(f"{mention.claim_id} 重复提交了同一 mention span")
        seen.add(key)
        resolved.append((mention, start, end))

    claim_order = {claim.claim_id: index for index, claim in enumerate(claims)}
    resolved.sort(key=lambda item: (claim_order[item[0].claim_id], item[1], item[2]))
    by_claim: dict[str, list[tuple[ObjectMentionDraft, int, int]]] = {}
    for mention, start, end in resolved:
        ranges = by_claim.setdefault(mention.claim_id, [])
        if ranges and start < ranges[-1][2]:
            previous, previous_start, previous_end = ranges[-1]
            alternatives = [
                (index, candidate_start, candidate_end)
                for index, (candidate_start, candidate_end) in enumerate(
                    _claim_occurrences(
                        claim_map[mention.claim_id].statement_markdown,
                        mention.span_text,
                    )
                )
                if candidate_end <= previous_start or candidate_start >= previous_end
            ]
            message = (
                f"{mention.claim_id} 中 span_text={mention.span_text!r}, "
                f"occurrence_index={mention.occurrence_index} 定位到 [{start}:{end}]，"
                f"与 span_text={previous.span_text!r}, "
                f"occurrence_index={previous.occurrence_index} 定位到 "
                f"[{previous_start}:{previous_end}] 的 mention span 重叠"
            )
            if previous_start <= start and end <= previous_end:
                message += f"；当前定位位于 {previous.span_text!r} 内部"
            if alternatives:
                rendered = "、".join(
                    f"occurrence_index={index} 对应 [{candidate_start}:{candidate_end}]"
                    for index, candidate_start, candidate_end in alternatives
                )
                message += (
                    f"；同一 span_text 的其他非重叠出现为：{rendered}。"
                    "如果目标是其中某处，请使用对应 occurrence_index"
                )
            raise ValueError(message)
        ranges.append((mention, start, end))
    return resolved


def _validate_mention_submission(
    submission: ObjectMentionSubmission,
    claims: Sequence[SourceClaim],
) -> None:
    _resolve_mentions(submission, claims)


def _materialize_mentions(
    submission: ObjectMentionSubmission,
    claims: Sequence[SourceClaim],
) -> tuple[list[SourceObject], list[SourceObjectMention], list[SourceAssertionDraft]]:
    resolved = _resolve_mentions(submission, claims)
    object_ids: dict[str, str] = {}
    mentions: list[SourceObjectMention] = []
    for position, (mention, start, end) in enumerate(resolved, start=1):
        object_id = object_ids.setdefault(
            mention.span_text, f"obj-{len(object_ids) + 1}"
        )
        mentions.append(
            SourceObjectMention(
                mention_id=f"mention-{position}",
                object_id=object_id,
                claim_id=mention.claim_id,
                span_text=mention.span_text,
                occurrence_index=mention.occurrence_index,
                start=start,
                end=end,
            )
        )

    objects = [
        SourceObject(object_id=object_id, label=span_text, aliases=[])
        for span_text, object_id in object_ids.items()
    ]
    mention_by_claim: dict[str, list[SourceObjectMention]] = {}
    for mention in mentions:
        mention_by_claim.setdefault(mention.claim_id, []).append(mention)

    object_labels = {item.object_id: item.label for item in objects}
    assertions: list[SourceAssertionDraft] = []
    for claim in claims:
        parts: list[str] = []
        cursor = 0
        for mention in mention_by_claim.get(claim.claim_id, []):
            if claim.statement_markdown[mention.start : mention.end] != mention.span_text:
                raise ValueError(f"{mention.mention_id} 不再指向冻结命题原文")
            parts.extend(
                (
                    claim.statement_markdown[cursor : mention.start],
                    f"{{{{object:{mention.object_id}}}}}",
                )
            )
            cursor = mention.end
        parts.append(claim.statement_markdown[cursor:])
        template = "".join(parts)
        restored = re.sub(
            r"\{\{object:([^{}]+)\}\}",
            lambda match: object_labels[match.group(1)],
            template,
        )
        if restored != claim.statement_markdown:
            raise ValueError(f"{claim.claim_id} 的 Object 引用不能逐字恢复原命题")
        assertions.append(
            SourceAssertionDraft(
                claim_id=claim.claim_id,
                statement_template_markdown=template,
                supporting_block_ids=claim.supporting_block_ids,
            )
        )
    return objects, mentions, assertions


def _validate_mention_checkpoint(
    checkpoint: SourceObjectMentionCheckpoint,
    claims: Sequence[SourceClaim],
) -> None:
    submission = ObjectMentionSubmission(
        mentions=[
            ObjectMentionDraft(
                claim_id=item.claim_id,
                span_text=item.span_text,
                occurrence_index=item.occurrence_index,
            )
            for item in checkpoint.mentions
        ]
    )
    objects, mentions, assertions = _materialize_mentions(submission, claims)
    if checkpoint.objects != objects:
        raise ValueError("Object mention 断点中的 provisional Objects 不能确定性重建")
    if checkpoint.mentions != mentions:
        raise ValueError("Object mention 断点中的 span 不能确定性重建")
    if checkpoint.assertions != assertions:
        raise ValueError("Object mention 断点中的 Assertion 模板不能确定性重建")


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


def _claim_signature(item: AtomicClaimDraft | SourceClaim) -> tuple[str, tuple[str, ...]]:
    text = re.sub(r"\s+", "", item.statement_markdown).casefold()
    return text, tuple(dict.fromkeys(item.supporting_block_ids))


def _covered_block_ids(
    claims: Sequence[SourceClaim],
    blocks: Sequence[ParsedBlock],
) -> list[str]:
    covered = {
        block_id
        for claim in claims
        for block_id in claim.supporting_block_ids
    }
    return [block.block_id for block in blocks if block.block_id in covered]


def _render_report(
    snapshot: SourceSemanticSnapshot,
    blocks: Sequence[ParsedBlock],
) -> str:
    temporal_count = sum(
        len(item.temporal_annotations) for item in snapshot.assertions
    )
    lines = [
        f"# {snapshot.label}",
        "",
        "> 来源语义产物：Object 仅是从冻结命题高召回发现的 provisional 字面 mention。",
        f"> 区域：`{snapshot.region_node_id}`",
        f"> 初次命题：{snapshot.initial_claim_count}",
        f"> 遗漏扫描新增：{snapshot.review_addition_count}",
        f"> 最终命题：{len(snapshot.assertions)}",
        f"> Object mention：{len(snapshot.object_mentions)}",
        f"> Temporal Annotation：{temporal_count}",
        "",
        "## 带字面 Object 引用的原子命题",
        "",
    ]
    for claim in snapshot.assertions:
        lines.append(
            f"- `{claim.claim_id}` {claim.statement_template_markdown}｜"
            f"依据 `{ '`, `'.join(claim.supporting_block_ids) }`"
        )
        for annotation in claim.temporal_annotations:
            bounds = ""
            if annotation.start is not None or annotation.end is not None:
                bounds = f"｜{annotation.start or '?'} → {annotation.end or '?'}"
            lines.append(
                f"  - 时间 `{annotation.raw_expression}` → "
                f"`{annotation.kind}/{annotation.precision}`｜"
                f"{annotation.normalized_text}{bounds}｜{annotation.derivation}｜"
                f"{annotation.basis_markdown}"
            )
    if not snapshot.assertions:
        lines.append("无。")

    lines.extend(["", "## Provisional Object", ""])
    for item in snapshot.objects:
        lines.append(f"- `{item.object_id}` **{item.label}**")
    if not snapshot.objects:
        lines.append("无。")

    lines.extend(["", "## Object mention 定位", ""])
    for item in snapshot.object_mentions:
        lines.append(
            f"- `{item.mention_id}` → `{item.object_id}`｜`{item.claim_id}` "
            f"[{item.start}:{item.end}]｜{item.span_text}"
        )
    if not snapshot.object_mentions:
        lines.append("无。")

    claims_by_block: dict[str, list[str]] = {block.block_id: [] for block in blocks}
    for claim in snapshot.assertions:
        for block_id in claim.supporting_block_ids:
            claims_by_block[block_id].append(claim.claim_id)
    lines.extend(["", "## 原文逐块命题覆盖", ""])
    for block in blocks:
        claim_ids = claims_by_block[block.block_id]
        marker = "有命题" if claim_ids else "无命题"
        suffix = f"：{', '.join(claim_ids)}" if claim_ids else ""
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
    temporal_count = sum(
        len(assertion.temporal_annotations)
        for source in snapshot.sources
        for assertion in source.assertions
    )
    lines = [
        "# 全部来源语义编译",
        "",
        f"> 来源节点：{len(snapshot.sources)}",
        f"> 原子命题：{snapshot.total_assertions}",
        f"> Provisional Object：{snapshot.total_objects}",
        f"> Object mention：{snapshot.total_object_mentions}",
        f"> Temporal Annotation：{temporal_count}",
        f"> 模型调用：{snapshot.model_calls}",
        "",
        "## 来源索引",
        "",
    ]
    lines.extend(
        (
            f"- `{item.region_node_id}` **{item.label}**｜命题 {len(item.assertions)}｜"
            f"mention {len(item.object_mentions)}｜遗漏扫描新增 {item.review_addition_count}｜"
            f"原文块覆盖 {len(item.covered_block_ids)}/{len(item.source_block_ids)}"
        )
        for item in snapshot.sources
    )
    return "\n".join(lines).rstrip() + "\n"
