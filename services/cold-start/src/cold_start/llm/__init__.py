"""语言模型适配层。"""

from cold_start.llm.base import ChatModel, ModelTurn, ToolCall
from cold_start.llm.openai_compatible import OpenAICompatibleChatModel
from cold_start.llm.structured_output import (
    ModelJsonSyntaxError,
    ModelOutputError,
    normalize_json_document,
)

__all__ = [
    "ChatModel",
    "ModelJsonSyntaxError",
    "ModelOutputError",
    "ModelTurn",
    "OpenAICompatibleChatModel",
    "ToolCall",
    "normalize_json_document",
]
