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
from cold_start.document.models import ParsedBlock
from cold_start.global_exploration.models import GlobalExplorationSnapshot, SourceMetadata
from cold_start.llm.base import ChatModel
from cold_start.llm.openai_compatible import ModelRepetitionError
from cold_start.progress import NullProgressReporter, ProgressReporter
from cold_start.region_tree.models import BlockId, RegionNode
from cold_start.region_tree.runtime import BlockIndex


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


AssertionKind = Literal["grounded", "reference"]


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


class SameReferentMentionDraft(StrictModel):
    """首遍来源扫描定位出的一个同指称字面表达。"""

    span_text: str = Field(min_length=1, max_length=150)
    occurrence_index: int = Field(ge=0, le=1_000)


class SameReferentDraft(StrictModel):
    """来源明确表达的同指称，不引用尚未建立的 Object。"""

    mentions: list[SameReferentMentionDraft] = Field(min_length=2, max_length=100)
    supporting_block_ids: list[BlockId] = Field(min_length=1, max_length=32)


class AtomicClaimSubmission(StrictModel):
    claims: list[AtomicClaimDraft] = Field(default_factory=list, max_length=1_000)
    same_referent_drafts: list[SameReferentDraft] = Field(default_factory=list, max_length=500)


class MissingClaimSubmission(StrictModel):
    claims: list[AtomicClaimDraft] = Field(default_factory=list, max_length=1_000)


class SourceClaim(AtomicClaimDraft):
    claim_id: str = Field(pattern=r"^claim-\d+$")


class SourceSameReferentDraft(SameReferentDraft):
    same_referent_draft_id: str = Field(pattern=r"^same-ref-draft-\d+$")


class ObjectFragmentDraft(StrictModel):
    """模型在一次 SourceRegion 内提交的临时同指称名称组。"""

    fragment_key: str = Field(pattern=r"^F\d+$")
    surface_forms: list[str] = Field(min_length=1, max_length=100)

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
    schema_version: Literal["source-claims.v7"] = "source-claims.v7"
    source_sha256: str
    region_node_id: str = Field(pattern=r"^region-\d{4,}$")
    claims: list[SourceClaim]
    same_referent_drafts: list[SourceSameReferentDraft]
    model_calls: int = Field(ge=0)


class SourceObjectFragmentCheckpoint(StrictModel):
    schema_version: Literal["source-object-fragments.v5"] = "source-object-fragments.v5"
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
    schema_version: Literal["source-semantics-working.v9"] = "source-semantics-working.v9"
    source_sha256: str
    source_node_ids: list[str]
    source_time: bool
    stages: list[SourceStageStatus]


class SourceSemanticSnapshot(StrictModel):
    """来源 Assertion、Leaf Object Fragment 与来源锚定时间。"""

    schema_version: Literal["source-semantics.v9"] = "source-semantics.v9"
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
    schema_version: Literal["source-semantics-full.v9"] = "source-semantics-full.v9"
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


