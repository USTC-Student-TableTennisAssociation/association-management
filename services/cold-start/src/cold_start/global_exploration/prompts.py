"""两条并行全局勘探线路使用的轻量提示词。"""

from __future__ import annotations

import json

from cold_start.global_exploration.models import MacroSectionPlan
from cold_start.global_exploration.units import ReadingUnit

DOCUMENT_CONTEXT_SYSTEM_PROMPT = """
你正在帮助 Echo 理解一份协会内部文档。你当前只负责维护一段简短的文档背景，
让后续 AI 知道这是什么文件。不要提取记忆、概念、流程、规则或图关系。
只根据当前提供的原文工作；当前原文优先于之前形成的背景。
""".strip()

MACRO_SECTIONS_SYSTEM_PROMPT = """
你正在为后续深入阅读划分一份文档的宏观连续区域。你只负责决定后续怎样按页阅读，
不负责总结内容、提取概念、判断记忆类型或分析图关系。只根据带页码的原文工作。
""".strip()

def document_context_prompt(
    *,
    title: str,
    unit: ReadingUnit,
    current_context: str,
) -> str:
    return f"""
[ROUTE: document_context]
你正在从文档开头向后顺序阅读。当前阅读单元是{unit.page_label}。

请维护一段供后续 AI 使用的简短文档背景，只回答：
- 这是什么文档；
- 大致由谁形成、主要给谁使用；
- 文档为什么存在；
- 它大致包含哪几类内容。

不要逐章总结，不列举活动、人员、制度或具体事实，不提取概念，不分析章节结构。
每次阅读后重写一段可以独立使用的完整背景，不要追加流水笔记。
全文控制在 300～500 个中文字符以内，使用自然 Markdown。

文档标题：{title}

当前文档背景：
{current_context or "（尚无背景，这是第一次阅读）"}

本次原文：
{unit.content}
""".strip()


def macro_sections_prompt(*, title: str, unit: ReadingUnit) -> str:
    schema = json.dumps(MacroSectionPlan.model_json_schema(), ensure_ascii=False)
    return f"""
[ROUTE: macro_sections]
请阅读下面带页码的完整文档，并将它划分为若干连续、完整的宏观阅读区域。

划分主要依据目录、章节标题和明显主题切换。每个区域只需要一个简短标签、开始页和
结束页。分区不宜过细，它们只用于决定后续分哪几个大范围继续阅读。

要求：
- 覆盖第 {unit.page_numbers[0]} 页到第 {unit.page_numbers[-1]} 页的全部页面；
- 各区域按页码顺序排列，彼此不重叠，中间不缺页；
- 不总结章节内容，不提取事实、经验、规则或概念；
- 不分析章节之间的关系；
- 只输出符合 Schema 的完整 JSON，不要代码围栏。

文档标题：{title}

完整原文：
{unit.content}

JSON Schema：
{schema}
""".strip()


def macro_sections_repair_prompt(
    *,
    original_prompt: str,
    previous_output: MacroSectionPlan,
    validation_error: str,
) -> str:
    return f"""
{original_prompt}

你上一次的宏观分区虽然符合 JSON Schema，但没有形成合法的连续页码覆盖。
请修正后重新输出完整 JSON，不要解释。

页码校验错误：
{validation_error}

上一次输出：
{previous_output.model_dump_json(indent=2)}
""".strip()
