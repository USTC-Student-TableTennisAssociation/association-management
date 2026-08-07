"""指定内容叶子的对象—叙述—依据完整提取。"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from cold_start.compilation.models import (
    MemoryPackage,
    RegionCompilationArtifact,
    object_assertion_ids,
    object_evidence_ids,
    package_warnings,
    render_statement,
)
from cold_start.document.blocks import format_blocks
from cold_start.document.models import ParsedBlock
from cold_start.global_exploration.models import GlobalExplorationSnapshot
from cold_start.llm.base import ChatModel, ModelTurn
from cold_start.progress import NullProgressReporter, ProgressReporter
from cold_start.region_tree.models import RegionNode
from cold_start.region_tree.runtime import BlockIndex

MAX_PROTOCOL_REPAIRS = 3

BASIC_MEMORY_PROTOCOL_PROMPT = """
你必须严格遵守以下唯一的基础记忆协议。字段名、枚举值和层级都是机器协议，不得改名、
补充近义字段或省略必填字段。

顶层 JSON 只能包含：
- `schema_version`：必填，固定为 `object-assertion-evidence-package.v4`；
- `objects`：Object 数组；
- `assertions`：Assertion 数组；
- `evidence`：Evidence 数组。

一、Object
Object 是能够在当前或后续叙述中被持续指认的对象。人物、组织、角色、活动类别、具体
活动、一次活动、流程、工作事项、制度、档案、历史事件、平台和被原文稳定谈论的群体都
可以成为 Object。

Object 只能包含三个字段：
- `object_id`：当前调用内按 `obj-1`、`obj-2` 递增；
- `label`：当前原文范围内最清楚的首选名称；禁止改成 `name`、`canonical_name` 或
  `primary_name`；
- `aliases`：同一对象在原文中的其他真实称呼；没有则为 `[]`。

Object 不直接保存 Evidence。它的来源由连接该 Object 的 Assertion 所引用的 Evidence
动态追溯。因此每个 Object 必须至少参与一条有效 Assertion；仅仅在原文中看见一个名称，
但原文没有对它形成任何现实命题时，不要创建孤立 Object。`label` 和 `aliases` 仍必须能
从关联 Assertion 的 Evidence 中识别出来。

职位、任期、类别、评价和描述不是名称。例如“25-26任会长”不是人物 alias，而应作为
关于人物和角色的 Assertion。不要仅仅为了把一个普通名词替换成对象引用，就创建 Object。
如果一个短语只是某条叙述中的一次性状态、数量、时间、属性、结果、情绪、评级或目标，
保留在 Assertion 中。原文明示的具名人物、组织、活动和角色即使只出现一次，只要参与
了一条有效 Assertion，仍可成为 Object。无法确认两个称呼是否同一对象时，保留为两个
Object。

标题、表头或列表上方的短语本身可能同时承担两种作用：在文档中它是结构标记，在现实语义
中它也可能命名正文持续谈论的 Object。不能因为标题本身不生成 Assertion，就自动排除它所
命名的现实对象。如果标题明确命名一个活动、流程、工作事项、制度或历史事件，后续正文又
以“常规流程”“特殊审批”“所需材料”“负责人”“时间要求”等省略主语的方式持续陈述它，
应创建该 Object，并把它作为这些 Assertion 的核心对象引用。此时 Evidence 应同时覆盖足以
识别对象名称的标题和支持命题的正文。只有纯粹表示“本章内容”“附录”“概览”等文档位置、
且正文没有对其形成现实命题的标题，才不能成为 Object。

二、Assertion
Assertion 是原文对协会现实世界中的一个或多个 Object 作出的完整原子命题。它不是原文
中任何能够改写成句子的信息。

先经过“现实语义门”，再判断 mode 和原子化：
- 描述协会、活动、人物、角色、工作、制度、历史和实际业务结构的命题，可以进入
  Assertion；
- 描述文档自身如何组织、接下来写什么或去哪里查看的目录、章节标题、概览、承接语、
  列表引导语、表格说明和交叉引用，不生成 Assertion，只用于理解上下文；
- 判断依据是谓词在描述现实对象还是文档结构，不能只看“包括”“分为”等表面词语。