CLAIM_EXTRACTION_SYSTEM_PROMPT = """
你只负责从当前来源原文提取三类基础语义：可独立理解的 grounded Assertion、
指向明确来源区域的 Reference Assertion，以及来源明确表达的同指称字面称呼。
一次有限扫描完成它们，处理完最后一个 block 后立即提交。

一次只做这一个核心判断：原文对现实中的人物、组织、产品、项目、场所、活动、工作、制度、历史、状态、
做法、结果、目标或观点明确说了什么。目录、章节导航、承接语和“本章将介绍……”之类
只描述文档结构的文字不形成命题。

一、grounded Assertion 的颗粒度：
- 目标不是“一个最小事实一条”，而是一个语义边界清晰、上下文完整、能被下游 AI
  直接理解的知识单元；可以是一句，也可以是相互依赖的数句；
- 同一规则、机制、流程步骤链、完整表格行或共享条件/例外的内容，如果理解其中一句
  需要另一句、它们通常会一起被查询，应优先保持在一条 Assertion 中；
- 只在主题、来源或变化边界明显不同时拆分。例如长期运行规则与“本届负责人”
  生命周期不同，应分开；
- 不要默认按句、每个谓词、列表项或表格单元格切分；不要用字数阈值作为主要标准；
- 能用当前句子或 block 明确无歧义的信息自然补齐主语时，可整理为独立知识
  单元并标记 context_dependent=false；
- 如果独立化需要明显的代词消解、跨句或跨 block 身份推断、省略补全、复制大段前文或复杂
  语义重建，不要强行解决。保留合理的上下文依赖表达，并标记 context_dependent=true；该字段
  只表示阅读这条 Claim 时需要回到所属 SourceRegion，不要求输出 antecedent 或 context span；
- 例如“当前负责人认为有必要改变这一现状。”是可接受的 context_dependent=true Claim，
  不要为展开“这一现状”复制前文，也不要跨 block 把“当前负责人”解析成具体人物；
- 条件、否定、例外、数量、时间表达和“建议”“计划”“可能”等原文语气必须保留，
  不能擅自补足。

二、Reference Assertion：
- kind=reference 不承载表格/章节的全部事实，而用自然语言说明“关于什么信息，
  应去哪个当前来源区域继续读取”；
- 只对表格、名单、人员分工、流程清单等明显适合导航的区域生成，不按每个文件或
  每个 Object 机械生成；
- 颗粒度是“用户可能独立询问的信息主题 + 足够小、能直接继续读取的来源区域”。
  拆分后没有产生不同检索路径时，就保持一条；允许覆盖范围重叠；
- 对一组同类 Object 的表格或名单，正文优先使用“主要服务项目”“当前岗位安排”等集合性
  主题描述，不要为了关联成员而在 Reference 正文中逐一枚举所有 Object 名称；
- supporting_block_ids 必须精确指向要回看的表格/列表/章节原文块；如果信息全部在表格 block，
  不要仅因标题提供主题就额外把 heading block 列为依据；
- 此阶段只写导航描述，Object 的 semantic links 由后续 Fragment 阶段基于当前来源确定。

三、共同规则：
- supporting_block_ids 只列直接支持该命题的当前来源块；
- 如果来源明确通过名称括注、简称、英文名、又称、以下简称、即、别名等方式，把两个或多个
  字面表达作为同一 referent 使用，不要把这层名称共指改写成 factual claim，而应提交到
  same_referent_drafts；这些表达方式只是例子，是否共指必须根据当前来源语义判断；
- same_referent_drafts 的每个 mention 只提交 span_text 和 occurrence_index。span_text 必须逐字
  存在于该 draft 的 supporting_block_ids 原文中；occurrence_index 是它在这些块按列出顺序
  拼接的原文中从左到右第几次出现，从 0 开始；至少提交两个不同字面称呼；
- 混合句同时包含名称共指和普通事实时，共指进入 same_referent_drafts，claim 只保留去掉名称
  说明后仍完整成立的事实。例如“A（B）成立于2005年”应得到 A/B 共指草稿与“A成立于2005年”；
- 只保存当前来源明确表达的 referential equivalence。不得因为名称相似、常识、主题相近、共同
  出现或未来可能相连而推断；不得补充原文没有写出的全称、简称或标准名；
- 即使来源使用“以下简称”明确建立文内共指，也只提交能够脱离当前句子、独立指向同一对象的
  真实名称、简称、缩写或别名；“该对象”“本项目”“当前负责人”等依赖语境的代称或临时角色
  不能成为 same_referent_drafts mention。明确的“远航计划”“Project Voyager”“PV”
  可以保留；“项目负责人”“负责人”和“林岚”“主管”不能因此组成同指称名称组；
- “明确表达”要求同一处直接命名构式把这些字面称呼作为等价名称呈现。先出现全称，后文另句
  使用一个看似简称的词，只属于语篇指代，不足以进入 same_referent_drafts；不要跨句搜集别称；
- 例如来源写“远航计划（Project Voyager）”，后文另写“该计划”，只提交
  “远航计划”与“Project Voyager”；不得把“该计划”加入该草稿；
- 不寻找跨来源 identity，不重新讨论 Objecthood，不生成 alias、canonical label 或 Object ID；
- 不判断全局 Object identity，不建立 Relation，不分类 record/viewpoint，不结构化时间，
  不评价长期价值；
- 不分配任何 ID，不输出最终数据库协议，也不进行全局自检；
- context_dependent 不是质量或重要性评价；不要为了把它改成 false 而重新打开已经完成的
  Claim 判断。处理完最后一个 block 后立即提交。

JSON 字符串要求：
- 原文使用中文弯引号“”时优先保留，不要主动转换成 ASCII 双引号 \"；
- statement_markdown 中确实需要 ASCII 双引号时，必须按 JSON string 规则写成 \\\"；
- JSON 结构边界的双引号与自然语言内容中的 ASCII 双引号必须区分；
- 输出必须是标准 JSON parser 可以直接解析的完整对象。

错误：
{"statement_markdown":"项目呈现"两极化"结构"}

正确之一：
{"statement_markdown":"项目呈现“两极化”结构"}

或合法转义：
{"statement_markdown":"项目呈现\\\"两极化\\\"结构"}

只输出一个 JSON 对象，不要输出 Markdown 代码块、说明或其他正文：
{
  "claims":[
    {
      "kind":"grounded",
      "statement_markdown":"可用事实命题",
      "supporting_block_ids":["p0001-b0001"],
      "context_dependent":false
    }
  ],
  "same_referent_drafts":[
    {
      "mentions":[
        {"span_text":"来源中的完整名称","occurrence_index":0},
        {"span_text":"来源中的简称","occurrence_index":0}
      ],
      "supporting_block_ids":["p0001-b0001"]
    }
  ]
}
""".strip()


