"""对提示词约束的 JSON 输出做容错解析与一次修复。"""

from __future__ import annotations

import json
from typing import TypeVar

from pydantic import BaseModel, ValidationError

from cold_start.llm.base import ChatModel
from cold_start.progress import NullProgressReporter, ProgressReporter

ModelT = TypeVar("ModelT", bound=BaseModel)


async def complete_json(
    model: ChatModel,
    *,
    schema: type[ModelT],
    system_prompt: str,
    user_prompt: str,
    progress: ProgressReporter | None = None,
    progress_stage: str = "模型",
) -> ModelT:
    reporter = progress or NullProgressReporter()
    raw = await model.complete(system_prompt=system_prompt, user_prompt=user_prompt)
    try:
        return schema.model_validate(_decode_json_object(raw))
    except (json.JSONDecodeError, ValidationError, ValueError) as first_error:
        reporter.report(
            progress_stage,
            "结构化输出校验失败，正在请求模型修复 JSON",
        )
        repair_prompt = (
            f"{user_prompt}\n\n"
            "你上一次的输出未通过 JSON Schema 校验。请只输出修正后的完整 JSON 对象，"
            "不要输出代码围栏或解释。\n"
            f"校验错误：{first_error}\n"
            f"上一次输出：\n{raw}"
        )
        repaired = await model.complete(
            system_prompt=system_prompt,
            user_prompt=repair_prompt,
        )
        return schema.model_validate(_decode_json_object(repaired))


def _decode_json_object(raw: str) -> object:
    stripped = raw.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        stripped = "\n".join(lines).strip()
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start < 0 or end < start:
        raise ValueError("输出中不存在 JSON 对象")
    return json.loads(stripped[start : end + 1])