例如“本章分为活动运营、宣传运营和行政工作三个部分”只描述文档结构，不生成
Assertion；“乒协的业务体系由活动运营、宣传运营和行政工作构成”描述真实业务结构，
可以生成 Assertion。不得为了覆盖原文块，把“本章将介绍……”改写成关于协会现实的
命题。

同样，标题“体育场馆申请”本身不生成“本节介绍体育场馆申请”的 Assertion；但若下文写
“常规流程：提前向管指委申请并经保卫处审批”，标题已经给出了省略的现实主语。应创建
Object“体育场馆申请”，并生成类似：
`{{object:体育场馆申请}}的常规流程要求提前向{{object:管指委}}申请，并经`
`{{object:保卫处}}审批。`

- `record`：原文把存在、身份、状态、事件、做法、结果或正式规范作为记录来陈述；
- `viewpoint`：原文表达某个人或组织的解释、评价、建议、目标、方案、情绪或预测。

两个信息如果可以分别变化、分别成立，应拆成两条 Assertion；使命题成立所必需的条件、
否定、例外、数量单位和时间范围必须与核心谓词保留在同一条。每条叙述脱离列表符号和
相邻叙述后仍应完整可理解。原文没有写明原因、结果、范围或普遍性时不得补全。

Assertion 只能包含八个字段：
- `assertion_id`：当前调用内按 `assert-1`、`assert-2` 递增；
- `mode`：只能是 `record` 或 `viewpoint`；
- `statement_template_markdown`：使用 `{{object:obj-1}}` 引用同一包内 Object；
- `holder_object_id`：观点持有者 Object ID；仅 `viewpoint` 可以填写，`record` 必须为
  `null`；观点持有者未明示时也为 `null`；
- `temporal_scope`：命题成立时间的结构化判断，包含 `kind`、`display`、`start`、`end`、
  `precision`、`confidence`；
- `temporal_basis_markdown`：一小段时间判断依据，必须说明时间来自原文明示、文档成文背景、
  章节上下文，还是无法判断；
- `uncertainty_markdown`：原文明示的不确定性，没有则为 `null`；
- `evidence_ids`：支持这条叙述的 Evidence ID 数组。

程序会从 `statement_template_markdown` 自动推导涉及对象，禁止输出 `about_object_ids`。
只要模板中的词是在指认已经提取的 Object，就必须使用对象引用；这不意味着每个普通
名词都要先创建 Object。名称文字本身是叙述内容时，对象使用引用，被陈述的名称保留为
中文引号中的字面值，例如：
`{{object:obj-1}}在该手册中被写作“中国科学技术大学学生乒乓球协会”。`

对象引用必须完整，而不只是“至少有一个”。如果同一条 Assertion 同时陈述活动、工作步骤、
人物或角色之间的事实，凡是已经作为 Object 提取且在命题中实际充当参与者的对象，都必须
在模板对应位置写成 `{{object:对象ID}}`。不能因为模板已有一个 Object 引用，就把其他已有
Object 继续保留成普通文字。反过来，时间、数量、状态和一次性普通名词仍留作字面内容，
不能为增加引用而制造 Object。

每条 Assertion 都必须明确填写时间，不允许用 `null` 回避：
- `kind` 只能是 `point`、`range`、`open_range`、`general`、`unknown`；
- `point` 只填 `start`；`range` 同时填 `start`、`end`；`open_range` 只填一个边界；
  `general` 和 `unknown` 的两个边界都为 `null`；
- `precision` 只能是 `day`、`month`、`semester`、`academic_year`、`year`、`unspecified`；
- `confidence` 只能是 `high`、`medium`、`low`；`display` 使用便于人阅读的简短中文；
- 原文明示日期或时期，优先按原文记录；当前原文未明示时，可以依据本文件的成文时间、
  明确章节时期和父级上下文作保守推断，但必须降低 confidence，并在
  `temporal_basis_markdown` 中披露推断来源；仍无法定位时使用 `unknown`；
- 持续适用且没有可定位起止时间的常设身份或一般规则可使用 `general`，不能为了填字段
  虚构年份；“每周”“T-7”等频率或相对时点属于命题正文，不代替 Assertion 的有效时期。

