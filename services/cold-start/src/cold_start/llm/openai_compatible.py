"""OpenAI 兼容聊天完成接口。"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

import httpx

from cold_start.config import ModelSettings
from cold_start.progress import NullProgressReporter, ProgressReporter


class OpenAICompatibleChatModel:
    """通过标准 chat/completions 协议调用远程或本地模型。"""

    def __init__(
        self,
        settings: ModelSettings,
        *,
        client: httpx.AsyncClient | None = None,
        progress: ProgressReporter | None = None,
    ) -> None:
        self._settings = settings
        self._owns_client = client is None
        timeout = httpx.Timeout(
            connect=settings.connect_timeout_seconds,
            read=settings.read_timeout_seconds,
            write=settings.write_timeout_seconds,
            pool=settings.pool_timeout_seconds,
        )
        self._client = client or httpx.AsyncClient(timeout=timeout)
        self._progress = progress or NullProgressReporter()

    async def complete(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.0,
        request_label: str = "模型",
    ) -> str:
        headers = {
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
        }
        if self._settings.api_key:
            headers["Authorization"] = f"Bearer {self._settings.api_key}"

        payload = {
            "model": self._settings.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": temperature,
            "stream": True,
        }
        endpoint = self._endpoint(self._settings.api_base_url)

        last_error: Exception | None = None
        for attempt in range(self._settings.max_retries):
            try:
                return await self._receive_stream(
                    endpoint=endpoint,
                    headers=headers,
                    payload=payload,
                    request_label=request_label,
                )
            except (
                httpx.HTTPError,
                json.JSONDecodeError,
                ValueError,
                KeyError,
                TypeError,
            ) as error:
                last_error = error
                if attempt + 1 >= self._settings.max_retries:
                    break
                delay_seconds = 2**attempt
                self._progress.report(
                    request_label,
                    (
                        f"流式请求失败（{self._error_label(error)}），"
                        f"{delay_seconds} 秒后重试 "
                        f"{attempt + 2}/{self._settings.max_retries}"
                    ),
                )
                await asyncio.sleep(delay_seconds)

        raise RuntimeError(f"{request_label}流式请求连续失败") from last_error

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    @staticmethod
    def _endpoint(api_base_url: str) -> str:
        normalized = api_base_url.rstrip("/")
        if normalized.endswith("/chat/completions"):
            return normalized
        return f"{normalized}/chat/completions"

    async def _receive_stream(
        self,
        *,
        endpoint: str,
        headers: Mapping[str, str],
        payload: Mapping[str, Any],
        request_label: str,
    ) -> str:
        started_at = time.perf_counter()
        last_progress_at = started_at
        received_chars = 0
        received_content = False
        content_parts: list[str] = []

        async with self._client.stream(
            "POST",
            endpoint,
            headers=headers,
            json=payload,
        ) as response:
            response.raise_for_status()
            received_event = False
            received_done = False
            async for event_data in self._iter_sse_data(response):
                received_event = True
                if event_data == "[DONE]":
                    received_done = True
                    break
                event = json.loads(event_data)
                if isinstance(event, Mapping) and event.get("error"):
                    raise ValueError(f"模型流返回错误事件：{event['error']}")
                delta = self._extract_delta(event)
                if not delta:
                    continue
                content_parts.append(delta)
                received_chars += len(delta)
                now = time.perf_counter()
                if not received_content:
                    received_content = True
                    self._progress.report(
                        request_label,
                        (
                            f"收到首个流式片段，首片等待 "
                            f"{now - started_at:.1f} 秒"
                        ),
                    )
                    last_progress_at = now
                elif (
                    now - last_progress_at
                    >= self._settings.stream_progress_interval_seconds
                ):
                    self._progress.report(
                        request_label,
                        (
                            f"流式接收中：{received_chars} 字符，"
                            f"已用 {now - started_at:.1f} 秒"
                        ),
                    )
                    last_progress_at = now

        if not received_event:
            raise ValueError("模型响应不是 SSE 流：未收到 data 事件")
        if not received_done:
            raise ValueError("模型 SSE 流未以 [DONE] 正常结束")
        content = "".join(content_parts).strip()
        if not content:
            raise ValueError("模型 SSE 流没有返回 content")
        self._progress.report(
            request_label,
            (
                f"流式接收完成：{received_chars} 字符，"
                f"耗时 {time.perf_counter() - started_at:.1f} 秒"
            ),
        )
        return content

    @staticmethod
    async def _iter_sse_data(response: httpx.Response) -> AsyncIterator[str]:
        data_lines: list[str] = []
        async for line in response.aiter_lines():
            if not line:
                if data_lines:
                    yield "\n".join(data_lines)
                    data_lines = []
                continue
            if line.startswith(":"):
                continue
            if line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
        if data_lines:
            yield "\n".join(data_lines)

    @staticmethod
    def _extract_delta(payload: object) -> str:
        if not isinstance(payload, Mapping):
            raise ValueError("模型流事件不是 JSON 对象")
        choices = payload.get("choices")
        if not isinstance(choices, Sequence) or not choices:
            return ""
        first_choice = choices[0]
        if not isinstance(first_choice, Mapping):
            raise ValueError("模型流 choices[0] 格式错误")
        delta = first_choice.get("delta")
        if not isinstance(delta, Mapping):
            raise ValueError("模型流事件缺少 delta")
        content = delta.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, Sequence):
            text_parts = [
                item["text"]
                for item in content
                if isinstance(item, Mapping) and isinstance(item.get("text"), str)
            ]
            return "".join(text_parts)
        return ""

    @staticmethod
    def _error_label(error: Exception) -> str:
        if isinstance(error, httpx.HTTPStatusError):
            return f"HTTP {error.response.status_code}"
        return type(error).__name__
