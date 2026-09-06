"""严格规范化模型返回的单个 JSON 文档。"""

from __future__ import annotations

import json
import re


class ModelOutputError(ValueError):
    """模型在阶段内耗尽修复机会后仍未提交可接受的结构化输出。"""


class ModelJsonSyntaxError(ValueError):
    """模型正文声称是 JSON，但文档本身存在 JSON 语法错误。"""


_OPENING_JSON_FENCE = re.compile(
    r"\A```(?:json)?[ \t]*(?:\r?\n|\Z)",
    flags=re.IGNORECASE,
)
_CLOSING_FENCE = re.compile(r"(?:\r?\n)?```[ \t]*\Z")


def normalize_json_document(content: str) -> str:
    """返回模型正文中的唯一 JSON 文档，不从解释性文本中猜测提取。

    接受纯 JSON、完整的单层 Markdown JSON fence，以及供应商在 JSON 完成后
    截掉闭合 fence 的响应。即使存在 fence，也必须恰好包含一个完整 JSON 值；
    解释文字、多个 JSON 值和截断 JSON 都会被拒绝。
    """

    candidate = content.strip()
    opening = _OPENING_JSON_FENCE.match(candidate)
    if opening is not None:
        candidate = candidate[opening.end() :]
        closing = _CLOSING_FENCE.search(candidate)
        if closing is not None:
            candidate = candidate[: closing.start()]
        candidate = candidate.strip()

    if not candidate:
        raise ValueError("模型没有返回 JSON 文档")

    try:
        _, end = json.JSONDecoder().raw_decode(candidate)
    except json.JSONDecodeError as error:
        raise ModelJsonSyntaxError(f"模型正文不是完整 JSON 文档：{error.msg}") from error
    if candidate[end:].strip():
        raise ValueError("JSON 文档前后包含解释文字或额外内容")
    return candidate[:end]


__all__ = ["ModelJsonSyntaxError", "ModelOutputError", "normalize_json_document"]