CONSERVATIVE_ATOMIC_FALLBACK_SYSTEM_PROMPT = """
上一轮来源语义推理发生重复。本轮只使用保守策略稳定完成第一次抽取，
不寻找唯一最优的拆分方案。

按当前 source 原文 block 的顺序处理，每个 block 只处理一次。提取原文明确支持的
grounded Assertion，并对适合导航的表格、名单、分工或流程清单提取 Reference Assertion。
纯标题、目录和承接语自身不形成 grounded Assertion。

如果进一步拆分需要判断以下任何问题，立即停止拆分并保留较完整、较接近原文的表达：
- 是否因为信息能够分别成立或分别变化而继续拆分；
- 是否需要重复共享条件或重建省略主语；
- 是否需要继续拆解目的链、因果链或手段→目标链；
- 是否需要比较两个都合理的粒度方案；
- 是否需要反复处理代词回指；
- 是否需要判断文档元数据还能否继续细拆。

不追求最小粒度。同一规则、机制、流程链或表格行应优先保持内聚；只有主题、来源或
生命周期边界明显不同时拆分。两种表达都合理时，选择更接近原文、更完整的一种。
不要返回已经处理过的 block，不做第二轮全局检查，不证明是否还有遗漏；遗漏事实由后续 Missing
阶段检查。处理完最后一个 block 后立即提交。

能自然、低成本独立化的命题标记 context_dependent=false。需要代词消解、跨句或跨 block
身份推断、省略补全、复制前文或复杂语义重建时，不进行这些工作，直接保留较完整的上下文依赖
表达并标记 context_dependent=true。

除 factual claims 外，只顺手记录当前来源明确表达的同指称：名称括注、简称、英文名、又称、
以下简称、即、别名等把两个或多个字面表达明确作为同一 referent 使用的情况。不要把名称共指
改写成 factual claim。混合句的普通事实仍进入 claims，但去掉名称说明后必须完整成立。
same_referent_drafts 只提交原文连续 span、按 supporting blocks 顺序计算的 occurrence_index 和
真实 supporting_block_ids。只认同一处直接命名构式；后文另句使用的疑似简称不算显式共指。
不得根据相似性、常识或跨来源背景猜测，不补全名称，不生成 Object ID。只保存脱离当前句子后
仍能独立指向同一对象的名称；代词、“该对象”“本项目”等语境指代，以及只在当前时期成立的
临时角色称呼，即使在当前语境中共指，也不要提交。

粒度示例一：
原文：随着业务规模的发展，长期存在的组织架构不合理、经验传承断层等问题日益凸显，
制约了团队进一步服务客户的能力，也消耗了核心成员的热情。
可以输出：
- 随着业务规模的发展，长期存在的组织架构不合理、经验传承断层等问题日益凸显。
- 这些问题制约了团队进一步服务客户的能力。
- 这些问题消耗了核心成员的热情。
不要为了理论原子性，把组织架构不合理和经验传承断层拆成两套带重复条件的命题。

粒度示例二：
原文：记录过去的探索、改革思路及教训，为后来者提供可复用的参考，终结“代际失忆”。
可以保留为一条完整目标命题，不再讨论记录→提供参考→终结失忆是否需要拆成三条。

每条 claim 只使用：
- kind：grounded 或 reference；
- statement_markdown：忠实、可用的现实命题；
- supporting_block_ids：直接支持该命题的当前来源块。
- context_dependent：是否必须回到所属 SourceRegion 才能正确理解命题中的代词、省略或身份指代。

JSON 字符串要求：
- 原文使用中文弯引号“”时优先保留，不要主动转换成 ASCII 双引号 "；
- statement_markdown 中确实需要 ASCII 双引号时，必须按 JSON string 规则写成 \\\"；
- 输出必须是标准 JSON parser 可以直接解析的完整对象。

只输出一个 JSON 对象，不要输出 Markdown 代码块、说明或其他正文：
{
  "claims":[
    {
      "kind":"grounded",
      "statement_markdown":"较完整且贴近原文的命题",
      "supporting_block_ids":["p0001-b0001"],
      "context_dependent":false
    }
  ],
  "same_referent_drafts":[
    {
      "mentions":[
        {"span_text":"来源中的完整名称","occurrence_index":0},
        {"span_text":"来源中的简称","occurrence_index":0}
      ],
      "supporting_block_ids":["p0001-b0001"]
    }
  ]
}
""".strip()