三、Evidence
Evidence 是支持 Assertion 的精确连续原文块范围，不复制原文正文。Object 的依据通过
连接它的 Assertion 间接追溯。

Evidence 只能包含四个字段：
- `evidence_id`：当前调用内按 `evidence-1`、`evidence-2` 递增；
- `start_block_id`：依据范围第一个 block_id；
- `end_block_id`：依据范围最后一个 block_id；单块依据与 start 相同；
- `note_markdown`：只有确需说明依据作用时填写，否则为 `null`。

禁止输出 `block_id`、`block_ids`、`block_range`、`text` 或 `text_segment`。每条 Assertion
必须引用 Evidence。不要建立无用途的独立摘录；如果某条 Evidence 最终没有被任何
Assertion 引用，程序会保留结果但产生人工复核警告。

四、提交前硬性校验
以下不是建议。违反任意一项都会被程序拒绝；输出前必须逐项检查：

1. 顶层必须包含正确的 `schema_version` 以及 `objects`、`assertions`、`evidence` 三个
   数组，不得增加其他顶层字段。如果当前原文只有文档导航而没有现实命题，三个数组应
   全部为空；不能为避免空结果制造 Assertion，也不能只提交 Evidence。
2. Object、Assertion、Evidence 的 ID 必须分别唯一，严格使用 `obj-数字`、
   `assert-数字`、`evidence-数字`，不能自行添加 `region-xxxx/` 前缀。
3. 每个 Object 的 `label` 必须非空，`aliases` 内不得出现重复值；Object 不能包含
   `evidence_ids`。每个 Object 必须至少被一条 Assertion 的模板引用，或作为该 Assertion
   的 `holder_object_id`，否则会被视为孤立对象并拒绝。
4. 每条 Assertion 的 `statement_template_markdown` 必须非空，并且至少包含一个
   `{{object:对象ID}}`；零对象引用会被拒绝。每个模板对象 ID 都必须存在于本包
   `objects` 中。通过机器的“至少一个引用”只代表格式合法，不代表语义完整；提交前还必须
   检查命题真正描述的活动、流程或工作事项是否已作为核心对象引用。审批部门、负责人、
   地点、例子等外围参与者不能替代缺失的核心工作对象。
5. 每条 Assertion 至少引用一个 Evidence，且所有 `evidence_ids` 都必须存在于本包。
   `holder_object_id` 非空时也必须存在于本包 `objects` 中。
6. `mode` 只能是 `record` 或 `viewpoint`；`record` 的 `holder_object_id` 必须为 `null`。
7. 每条 Evidence 的 start 和 end 都必须是本次提供的原文 block_id，整个连续范围必须
   完全位于当前节点自有原文内；end 不得位于 start 之前。
8. 可空字段没有内容时必须使用 `null`，不能使用空字符串；时间结构和时间依据不可为空。
   不得省略协议规定的字段，
   也不得在 Object、Assertion 或 Evidence 中增加协议外字段。
9. 安全上限：`label` 最多150字符，Assertion 正文最多3000字符，可选说明最多500字符；
   单项引用或 alias 数组最多100项。正常提取不应接近这些上限。

合法结构示例（正式回答不要输出 Markdown 围栏）：
{
  "schema_version": "object-assertion-evidence-package.v4",
  "objects": [
    {
      "object_id": "obj-1",
      "label": "乒协",
      "aliases": ["中国科大乒协"]
    },
    {
      "object_id": "obj-2",
      "label": "魏汉东",
      "aliases": []
    }
  ],
  "assertions": [
    {
      "assertion_id": "assert-1",
      "mode": "record",
      "statement_template_markdown": "{{object:obj-1}}当时有约15名核心干事。",
      "holder_object_id": null,
      "temporal_scope": {
        "kind": "point",
        "display": "2024年",
        "start": "2024",
        "end": null,
        "precision": "year",
        "confidence": "high"
      },
      "temporal_basis_markdown": "原文明确写出2024年。",
      "uncertainty_markdown": null,
      "evidence_ids": ["evidence-1"]
    },
    {
      "assertion_id": "assert-2",
      "mode": "viewpoint",
      "statement_template_markdown": "{{object:obj-2}}建议{{object:obj-1}}持续优化内部管理。",
      "holder_object_id": "obj-2",
      "temporal_scope": {
        "kind": "unknown",
        "display": "时间不明",
        "start": null,
        "end": null,
        "precision": "unspecified",
        "confidence": "low"
      },
      "temporal_basis_markdown": "原文及当前上下文没有给出可定位时间。",
      "uncertainty_markdown": null,
      "evidence_ids": ["evidence-1"]
    }
  ],
  "evidence": [
    {
      "evidence_id": "evidence-1",
      "start_block_id": "p0001-b0001",
      "end_block_id": "p0001-b0001",
      "note_markdown": null
    }
  ]
}

