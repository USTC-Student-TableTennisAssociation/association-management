"""语言模型的最小接口。"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol

ThinkingMode = Literal["enabled", "disabled"]


@dataclass(frozen=True)
class ToolCall:
    """一次完整的 OpenAI function tool 调用。"""

    id: str
    name: str
    arguments: str

    def as_message_item(self) -> dict[str, object]:
        return {
            "id": self.id,
            "type": "function",
            "function": {
                "name": self.name,
                "arguments": self.arguments,
            },
        }


@dataclass(frozen=True)
class ModelTurn:
    """一次流式模型响应，可为正文或工具调用。"""

    content: str
    reasoning_content: str = ""
    tool_calls: tuple[ToolCall, ...] = ()

    def as_assistant_message(self) -> dict[str, object]:
        message: dict[str, object] = {
            "role": "assistant",
            "content": self.content or None,
        }
        if self.reasoning_content:
            message["reasoning_content"] = self.reasoning_content
        if self.tool_calls:
            message["tool_calls"] = [
                tool_call.as_message_item() for tool_call in self.tool_calls
            ]
        return message


class ChatModel(Protocol):
    """让工作流不依赖特定模型 SDK。"""

    async def complete(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float | None = None,
        request_label: str = "模型",
    ) -> str: ...

    async def complete_turn(
        self,
        *,
        messages: Sequence[Mapping[str, Any]],
        tools: Sequence[Mapping[str, Any]] = (),
        tool_choice: object | None = None,
        temperature: float | None = None,
        request_label: str = "模型",
        thinking: ThinkingMode | None = None,
    ) -> ModelTurn: ...