MISSING_CLAIMS_SYSTEM_PROMPT = """
你只负责检查已有 Assertion 是否遗漏了当前来源明确支持的完整知识单元，
或者适合指向表格、名单、人员分工、流程清单的 Reference Assertion。

已有命题已经冻结：不得删除、改写、合并、重排或重新分类它们。只提交原文明确支持、
且现有命题尚未表达的增量命题；没有遗漏时提交空数组。不要为了覆盖标题、目录、承接语、
例子标签或文档说明而制造命题。

一个 cohesive grounded Assertion 已经完整表达的列表项、条件、步骤和子结论都视为 covered。
不要因为一条 Assertion 包含多个相互依赖的事实，就把其中每个 bullet 再次作为遗漏提交。
只有确实未表达的条件、例外、新事实内容或重要关系才能新增。

新增 grounded Assertion 沿用轻量上下文规则：能自然、低成本独立化时标记 context_dependent=false；
需要明显代词消解、跨句/跨 block 身份推断、省略补全或复杂语义重建时，保留可用的上下文依赖
表达并标记 context_dependent=true，不要为了得到独立命题而重新求解整段上下文。

不判断 Object、Relation、record/viewpoint、结构化时间或业务价值，不重新输出已有命题。
每个 claims 元素只能使用 kind、statement_markdown、supporting_block_ids 和 context_dependent，不得
输出 id、claim_id、text、content、source，也不得自行发明其他字段。

只输出一个 JSON 对象，不要输出 Markdown 代码块、说明或其他正文。

无遗漏：
{"claims":[]}

有遗漏：
{
  "claims": [
    {
      "kind": "grounded",
      "statement_markdown": "完整、内聚的知识单元",
      "supporting_block_ids": ["p0001-b0001"],
      "context_dependent": false
    }
  ]
}
""".strip()


