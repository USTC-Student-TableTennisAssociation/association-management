"""OpenAI 兼容聊天完成接口。"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from typing import Any

import httpx

from cold_start.config import ModelSettings


class OpenAICompatibleChatModel:
    """通过标准 chat/completions 协议调用远程或本地模型。"""

    def __init__(
        self,
        settings: ModelSettings,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._settings = settings
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(timeout=settings.timeout_seconds)

    async def complete(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.0,
    ) -> str:
        headers = {"Content-Type": "application/json"}
        if self._settings.api_key:
            headers["Authorization"] = f"Bearer {self._settings.api_key}"

        payload = {
            "model": self._settings.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": temperature,
        }
        endpoint = self._endpoint(self._settings.api_base_url)

        last_error: Exception | None = None
        for attempt in range(self._settings.max_retries):
            try:
                response = await self._client.post(endpoint, headers=headers, json=payload)
                response.raise_for_status()
                return self._extract_content(response.json())
            except (httpx.HTTPError, ValueError, KeyError, TypeError) as error:
                last_error = error
                if attempt + 1 >= self._settings.max_retries:
                    break
                await asyncio.sleep(2**attempt)

        raise RuntimeError("模型接口连续调用失败") from last_error

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    @staticmethod
    def _endpoint(api_base_url: str) -> str:
        normalized = api_base_url.rstrip("/")
        if normalized.endswith("/chat/completions"):
            return normalized
        return f"{normalized}/chat/completions"

    @staticmethod
    def _extract_content(payload: Mapping[str, Any]) -> str:
        choices = payload.get("choices")
        if not isinstance(choices, Sequence) or not choices:
            raise ValueError("模型响应缺少 choices")
        first_choice = choices[0]
        if not isinstance(first_choice, Mapping):
            raise ValueError("模型响应 choices[0] 格式错误")
        message = first_choice.get("message")
        if not isinstance(message, Mapping):
            raise ValueError("模型响应缺少 message")
        content = message.get("content")
        if isinstance(content, str) and content.strip():
            return content.strip()
        if isinstance(content, Sequence):
            text_parts = [
                item["text"]
                for item in content
                if isinstance(item, Mapping) and isinstance(item.get("text"), str)
            ]
            combined = "\n".join(text_parts).strip()
            if combined:
                return combined
        raise ValueError("模型响应缺少可用文本")
