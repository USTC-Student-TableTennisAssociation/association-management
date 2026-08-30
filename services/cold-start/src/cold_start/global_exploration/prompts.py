"""只维护后续模型所需文档身份背景的轻量提示词。"""

from __future__ import annotations

from cold_start.global_exploration.units import ReadingUnit

DOCUMENT_CONTEXT_SYSTEM_PROMPT = """
你正在帮助 Sydaris 识别一份来源文档。这个阶段只形成后续 AI 都能复用的“文档身份
背景”，不提取记忆，不分析概念，不划分区域，也不设计知识图谱。

请从文档开头向后阅读，并持续修正当前背景。原文证据优先；旧背景只是可修改草稿。
输出应短、稳定、自然，能够直接放入后续模型的系统上下文。
""".strip()


def document_context_prompt(
    *,
    title: str,
    unit: ReadingUnit,
    current_context: str,
) -> str:
    return f"""
[ROUTE: document_context]
当前顺序阅读单元：{unit.page_label}

请重写一份完整、可独立使用的文档背景，只说明：
- 这是什么文档以及为什么形成；
- 主要由谁形成、给谁使用（原文不明确就不猜）；
- 大致覆盖哪些内容类型。

不要逐章复述，不列具体活动、人名、规则、经验或历史细节。全文控制在 180～300 个
中文字符；后续原文推翻旧判断时直接修正。

文档标题：
{title}

当前背景草稿：
{current_context or "（第一次阅读，尚无草稿）"}

本次原文：
{unit.content}
""".strip()