最终正文必须是一个合法 JSON 对象，不使用 Markdown 围栏，不输出解释文字、注释或尾随
逗号。JSON 字符串内部需要引号时优先使用中文引号“”，如必须使用英文双引号则写成
`\"`。可空字段没有内容时必须使用 `null`，不能使用空字符串。
""".strip()

LEAF_COMPILATION_SYSTEM_PROMPT = f"""
{BASIC_MEMORY_PROTOCOL_PROMPT}

你在对一段协会文档原文进行完整的基础记忆提取。当前阶段只忠实提取 Object、
Assertion、Evidence，不建立知识图，不按业务视角连线，也不评价长期价值。

只有带 block_id 的当前节点自有原文是事实依据。文档背景和区域路径只用于理解简称、
省略、时间和上下文，不能成为时间以外的新信息依据；依赖它们推断时间时必须在时间依据中
明示且降低置信度。按 block_id 从头到尾检查现实命题，不按“是否
重要”删减，特别检查表格、列表中的名称、数值、时间、条件、例外、职责、步骤、结果和
观点。排除文档导航不是价值筛选，而是基础记忆的语义边界。

标题、概览和承接语可以帮助识别原文实际谈论的对象，但不能仅凭它们生成“本章介绍了
什么”一类 Assertion。标题命名现实活动、流程或工作事项，而正文以省略主语的方式描述其
流程、条件、材料、角色或结果时，必须把标题对象补回相关 Assertion；不能只引用正文中的
审批部门、人员、地点或举例对象。“位于第几章”“是某个子节”“在文档中统领下文”等文档
编排信息不是协会记忆。低权威上下文不能提供当前原文没有出现的别名、事实或评价。

逐块思考并自检后，严格按上述协议在正文输出完整 JSON。三个数组即使为空也不能省略；
每个被引用的对象 ID 和 Evidence ID 都必须在同一 JSON 中存在。没有现实命题时提交三个
空数组。
""".strip()

COVERAGE_REVIEW_SYSTEM_PROMPT = f"""
{BASIC_MEMORY_PROTOCOL_PROMPT}

你是同一来源节点的覆盖复核者。输入包含完整原文和第一次已经通过机器协议校验的结果。
第一次结果是基线：默认保留其中的 ID、对象边界、正确叙述和 Evidence，只在当前原文能
明确证明存在遗漏或错误时修改。不要因为存在另一种也说得通的对象切法，就重新设计整个
对象集合；不要仅为替换一个一次性普通名词而新增 Object。

逐块检查是否遗漏原文明示的对象或原子叙述，是否错误合并了能够分别变化、分别成立的
信息，尤其检查表格字段、人物、数值、时间、条件、例外、职责、步骤、结果和观点。检查
每条对象引用、观点持有者和 Evidence 是否真实受原文支持。
同时检查引用是否完整：逐条比较 Assertion 正文、已有 Object 的 label/aliases 和原文；如果
命题明确谈论某个已经提取的 Object，却仍把其名称保留为普通文字，必须在替代结果中改为
对应对象引用。同名对象无法由当前原文消歧时不要猜测。

额外执行“核心谓词锚点检查”：每条 Assertion 真正是在描述谁或什么活动、流程、工作事项？
如果它只引用了审批部门、负责人、地点、工具或例子，却没有引用规则、步骤或实践实际所属
的核心工作对象，不能因为已经存在至少一个对象引用就判定完整。检查当前区域标题和紧邻
上文是否命名了正文省略的现实主语；若“体育场馆申请”之类标题命名了真实流程，而正文以
“常规流程”“特殊审批”等继续陈述它，应新增该流程 Object，并修订相关 Assertion 与
Evidence。标题仍不生成文档结构 Assertion；它只为正文中已有的现实命题补全对象锚点。