OBJECT_FRAGMENT_SYSTEM_PROMPT = """
你只负责把一个 SourceRegion 中已经冻结的 Assertion 与名称语境编译成 Leaf Object Fragment IR。
一次调用同时完成两件高度相关的工作：构造 source-local ObjectFragment，并直接为每条 frozen
claim 生成引用 Fragment 的 Assertion template。处理完成后立即提交，不做全局 identity 判断。

ObjectFragment 的含义：当前 SourceRegion 中，我们认为未来应归属于同一个 Global Object 的
一包局部 reusable naming forms。它不是长期 Object，也不是完整 NLP coreference。

Fragment 构造规则：
- 只保留脱离当前句子后，在其他材料、记录或查询中仍可能再次用于识别同一对象的名称表达；
- 人物、组织、角色、具名活动、活动类别、流程、工作事项、制度、档案、历史事件、平台、
  稳定群体等都可以形成 Fragment；明显只是数量、时间、属性、结果、程度、评价或修辞不形成；
- “它”“该对象”“本项目”“这个组织”“上述活动”“该系统”等临时代词通常不是 reusable name，
  不要求成为 surface form；
- 同一 SourceRegion 中明确称呼同一个对象的 reusable names 放入同一 Fragment；surface forms
  必须能够脱离当前句子后，仍作为同一实体的名称或别名独立指向它。一个 span 即使在当前句子中
  最终 referent 相同，只要必须依赖省略补全、临时角色、上下文或当前文档范围才能完成指代，
  就不是 surface form。一个 span 即使最终 referent 相同，
  只要相比实体名称还包含角色、任期、时间、关系、状态、数量、范围或描述性限定，就不是 alias，
  不得与实体名称合并；只做局部名称同指整合，不因语义相似、主题相关、业务关系或可能连接而
  合并不同对象；
- 真实全称、稳定简称、缩写和明确别名可以共同保留，例如“远航计划”“Project Voyager”
  “PV”可以属于同一 Fragment；但“项目负责人”在后文被省略为“负责人”时，“负责人”
  不能独立识别该角色，不得加入 surface_forms；“林岚”在当前语境中被称为“主管”时，
  “主管”也不是人物别名；“远航计划”被称为“本项目”“该计划”时同理；
- “负责人”“主管”“项目”“系统”等泛称只有在它本身就是当前命题讨论的独立角色或类别 Object
  时，才可以单独形成只包含自身的 Fragment；不得作为更具体 Object 的附加别名；
- 输入中的 source naming hints 是 hard grouping hint：同一 hint 内所有名称必须完整进入同一个
  Fragment，不得遗漏或拆开；不需要重新判断这些名称是否同指；
- 在 hard hint 之外，可以根据当前 SourceRegion 整体语境，把“PV”等后续 reusable name 加入
  已有 Fragment；
- surface_forms 必须有当前编译上下文依据：逐字出现在当前 SourceRegion、reviewed/frozen claims
  或 source naming hint 中。不得发明新别名、纠错名称或输出 canonical/preferred label；
- 每个 surface form 只能属于一个 Fragment；发布者与审阅者等相关但不同的角色必须分开；
- fragment_key 只使用本次输出内临时键 F1、F2、F3……，不得输出 Global Object ID。

Assertion template 与 Object link 规则：
- assertions 必须覆盖输入中的每个 claim_id，恰好一次，顺序与 frozen claims 相同；
- kind 必须与 frozen claim 一致，只能是 grounded 或 reference；
- grounded Assertion 由你直接输出完整 statement_template_markdown，不提交 span、start、end
  或 occurrence_index；
- grounded Assertion 中具有明确语义位置的 Fragment 名称应改写成 {{fragment:F1}} 形式；同一条可以引用
  零个、一个或多个 Fragment；未被 Fragment 化的其余命题内容保留为可理解的完整命题；
- 模板不要求替换后逐字还原 frozen claim，可以做不改变事实含义的轻微语法整理，但不得新增、
  删除或改变原命题的事实、数量、条件、否定、例外、时间与语气；
- context_dependent=true 的 frozen claim 允许继续依赖所属 SourceRegion；不要在本阶段消解代词、
  补全省略或跨 block 绑定身份，程序会原样继承该标记；
- grounded Assertion 的 semantic_fragment_keys 必须为 []；它与 Object 的连接仍只来自正文
  {{fragment:...}} 的 anchored references；
- Reference Assertion 的 statement_template_markdown 是可检索的导航描述，不需要写入被关联
  Object 的名称，也不要为了建立关联强行加入 {{fragment:...}}；有集合性主题描述可用时，
  不得逐一枚举成员名称来替代 semantic links；
- Reference Assertion 的 semantic_fragment_keys 必须列出该来源区域的检索覆盖对象，至少一个；
  它不是对象级事实关系。除表格/名单直接编目且用户会通过其反查来源的成员外，如果当前区域
  明确把项目、成员或活动呈现为某个命名主体的集合，并且用户会通过该主体检索这份集合，也应
  包含该主体 Fragment。不得加入仅作为归属背景、只偶然出现或仅属于某一单元格属性的 Object；
  这些名称必须由当前来源支持，但无需出现在 Reference 正文中；
- 例如某组织的一张表有五个服务项目，可以保留五个服务 Fragment，但只产生一条说明
  “主要服务的名称、形式和定位记录于该表”的 Reference，并将五个项目和被明确呈现为集合主体
  的组织 key 放入 semantic_fragment_keys；不要加入某行历史定位中偶然出现的背景群体 Fragment；
- 名称只存在于 SourceRegion、frozen claim 或 naming hint，没有出现在其他 factual claim 中，
  也仍可合法进入 Fragment；不得为它制造 fake claim；
- 不输出 supporting blocks、时间、Relation、Object type、business role、alias evidence
  graph、Global identity 或长期价值判断。

JSON 字符串要求：
- statement_template_markdown 等自然语言字段需要引用文字时，统一优先使用中文弯引号“”；
- 如果字符串内容确实需要 ASCII 双引号，必须按 JSON string 规则写成 \"；
- 不得在 JSON 字符串内部直接写未转义的 ASCII 双引号 "；
- 输出必须是标准 JSON parser 可以直接解析的完整对象。

示例：
输入命题“审阅者协助发布者工作。”，两个角色不是同一对象：
{
  "fragments":[
    {"fragment_key":"F1","surface_forms":["审阅者"]},
    {"fragment_key":"F2","surface_forms":["发布者"]}
  ],
  "assertions":[
    {"claim_id":"claim-1","kind":"grounded","statement_template_markdown":"{{fragment:F1}}协助{{fragment:F2}}工作。","semantic_fragment_keys":[]}
  ]
}

只输出一个严格 JSON 对象，不要输出 Markdown 代码块、说明或其他正文：
{
  "fragments":[{"fragment_key":"F1","surface_forms":["来源名称","来源简称"]}],
  "assertions":[{"claim_id":"claim-1","kind":"grounded","statement_template_markdown":"{{fragment:F1}}成立于……","semantic_fragment_keys":[]}]
}
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
                same_referent_drafts=submission.same_referent_drafts,
                source_blocks=source_blocks,
                model_calls=initial_calls,
            )
            self._write_json(self.paths.initial_claims_json, initial)
        self.progress.report(
            label,
            (
                f"第一遍完成：{len(initial.claims)} 条命题，"
                f"{len(initial.same_referent_drafts)} 条来源明示同指称草稿"
            ),
        )

        reviewed = None
        if not rebuilt_initial:
            reviewed = self._load_claim_checkpoint(
                self.paths.reviewed_claims_json, node, source_blocks
            )
            if (
                reviewed is not None
                and reviewed.same_referent_drafts != initial.same_referent_drafts
            ):
                reviewed = None
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
                same_referent_drafts=initial.same_referent_drafts,
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
                reviewed.same_referent_drafts,
                source_blocks,
            )
        if object_fragments is None:
            self.progress.report(label, "第三遍：开始构造 Object Fragment 与命题模板")
            submission, fragment_calls = await self._request_json(
                system_prompt=OBJECT_FRAGMENT_SYSTEM_PROMPT,
                user_prompt=_fragment_prompt(
                    source_prompt,
                    reviewed.claims,
                    reviewed.same_referent_drafts,
                ),
                output_model=ObjectFragmentSubmission,
                request_label=f"{label}·Object Fragment Construction",
                validate=lambda value: _validate_fragment_submission(
                    value,
                    reviewed.claims,
                    same_referent_drafts=reviewed.same_referent_drafts,
                    source_blocks=source_blocks,
                ),
            )
            fragments, assertions = _materialize_fragments(
                submission,
                reviewed.claims,
                source_region_id=node.node_id,
            )
            object_fragments = SourceObjectFragmentCheckpoint(
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
            same_referent_drafts=reviewed.same_referent_drafts,
        )
        source_ids = [block.block_id for block in source_blocks]
        model_calls = initial.model_calls + reviewed.model_calls + object_fragments.model_calls
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
                raise ValueError(
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
                        request_label if attempt == 1 else f"{request_label}·clean-retry"
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
        same_referent_drafts: Sequence[SameReferentDraft | SourceSameReferentDraft],
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
        normalized_same_referent = [
            SourceSameReferentDraft(
                same_referent_draft_id=f"same-ref-draft-{position}",
                mentions=item.mentions,
                supporting_block_ids=list(dict.fromkeys(item.supporting_block_ids)),
            )
            for position, item in enumerate(same_referent_drafts, start=1)
        ]
        _validate_same_referent_drafts(normalized_same_referent, source_blocks)
        return SourceClaimCheckpoint(
            source_sha256=self.exploration.source.sha256,
            region_node_id=node.node_id,
            claims=normalized,
            same_referent_drafts=normalized_same_referent,
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
        if not isinstance(raw, dict) or raw.get("schema_version") != "source-claims.v7":
            return None
        checkpoint = SourceClaimCheckpoint.model_validate(raw)
        self._validate_checkpoint_identity(
            checkpoint.source_sha256, checkpoint.region_node_id, node
        )
        _validate_claim_blocks(checkpoint.claims, source_blocks)
        _validate_same_referent_drafts(checkpoint.same_referent_drafts, source_blocks)
        return checkpoint

    def _load_object_fragments_checkpoint(
        self,
        node: RegionNode,
        claims: Sequence[SourceClaim],
        same_referent_drafts: Sequence[SourceSameReferentDraft],
        source_blocks: Sequence[ParsedBlock],
    ) -> SourceObjectFragmentCheckpoint | None:
        if not self.paths.object_fragments_json.exists():
            return None
        raw = json.loads(self.paths.object_fragments_json.read_text(encoding="utf-8"))
        if not isinstance(raw, dict) or raw.get("schema_version") != "source-object-fragments.v5":
            return None
        try:
            checkpoint = SourceObjectFragmentCheckpoint.model_validate(raw)
            self._validate_checkpoint_identity(
                checkpoint.source_sha256, checkpoint.region_node_id, node
            )
            _validate_fragment_checkpoint(
                checkpoint,
                claims,
                same_referent_drafts=same_referent_drafts,
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
        failures = [
            f"{node_id}：{outcome}"
            for node_id, outcome in zip(source_ids, outcomes, strict=True)
            if isinstance(outcome, BaseException)
        ]
        self._write_working(source_ids)
        if failures:
            raise RuntimeError("来源语义编译失败：" + "；".join(failures))

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
                if turn.tool_calls or not turn.content:
                    raise ValueError("Source Time 没有返回 JSON 正文")
                submission = SourceTimeSubmission.model_validate_json(
                    normalize_json_fence(turn.content)
                )
                _validate_source_time(submission, self.blocks)
                return SourceTimeCheckpoint(
                    source_sha256=self.exploration.source.sha256,
                    source_time_text=submission.source_time_text,
                    supporting_block_ids=submission.supporting_block_ids,
                    model_calls=attempt,
                )
            except (ModelRepetitionError, ValidationError, ValueError) as error:
                last_error = error
        assert last_error is not None
        raise ValueError(
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
        if version != "source-semantics-working.v9":
            raise ValueError(f"不支持的来源语义工作断点版本：{version}")
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
    if not isinstance(initial_raw, dict) or initial_raw.get("schema_version") != "source-claims.v7":
        return None
    try:
        initial = SourceClaimCheckpoint.model_validate(initial_raw)
        if source_blocks is not None:
            _validate_claim_blocks(initial.claims, source_blocks)
            _validate_same_referent_drafts(initial.same_referent_drafts, source_blocks)
    except ValidationError:
        return None
    except ValueError:
        return None
    reviewed_raw = json.loads(paths.reviewed_claims_json.read_text(encoding="utf-8"))
    if (
        not isinstance(reviewed_raw, dict)
        or reviewed_raw.get("schema_version") != "source-claims.v7"
    ):
        return None
    try:
        reviewed = SourceClaimCheckpoint.model_validate(reviewed_raw)
        if reviewed.source_sha256 != initial.source_sha256:
            return None
        if reviewed.region_node_id != initial.region_node_id:
            return None
        if reviewed.same_referent_drafts != initial.same_referent_drafts:
            return None
        if source_blocks is not None:
            _validate_claim_blocks(reviewed.claims, source_blocks)
            _validate_same_referent_drafts(reviewed.same_referent_drafts, source_blocks)
    except ValidationError:
        return None
    except ValueError:
        return None
    raw = json.loads(paths.snapshot_json.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("schema_version") != "source-semantics.v9":
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
    if not isinstance(raw, dict) or raw.get("schema_version") != "source-semantics-full.v9":
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
    same_referent_drafts: Sequence[SourceSameReferentDraft],
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
    naming_hints = (
        "\n".join(
            (
                f"- {item.same_referent_draft_id}｜必须同组："
                + " = ".join(mention.span_text for mention in item.mentions)
            )
            for item in same_referent_drafts
        )
        or "（没有 source hard grouping hint）"
    )
    return f"""
