"""全局勘探各阅读路径的提示词。"""

from __future__ import annotations

import json

from cold_start.global_exploration.models import ConceptSketch, ReconciliationReview
from cold_start.global_exploration.units import ReadingUnit

BASE_SYSTEM_PROMPT = """
你正在为一个组织知识库执行“全局勘探”，对象是一份历史手册 PDF。
这一步只形成低权威的初步印象，不创建长期记忆卡片，不生成最终图连线，也不把猜测写成事实。
只根据提供的原文工作；保留不确定性；引用来源时使用“〔第 N 页〕”。
""".strip()


def summary_prompt(*, title: str, unit: ReadingUnit, current_draft: str) -> str:
    return f"""
[ROUTE: summary]
你沿“全局总结”阅读路径从文档开头依次阅读。当前阅读单元是{unit.page_label}。

这一条路径只关注：
- 文档是什么、为什么存在、面向谁；
- 覆盖范围与不覆盖范围；
- 它试图长期传递的主要目标、主题与基本立场；
- 随阅读推进修正先前印象。

不要描述详细章节树，不要枚举细粒度概念，不要把实践描述提升为制度。
请把旧稿更新为一份完整、可独立阅读的 Markdown 总结，而不是追加笔记。
重要判断必须带页码；信息尚不足时明确写“初步判断”或“不确定”。

文档标题：{title}

当前总结旧稿：
{current_draft or "（尚无旧稿，这是第一次阅读）"}

本次原文：
{unit.content}
""".strip()


def structure_prompt(*, title: str, unit: ReadingUnit, current_draft: str) -> str:
    return f"""
[ROUTE: structure]
你沿“文档结构”阅读路径从文档开头依次阅读。当前阅读单元是{unit.page_label}。

这一条路径不负责概括知识内容，而负责解释作者怎样组织这份文档：
- 显式章节、隐含部分和边界；
- 各部分承担什么叙述功能；
- 前后部分如何承接、引用或依赖；
- 哪些地方像主题切换、附录、例子、历史记录或操作说明；
- 目录与实际内容不一致时说明差异。

输出保持自由的 Markdown 说明，不受固定数据结构约束。
请更新为一份完整结构说明，不要只追加本次页面。
不要根据标题杜撰未读内容；引用判断时使用页码。

文档标题：{title}

当前结构说明旧稿：
{current_draft or "（尚无旧稿，这是第一次阅读）"}

本次原文：
{unit.content}
""".strip()


def concept_prompt(*, title: str, unit: ReadingUnit, current: ConceptSketch) -> str:
    schema = json.dumps(ConceptSketch.model_json_schema(), ensure_ascii=False)
    current_json = current.model_dump_json(indent=2)
    return f"""
[ROUTE: concept]
你沿“全局信号与候选概念”阅读路径从文档开头依次累积初步概念。
当前阅读单元是{unit.page_label}。

请主动判断重要性，但保持克制：
- global_signals：高频出现、跨章节复用、明显影响后续理解的信号；
- candidate_concepts：可能值得后续编译成活动、工作流、原则、实践、规则等记忆的较大概念；
- coarse_relations：只记录较大概念间可能存在的粗关系，绝不是最终图连线；
- 同义词要合并，重复出现时累积页码并更新 occurrence_count；
- 不要因为一个名词出现一次就创建候选；
- “重要性”允许自由文字判断，必须同时解释理由；
- 经验、灰色实践和硬性要求不得混为一类；
- 不确定内容留在 uncertainty、uncertainties 或 open_questions。

输出更新后的完整 JSON 对象，只输出 JSON，不要代码围栏。

文档标题：{title}

当前累计状态：
{current_json}

本次原文：
{unit.content}

JSON Schema：
{schema}
""".strip()


def reconciliation_prompt(
    *,
    title: str,
    summary_markdown: str,
    structure_markdown: str,
    concept_sketch: ConceptSketch,
    source_index: str,
) -> str:
    schema = json.dumps(ReconciliationReview.model_json_schema(), ensure_ascii=False)
    return f"""
[ROUTE: reconciliation]
三条相互独立的阅读路径已经完成。现在只做“初步印象能否冻结”的交叉校验。
不要把三份结果合并成最终知识图谱，也不要要求它们在关注点上完全一致。

检查：
- 三份结果对文档身份、范围和主要部分是否明显冲突；
- 是否有把经验误写成硬性要求、把例子误写成普遍规律的情况；
- 是否有重要部分在三个结果中都被漏掉；
- 粗关系是否超出了原文证据；
- 页码和来源索引是否支持关键判断。

若问题可通过回看局部原文修复：
- accepted_as_initial_impression=false；
- 在 issues 中列出需要回看的路径、页码和明确的修订指令。
只有会影响后续局部编译的问题才设为 high。
若剩余问题不妨碍它作为低权威初步印象，可接受并放入 unresolved_uncertainties。
只输出符合 Schema 的完整 JSON。

文档标题：{title}

全局总结：
{summary_markdown}

文档结构说明：
{structure_markdown}

概念草图：
{concept_sketch.model_dump_json(indent=2)}

逐页来源索引（仅用于快速核对，不代表完整原文）：
{source_index}

JSON Schema：
{schema}
""".strip()


def revision_prompt(
    *,
    route: str,
    title: str,
    current_output: str,
    issue_instructions: str,
    source_excerpt: str,
    concept_schema: str | None = None,
) -> str:
    output_rule = (
        "输出修订后的完整 JSON 对象，不要代码围栏。"
        if route == "concept"
        else "输出修订后的完整 Markdown，不要解释修订过程。"
    )
    schema_part = f"\nJSON Schema：\n{concept_schema}" if concept_schema else ""
    return f"""
[ROUTE: revision:{route}]
交叉校验要求对“{route}”阅读结果做一次定向回看。
只修复证据支持的问题；不得为了三条路径表面一致而抹平真实差异。
保持这是低权威初步印象，不创建记忆卡片或最终连线。
{output_rule}

文档标题：{title}

校验问题与修订指令：
{issue_instructions}

当前完整输出：
{current_output}

定向回看的原文：
{source_excerpt}
{schema_part}
""".strip()
