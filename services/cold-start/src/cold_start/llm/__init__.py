"""语言模型适配层。"""

from cold_start.llm.base import ChatModel
from cold_start.llm.openai_compatible import OpenAICompatibleChatModel

__all__ = ["ChatModel", "OpenAICompatibleChatModel"]