[STAGE: construct_object_fragments]

来源上下文：
{source_prompt}

已经冻结的命题：
{rendered}

source naming hints（同一行中的名称必须进入同一个 Fragment）：
{naming_hints}

一次完成 reusable names 的 source-local 同指分组与所有命题的 Fragment template。
surface_forms 只能来自当前 SourceRegion、reviewed/frozen claims 或 source naming hints 中已有的
名称表达；不得发明当前编译上下文没有的名称。
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
    """确认当前快照仍满足 reviewed claims 与 naming hints。"""

    if snapshot.source.sha256 != reviewed.source_sha256:
        raise ValueError("最终快照与 reviewed claims 断点属于不同来源")
    if snapshot.region_node_id != reviewed.region_node_id:
        raise ValueError("最终快照与 reviewed claims 断点属于不同来源节点")
    checkpoint = SourceObjectFragmentCheckpoint(
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
        same_referent_drafts=reviewed.same_referent_drafts,
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
    _validate_same_referent_drafts(submission.same_referent_drafts, source_blocks)


def _validate_same_referent_drafts(
    drafts: Sequence[SameReferentDraft | SourceSameReferentDraft],
    source_blocks: Sequence[ParsedBlock],
) -> None:
    block_map = {block.block_id: block for block in source_blocks}
    seen: set[tuple[tuple[tuple[str, int], ...], tuple[str, ...]]] = set()
    for position, draft in enumerate(drafts, start=1):
        draft_label = getattr(draft, "same_referent_draft_id", f"第 {position} 条同指称草稿")
        block_ids = list(dict.fromkeys(draft.supporting_block_ids))
        unknown = sorted(set(block_ids) - set(block_map))
        if unknown:
            raise ValueError(f"{draft_label} 引用了当前来源之外的原文块：" + ", ".join(unknown))
        distinct_span_texts = {item.span_text for item in draft.mentions}
        if len(distinct_span_texts) < 2:
            raise ValueError(f"{draft_label} 至少需要两个不同字面称呼")
        _validate_independent_surface_forms(
            list(distinct_span_texts),
            declared_equivalence_pairs=_declared_equivalence_pairs([draft]),
        )
        mention_keys = [(item.span_text, item.occurrence_index) for item in draft.mentions]
        if len(set(mention_keys)) != len(mention_keys):
            raise ValueError(f"{draft_label} 重复提交了同一字面 mention")
        source_text = "\n".join(block_map[block_id].markdown for block_id in block_ids)
        for mention in draft.mentions:
            occurrences = _claim_occurrences(source_text, mention.span_text)
            if mention.occurrence_index >= len(occurrences):
                raise ValueError(
                    f"{draft_label} 的 span {mention.span_text!r} 在 supporting blocks 中"
                    f"不存在第 {mention.occurrence_index} 次出现"
                )
        signature = (tuple(mention_keys), tuple(block_ids))
        if signature in seen:
            raise ValueError(f"{draft_label} 与先前同指称草稿重复")
        seen.add(signature)


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
    same_referent_drafts: Sequence[SourceSameReferentDraft],
) -> tuple[str, ...]:
    """返回 Fragment surface form 允许逐字取自的当前编译上下文。"""

    return (
        *(block.markdown for block in source_blocks),
        *(claim.statement_markdown for claim in claims),
        *(mention.span_text for draft in same_referent_drafts for mention in draft.mentions),
    )