同时重新执行现实语义门：删除把章节标题、目录、概览、承接语、列表引导语、表格说明
或交叉引用编译成“本章介绍了什么”的 Assertion。只有相似文字确实在描述协会现实中的
业务结构时才保留。

输出能够完全替代第一次结果的完整 JSON，而不是增量。仍然不建立 Relation，不按长期
价值筛选，不生成章节关系或原文没有表达的信息。输出前逐字段对照上述唯一协议，正文
只输出合法 JSON。
""".strip()


@dataclass(frozen=True)
class LeafArtifactPaths:
    directory: Path
    snapshot_json: Path
    report_markdown: Path
    model_streams: Path


class LeafBasicCompiler:
    """完整提取一个节点拥有的内容原文，并用第二次调用复核覆盖。"""

    def __init__(
        self,
        *,
        model: ChatModel,
        exploration: GlobalExplorationSnapshot,
        blocks: tuple[ParsedBlock, ...],
        progress: ProgressReporter | None = None,
    ) -> None:
        self.model = model
        self.exploration = exploration
        self.blocks = blocks
        self.index = BlockIndex(blocks)
        self.progress = progress or NullProgressReporter()
        self.nodes = {node.node_id: node for node in exploration.region_tree.nodes}

    async def compile(self, leaf_node_id: str) -> RegionCompilationArtifact:
        leaf = self._leaf(leaf_node_id)
        return await self._compile_node(leaf)

    async def compile_owned_source(self, node_id: str) -> RegionCompilationArtifact:
        """编译叶子或分支节点直接拥有的 content_source 原文。"""

        if node_id not in self.nodes:
            raise ValueError(f"区域树中不存在节点 {node_id}")
        node = self.nodes[node_id]
        if node.owned_source_role != "content_source" or not node.owned_segments:
            raise ValueError(f"{node_id} 没有可编译的 content_source 自有原文")
        return await self._compile_node(node)

    async def _compile_node(self, node: RegionNode) -> RegionCompilationArtifact:
        source_blocks = self._owned_blocks(node)
        lineage = self._lineage(node)
        source_prompt = _leaf_prompt(
            document_context=self.exploration.document_context_markdown,
            lineage=lineage,
            node=node,
            blocks=source_blocks,
        )
        label = f"基础编译·{node.node_id}"
        self.progress.report(label, f"开始完整提取：{node.label}")

        package, extraction_calls = await self._request_package(
            messages=[
                {"role": "system", "content": LEAF_COMPILATION_SYSTEM_PROMPT},
                {"role": "user", "content": source_prompt},
            ],
            source_blocks=source_blocks,
            request_label=f"{label}·提取",
        )
        self.progress.report(
            label,
            f"首次提取：对象 {len(package.objects)}，叙述 {len(package.assertions)}",
        )

        reviewed, review_calls = await self._request_package(
            messages=[
                {"role": "system", "content": COVERAGE_REVIEW_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": _coverage_review_prompt(source_prompt, package),
                },
            ],
            source_blocks=source_blocks,
            request_label=f"{label}·覆盖复核",
        )

        covered, uncovered = self._source_coverage(reviewed, source_blocks)
        warnings = package_warnings(reviewed)
        if uncovered:
            warnings.append(
                "以下原文块未被任何依据覆盖，需人工判断是否遗漏："
                + ", ".join(uncovered)
            )
        for warning in warnings:
            self.progress.report(label, f"保留待复核警告：{warning}")

        model_calls = extraction_calls + review_calls
        self.progress.report(
            label,
            (
                f"完成：对象 {len(reviewed.objects)}，叙述 {len(reviewed.assertions)}，"
                f"依据 {len(reviewed.evidence)}，原文覆盖 {len(covered)}/{len(source_blocks)}，"
                f"模型调用 {model_calls} 次"
            ),
        )
        return RegionCompilationArtifact(
            created_at=datetime.now(UTC),
            source=self.exploration.source,
            region_tree_schema_version=self.exploration.region_tree.schema_version,
            region_node_id=node.node_id,
            label=node.label,
            lineage_node_ids=[item.node_id for item in lineage],
            start_block_id=node.start_block_id,
            end_block_id=node.end_block_id,
            source_pages=sorted(
                {page for block in source_blocks for page in block.source_pages}
            ),
            source_block_ids=[item.block_id for item in source_blocks],
            covered_block_ids=covered,
            uncovered_block_ids=uncovered,
            package=reviewed,
            model_calls=model_calls,
            warnings=warnings,
        )

    async def _request_package(
        self,
        *,
        messages: list[Mapping[str, Any]],
        source_blocks: tuple[ParsedBlock, ...],
        request_label: str,
    ) -> tuple[MemoryPackage, int]:
        conversation = list(messages)
        turn = await self.model.complete_turn(
            messages=conversation,
            request_label=request_label,
            thinking="enabled",
        )
        calls = 1
        repairs = 0
        while True:
            try:
                return self._parse(turn, source_blocks), calls
            except (ValidationError, ValueError, json.JSONDecodeError) as error:
                failure_kind = _failure_kind(error)
                if repairs >= MAX_PROTOCOL_REPAIRS:
                    raise
                repairs += 1
                self.progress.report(
                    request_label,
                    (
                        f"{failure_kind} 校验失败，进行第 {repairs}/"
                        f"{MAX_PROTOCOL_REPAIRS} 次定向修复：{error}"
                    ),
                )
                conversation = _repair_messages(conversation, turn, error)
                turn = await self.model.complete_turn(
                    messages=conversation,
                    request_label=f"{request_label}·修复{repairs}",
                    thinking="enabled",
                )
                calls += 1

    def _leaf(self, node_id: str) -> RegionNode:
        if node_id not in self.nodes:
            raise ValueError(f"区域树中不存在节点 {node_id}")
        node = self.nodes[node_id]
        if node.status != "leaf":
            raise ValueError(f"{node_id} 不是叶子节点")
        if node.owned_source_role != "content_source":
            raise ValueError(f"{node_id} 不是内容来源叶子")
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
            blocks.extend(
                self.index.slice(segment.start_block_id, segment.end_block_id)
            )
        return tuple(blocks)

    def _parse(
        self,
        turn: ModelTurn,
        source_blocks: tuple[ParsedBlock, ...],
    ) -> MemoryPackage:
        if turn.tool_calls:
            raise ValueError("基础编译必须返回正文 JSON，不能调用工具")
        payload = json.loads(_json_object(turn.content))
        if payload.get("schema_version") != "object-assertion-evidence-package.v4":
            raise ValueError(
                "schema_version 必须为 object-assertion-evidence-package.v4"
            )
        package = MemoryPackage.model_validate(payload)
        submitted_ids = [
            *(item.object_id for item in package.objects),
            *(item.assertion_id for item in package.assertions),
            *(item.evidence_id for item in package.evidence),
        ]
        if any("/" in value for value in submitted_ids):
            raise ValueError("基础来源只能提交当前调用内的临时 ID，不能自行添加节点前缀")
        self._validate_evidence_ranges(package, source_blocks)
        return package

    def _validate_evidence_ranges(
        self,
        package: MemoryPackage,
        source_blocks: tuple[ParsedBlock, ...],
    ) -> None:
        allowed = {block.block_id for block in source_blocks}
        for evidence in package.evidence:
            evidence_blocks = self.index.slice(
                evidence.start_block_id,
                evidence.end_block_id,
            )
            if any(block.block_id not in allowed for block in evidence_blocks):
                raise ValueError(
                    f"依据 {evidence.evidence_id} 超出当前节点自有原文："
                    f"{evidence.start_block_id} → {evidence.end_block_id}"
                )

    def _source_coverage(
        self,
        package: MemoryPackage,
        blocks: tuple[ParsedBlock, ...],
    ) -> tuple[list[str], list[str]]:
        covered: set[str] = set()
        for evidence in package.evidence:
            for block in self.index.slice(
                evidence.start_block_id,
                evidence.end_block_id,
            ):
                covered.add(block.block_id)
        source_ids = [block.block_id for block in blocks]
        return (
            [block_id for block_id in source_ids if block_id in covered],
            [block_id for block_id in source_ids if block_id not in covered],
        )


def load_exploration_inputs(
    run_directory: Path,
) -> tuple[GlobalExplorationSnapshot, tuple[ParsedBlock, ...]]:
    directory = run_directory.expanduser().resolve()
    snapshot_path = directory / "global-exploration.json"
    blocks_path = directory / "parsed-blocks.json"
    if not snapshot_path.is_file() or not blocks_path.is_file():
        raise ValueError("运行目录缺少 global-exploration.json 或 parsed-blocks.json")
    exploration = GlobalExplorationSnapshot.model_validate_json(
        snapshot_path.read_text(encoding="utf-8")
    )
    raw_blocks = json.loads(blocks_path.read_text(encoding="utf-8"))
    blocks = tuple(ParsedBlock.model_validate(item) for item in raw_blocks)
    if len(blocks) != exploration.source.block_count:
        raise ValueError("parsed-blocks.json 与全局勘探快照的块数量不一致")
    return exploration, blocks


def create_leaf_artifact_paths(
    run_directory: Path,
    leaf_node_id: str,
) -> LeafArtifactPaths:
    directory = (
        run_directory.expanduser().resolve()
        / "basic-compilations"
        / f"{datetime.now(UTC):%Y%m%dT%H%M%S%fZ}-{leaf_node_id}"
    )
    directory.mkdir(parents=True, exist_ok=False)
    model_streams = directory / "model-streams"
    model_streams.mkdir()
    return LeafArtifactPaths(
        directory=directory,
        snapshot_json=directory / "basic-compilation.json",
        report_markdown=directory / "basic-compilation.md",
        model_streams=model_streams,
    )


def write_leaf_artifact(
    paths: LeafArtifactPaths,
    artifact: RegionCompilationArtifact,
    blocks: tuple[ParsedBlock, ...],
) -> None:
    paths.snapshot_json.write_text(
        artifact.model_dump_json(indent=2),
        encoding="utf-8",
    )
    source_blocks = _artifact_blocks(artifact, blocks)
    paths.report_markdown.write_text(
        _render_artifact(artifact, source_blocks),
        encoding="utf-8",
    )


def _leaf_prompt(
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
    ranges = "、".join(
        f"{segment.start_block_id} → {segment.end_block_id}"
        for segment in node.owned_segments
    )
    return f"""
