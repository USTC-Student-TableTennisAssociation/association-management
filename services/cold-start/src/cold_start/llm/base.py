"""语言模型的最小接口。"""

from __future__ import annotations

from typing import Protocol


class ChatModel(Protocol):
    """让工作流不依赖特定模型 SDK。"""

    async def complete(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.0,
        request_label: str = "模型",
    ) -> str: ...