_CONTEXT_ONLY_SURFACE_FORMS = {
    "他",
    "她",
    "它",
    "他们",
    "她们",
    "它们",
    "其",
    "该对象",
    "这个对象",
    "那个对象",
}

_CONTEXTUAL_REFERENCE_PREFIXES = (
    "该",
    "这个",
    "那个",
    "这位",
    "上述",
    "前述",
)

_TEMPORAL_ROLE_PREFIXES = ("当前", "现任", "前任", "时任", "本届", "上届", "下届")


def _declared_equivalence_pairs(
    drafts: Sequence[SameReferentDraft | SourceSameReferentDraft],
) -> set[frozenset[str]]:
    """把来源明确的同指称转成可校验的名称对，不引入领域词表。"""

    pairs: set[frozenset[str]] = set()
    for draft in drafts:
        names = list(dict.fromkeys(mention.span_text for mention in draft.mentions))
        for index, left in enumerate(names):
            for right in names[index + 1 :]:
                pairs.add(frozenset((left, right)))
    return pairs


def _validate_independent_surface_forms(
    surface_forms: Sequence[str],
    *,
    declared_equivalence_pairs: set[frozenset[str]] | None = None,
) -> None:
    """拒绝语境指代和无来源同指证据的宽泛缩写，不依赖领域角色词表。"""

    declared_pairs = declared_equivalence_pairs or set()

    for surface_form in surface_forms:
        if surface_form in _CONTEXT_ONLY_SURFACE_FORMS or any(
            surface_form.startswith(prefix) and len(surface_form) > len(prefix)
            for prefix in _CONTEXTUAL_REFERENCE_PREFIXES + _TEMPORAL_ROLE_PREFIXES
        ):
            raise ValueError(
                f"surface form {surface_form!r} 只能依赖当前语境指代，不能作为独立名称或别名"
            )

    if len(surface_forms) <= 1:
        return
    for index, left in enumerate(surface_forms):
        for right in surface_forms[index + 1 :]:
            shorter, longer = sorted((left, right), key=len)
            undeclared_substring = (
                shorter != longer
                and shorter in longer
                and frozenset((left, right)) not in declared_pairs
            )
            if undeclared_substring:
                raise ValueError(
                    f"surface form {shorter!r} 是 {longer!r} 的宽泛子串，"
                    "没有来源明确的同指证据时不能当作该 Object 的别名"
                )