[STAGE: extract_complete_basic_memory]

文档背景（低权威上下文）：
{document_context}

根节点到当前叶子的区域路径（低权威上下文）：
{path}

当前节点自有原文范围：{ranges}

当前节点完整自有原文（唯一事实依据，多个范围之间可能不连续）：
{format_blocks(blocks)}

从第一个 block_id 顺序读到最后一个，完整提取对象和叙述。不要分析或提交 Relation。
认真分析、自检交叉引用，然后在正文输出完整 JSON 结果。
""".strip()


def _coverage_review_prompt(
    source_prompt: str,
    package: MemoryPackage,
) -> str:
    return f"""
[STAGE: review_complete_basic_memory]

第一次提取使用的文档背景、区域路径和完整原文：
{source_prompt}

第一次结构化结果：
{package.model_dump_json(indent=2)}

逐块比较原文与第一次结果，贯彻原子化标准，输出复核后的完整替代 JSON。
""".strip()


def _repair_messages(
    original: Sequence[Mapping[str, Any]],
    turn: ModelTurn,
    error: Exception,
) -> list[Mapping[str, Any]]:
    messages = [*original, turn.as_assistant_message()]
    messages.append(
        {
            "role": "user",
            "content": (
                "程序拒绝了上一次正文 JSON。这是协议修复，不是重新进行语义提取："
                "除非错误本身要求改变，否则保留原有 ID、对象、叙述和依据，只做最小修复。"
                "即使当前只报告 JSON 语法错误，修复后也必须逐字段对照系统消息中的唯一"
                "协议，主动检查尚未暴露的字段名、枚举、null、对象引用和 Evidence 引用。"
                "重新输出包含 schema_version、objects、assertions、evidence 的完整替代 "
                f"JSON，不能只输出补丁。程序错误：{error}"
            ),
        }
    )
    return messages


def _json_object(raw: str) -> str:
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end < start:
        raise ValueError("模型正文中不存在 JSON 对象")
    return raw[start : end + 1]


def _failure_kind(error: Exception) -> str:
    if isinstance(error, json.JSONDecodeError):
        return "json"
    if isinstance(error, ValidationError) and any(
        item["type"] == "json_invalid" for item in error.errors()
    ):
        return "json"
    if isinstance(error, ValueError) and "不存在 JSON 对象" in str(error):
        return "json"
    return "protocol"


def _artifact_blocks(
    artifact: RegionCompilationArtifact,
    blocks: tuple[ParsedBlock, ...],
) -> tuple[ParsedBlock, ...]:
    by_id = {block.block_id: block for block in blocks}
    return tuple(by_id[block_id] for block_id in artifact.source_block_ids)


def _render_artifact(
    artifact: RegionCompilationArtifact,
    source_blocks: tuple[ParsedBlock, ...],
) -> str:
    package = artifact.package
    objects_by_id = {item.object_id: item for item in package.objects}
    lines = [
        f"# {artifact.label}",
        "",
        f"> 区域：`{artifact.region_node_id}`",
        f"> 原文：`{artifact.start_block_id}` → `{artifact.end_block_id}`",
        f"> 模型调用：{artifact.model_calls}",
        f"> 原文覆盖：{len(artifact.covered_block_ids)}/{len(artifact.source_block_ids)}",
        "",
        "## 待复核警告",
        "",
        *(f"- {warning}" for warning in artifact.warnings),
        *([] if artifact.warnings else ["无。"]),
        "",
        "## 对象",
        "",
    ]
    for item in package.objects:
        aliases = f"｜别名：{', '.join(item.aliases)}" if item.aliases else ""
        assertions = object_assertion_ids(package, item.object_id)
        evidence = object_evidence_ids(package, item.object_id)
        lines.append(
            f"- `{item.object_id}` **{item.label}**{aliases}｜"
            f"关联叙述 {', '.join(assertions)}｜间接依据 {', '.join(evidence)}"
        )
    if not package.objects:
        lines.append("无。")
    lines.extend(["", "## 叙述", ""])
    for item in package.assertions:
        metadata = [f"对象 {', '.join(item.referenced_object_ids)}"]
        if item.holder_object_id:
            metadata.append(f"持有者 {item.holder_object_id}")
        metadata.append(
            f"时间 {item.temporal_scope.display}（{item.temporal_scope.kind}/"
            f"{item.temporal_scope.confidence}）"
        )
        metadata.append(f"时间依据 {item.temporal_basis_markdown}")
        if item.uncertainty_markdown:
            metadata.append(f"不确定性 {item.uncertainty_markdown}")
        metadata.append(f"依据 {', '.join(item.evidence_ids)}")
        lines.append(
            f"- `{item.assertion_id}`｜{item.mode}｜"
            f"{render_statement(item, objects_by_id)}｜"
            + "｜".join(metadata)
        )
        lines.append(f"  - 模板：`{item.statement_template_markdown}`")
    if not package.assertions:
        lines.append("无。")
    lines.extend(["", "## 依据", ""])
    lines.extend(
        f"- `{item.evidence_id}`｜`{item.start_block_id}` → `{item.end_block_id}`"
        f"{f'｜{item.note_markdown}' if item.note_markdown else ''}"
        for item in package.evidence
    )
    if not package.evidence:
        lines.append("无。")

    evidence_by_block: dict[str, list[str]] = {
        block.block_id: [] for block in source_blocks
    }
    positions = {block.block_id: index for index, block in enumerate(source_blocks)}
    for evidence in package.evidence:
        left = positions[evidence.start_block_id]
        right = positions[evidence.end_block_id]
        for block in source_blocks[left : right + 1]:
            evidence_by_block[block.block_id].append(evidence.evidence_id)
    lines.extend(["", "## 原文逐块覆盖", ""])
    for block in source_blocks:
        references = evidence_by_block[block.block_id]
        marker = "已覆盖" if references else "未覆盖"
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