def _validate_fragment_submission(
    submission: ObjectFragmentSubmission,
    claims: Sequence[SourceClaim],
    *,
    same_referent_drafts: Sequence[SourceSameReferentDraft] = (),
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
    grounding_texts = _fragment_grounding_texts(source_blocks, claims, same_referent_drafts)
    declared_pairs = _declared_equivalence_pairs(same_referent_drafts)
    for fragment in submission.fragments:
        _validate_independent_surface_forms(
            fragment.surface_forms,
            declared_equivalence_pairs=declared_pairs,
        )
        for surface_form in fragment.surface_forms:
            previous = surface_to_key.setdefault(surface_form, fragment.fragment_key)
            if previous != fragment.fragment_key:
                raise ValueError(f"surface form {surface_form!r} 被分到多个 Fragment")
            if source_blocks and not any(surface_form in text for text in grounding_texts):
                raise ValueError(
                    f"surface form {surface_form!r} 未在当前 SourceRegion、"
                    "frozen claims 或 source naming hints 出现"
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

    _validate_hard_grouping_hints(same_referent_drafts, surface_to_key)


def _validate_hard_grouping_hints(
    drafts: Sequence[SourceSameReferentDraft],
    surface_to_fragment: dict[str, str],
) -> None:
    for draft in drafts:
        missing = [
            item.span_text for item in draft.mentions if item.span_text not in surface_to_fragment
        ]
        if missing:
            raise ValueError(
                f"{draft.same_referent_draft_id} 的 hard grouping 名称未进入 Fragment："
                + ", ".join(missing)
            )
        fragment_ids = {surface_to_fragment[item.span_text] for item in draft.mentions}
        if len(fragment_ids) != 1:
            raise ValueError(
                f"{draft.same_referent_draft_id} 的 hard grouping 名称被拆到不同 Fragment"
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
    same_referent_drafts: Sequence[SourceSameReferentDraft] = (),
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
    grounding_texts = _fragment_grounding_texts(source_blocks, claims, same_referent_drafts)
    declared_pairs = _declared_equivalence_pairs(same_referent_drafts)
    for fragment in checkpoint.fragments:
        _validate_independent_surface_forms(
            fragment.surface_forms,
            declared_equivalence_pairs=declared_pairs,
        )
        for surface_form in fragment.surface_forms:
            previous = surface_to_fragment.setdefault(surface_form, fragment.fragment_id)
            if previous != fragment.fragment_id:
                raise ValueError(f"surface form {surface_form!r} 被分到多个 Fragment")
            if validate_surface_grounding and not any(
                surface_form in text for text in grounding_texts
            ):
                raise ValueError(
                    f"surface form {surface_form!r} 未在当前 SourceRegion、"
                    "frozen claims 或 source naming hints 出现"
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
    _validate_hard_grouping_hints(same_referent_drafts, surface_to_fragment)


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
    *,
    same_referent_drafts: Sequence[SourceSameReferentDraft] = (),
) -> list[str]:
    covered = {block_id for claim in claims for block_id in claim.supporting_block_ids}
    covered.update(
        block_id for draft in same_referent_drafts for block_id in draft.supporting_block_ids
    )
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
