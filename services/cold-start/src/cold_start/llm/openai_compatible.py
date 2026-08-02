"""学校 OpenAI 兼容接口的流式适配器。"""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO
from urllib.parse import urlsplit, urlunsplit

import httpx

from cold_start.config import ModelSettings
from cold_start.llm.base import ModelTurn, ThinkingMode, ToolCall
from cold_start.progress import NullProgressReporter, ProgressReporter


class ModelProtocolError(RuntimeError):
    """接口已响应，但没有形成完整的 SSE 结果。"""


@dataclass
class _ToolParts:
    call_id: str = ""
    name: str = ""
    arguments: str = ""

    def append(self, fragment: Mapping[str, object]) -> None:
        function = fragment.get("function")
        function = function if isinstance(function, Mapping) else {}
        self.call_id += _text(fragment.get("id"))
        self.name += _text(function.get("name"))
        self.arguments += _text(function.get("arguments"))

    def build(self) -> ToolCall:
        if not self.call_id or not self.name:
            raise ModelProtocolError("流式工具调用缺少 id 或 function.name")
        return ToolCall(id=self.call_id, name=self.name, arguments=self.arguments)


class _Trace:
    """持续保存正文和思考，进程中断时仍可检查。"""

    def __init__(
        self,
        directory: Path | None,
        *,
        sequence: int,
        label: str,
        attempt: int,
    ) -> None:
        self.files: dict[str, TextIO] = {}
        self.tool_calls_path: Path | None = None
        if directory is None:
            return
        directory.mkdir(parents=True, exist_ok=True)
        stem = f"{sequence:03d}-{_safe_label(label)}-attempt-{attempt}"
        self.tool_calls_path = directory / f"{stem}.tool-calls.json"
        for kind in ("content", "reasoning"):
            self.files[kind] = (directory / f"{stem}.{kind}.partial.txt").open(
                "w", encoding="utf-8"
            )

    def text(self, kind: str, value: str) -> None:
        if file := self.files.get(kind):
            file.write(value)

    def flush(self) -> None:
        for file in self.files.values():
            file.flush()

    def save_tool_calls(self, calls: tuple[ToolCall, ...]) -> None:
        if self.tool_calls_path is None or not calls:
            return
        self.tool_calls_path.write_text(
            json.dumps(
                [
                    {
                        "id": call.id,
                        "name": call.name,
                        "arguments": call.arguments,
                    }
                    for call in calls
                ],
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    def close(self) -> None:
        for file in self.files.values():
            file.close()


class OpenAICompatibleChatModel:
    """只实现本模块实际使用的 chat/completions 流式协议。"""

    def __init__(
        self,
        settings: ModelSettings,
        *,
        client: httpx.AsyncClient | None = None,
        progress: ProgressReporter | None = None,
        trace_directory: Path | None = None,
        show_model_stream: bool = False,
    ) -> None:
        self.settings = settings
        self.owns_client = client is None
        self.client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(
                connect=settings.connect_timeout_seconds,
                read=settings.read_timeout_seconds,
                write=settings.write_timeout_seconds,
                pool=settings.pool_timeout_seconds,
            )
        )
        self.progress = progress or NullProgressReporter()
        self.trace_directory = trace_directory
        self.show_model_stream = show_model_stream
        self.sequence = 0

    async def complete(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.0,
        request_label: str = "模型",
    ) -> str:
        turn = await self.complete_turn(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=temperature,
            request_label=request_label,
        )
        if turn.tool_calls or not turn.content:
            raise ModelProtocolError(f"{request_label}没有返回正式正文")
        return turn.content

    async def complete_turn(
        self,
        *,
        messages: Sequence[Mapping[str, Any]],
        tools: Sequence[Mapping[str, Any]] = (),
        tool_choice: object | None = None,
        temperature: float = 0.0,
        request_label: str = "模型",
        thinking: ThinkingMode | None = None,
    ) -> ModelTurn:
        payload: dict[str, object] = {
            "model": self.settings.model,
            "messages": list(messages),
            "temperature": temperature,
            "stream": True,
        }
        if tools:
            payload.update(tools=list(tools), tool_choice=tool_choice or "auto")
        if thinking:
            payload["thinking"] = {
                "type": thinking,
                **({"clear_thinking": False} if thinking == "enabled" else {}),
            }
        headers = {"Accept": "text/event-stream", "Content-Type": "application/json"}
        if self.settings.api_key:
            headers["Authorization"] = f"Bearer {self.settings.api_key}"

        self.sequence += 1
        self._save_request(request_label, payload)
        endpoint = _endpoint(self.settings.api_base_url)
        last_error: Exception | None = None
        for attempt in range(1, self.settings.max_retries + 1):
            try:
                return await self._stream(
                    endpoint,
                    headers,
                    payload,
                    label=request_label,
                    attempt=attempt,
                )
            except Exception as error:
                if not _retryable(error) or attempt == self.settings.max_retries:
                    if _retryable(error):
                        raise RuntimeError(f"{request_label}流式传输连续失败") from error
                    raise
                last_error = error
                delay = 2 ** (attempt - 1)
                self.progress.report(
                    request_label,
                    f"流式请求失败（{_error_label(error)}），{delay} 秒后重试 "
                    f"{attempt + 1}/{self.settings.max_retries}",
                )
                await asyncio.sleep(delay)
        raise RuntimeError(f"{request_label}流式传输连续失败") from last_error

    async def aclose(self) -> None:
        if self.owns_client:
            await self.client.aclose()

    async def _stream(
        self,
        endpoint: str,
        headers: Mapping[str, str],
        payload: Mapping[str, object],
        *,
        label: str,
        attempt: int,
    ) -> ModelTurn:
        started = last_report = time.perf_counter()
        trace = _Trace(
            self.trace_directory,
            sequence=self.sequence,
            label=label,
            attempt=attempt,
        )
        content: list[str] = []
        reasoning: list[str] = []
        pending_content: list[str] = []
        pending_reasoning: list[str] = []
        calls: dict[int, _ToolParts] = {}
        events = comments = 0
        got_data = got_done = False
        first: set[str] = set()

        try:
            async with self.client.stream(
                "POST", endpoint, headers=headers, json=payload
            ) as response:
                if response.is_error:
                    await response.aread()
                response.raise_for_status()
                async for kind, data in _sse_events(response):
                    now = time.perf_counter()
                    events += 1
                    if "event" not in first:
                        first.add("event")
                        self.progress.report(
                            label,
                            f"收到首个 SSE 事件，等待 {now - started:.1f} 秒，类型 {kind}",
                        )
                    if kind == "comment":
                        comments += 1
                        continue
                    got_data = True
                    if data == "[DONE]":
                        got_done = True
                        break

                    choice = _first_choice(json.loads(data))
                    if choice is not None:
                        delta = choice.get("delta")
                        if not isinstance(delta, Mapping):
                            raise ModelProtocolError("模型流事件缺少 delta")
                        self._consume_delta(
                            delta,
                            content,
                            reasoning,
                            pending_content,
                            pending_reasoning,
                            calls,
                            trace,
                            label,
                            started,
                            first,
                        )

                    if now - last_report >= self.settings.stream_progress_interval_seconds:
                        self._show_pending(label, pending_content, pending_reasoning)
                        self.progress.report(
                            label,
                            f"SSE 活跃：事件 {events} 个，心跳 {comments} 个，"
                            f"正文 {sum(map(len, content))} 字符，"
                            f"思考 {sum(map(len, reasoning))} 字符，"
                            f"已用 {now - started:.1f} 秒",
                        )
                        trace.flush()
                        last_report = now

            if not got_data:
                raise ModelProtocolError("模型响应不是 SSE 流：未收到 data 事件")
            if not got_done:
                raise ModelProtocolError("模型 SSE 流未以 [DONE] 正常结束")
            result = ModelTurn(
                content="".join(content).strip(),
                reasoning_content="".join(reasoning).strip(),
                tool_calls=tuple(calls[index].build() for index in sorted(calls)),
            )
            trace.save_tool_calls(result.tool_calls)
            if not result.content and not result.reasoning_content and not result.tool_calls:
                raise ModelProtocolError("模型 SSE 流没有返回任何内容")
            trace.flush()
            self.progress.report(
                label,
                f"流式接收完成：正文 {sum(map(len, content))} 字符，"
                f"思考 {sum(map(len, reasoning))} 字符，事件 {events} 个，"
                f"工具调用 {len(result.tool_calls)} 个，"
                f"耗时 {time.perf_counter() - started:.1f} 秒",
            )
            return result
        finally:
            self._show_pending(label, pending_content, pending_reasoning)
            trace.close()

    def _consume_delta(
        self,
        delta: Mapping[str, object],
        content: list[str],
        reasoning: list[str],
        pending_content: list[str],
        pending_reasoning: list[str],
        calls: dict[int, _ToolParts],
        trace: _Trace,
        label: str,
        started: float,
        first: set[str],
    ) -> None:
        for kind, value, target, pending in (
            ("reasoning", _text(delta.get("reasoning_content")), reasoning, pending_reasoning),
            ("content", _text(delta.get("content")), content, pending_content),
        ):
            if not value:
                continue
            target.append(value)
            pending.append(value)
            trace.text(kind, value)
            if kind not in first:
                first.add(kind)
                display = "思考" if kind == "reasoning" else "正文"
                self.progress.report(
                    label,
                    f"收到首个{display}片段，等待 {time.perf_counter() - started:.1f} 秒",
                )

        fragments = delta.get("tool_calls")
        if isinstance(fragments, Sequence):
            for fragment in fragments:
                if not isinstance(fragment, Mapping):
                    continue
                index = fragment.get("index", 0)
                index = index if isinstance(index, int) else 0
                calls.setdefault(index, _ToolParts()).append(fragment)
                if "tool" not in first:
                    first.add("tool")
                    self.progress.report(
                        label,
                        f"收到首个工具调用片段，等待 "
                        f"{time.perf_counter() - started:.1f} 秒",
                    )

    def _show_pending(
        self,
        label: str,
        content: list[str],
        reasoning: list[str],
    ) -> None:
        if self.show_model_stream:
            if reasoning:
                self.progress.report(f"{label}·思考", "".join(reasoning))
            if content:
                self.progress.report(f"{label}·正文", "".join(content))
        reasoning.clear()
        content.clear()

    def _save_request(self, label: str, payload: Mapping[str, object]) -> None:
        if self.trace_directory is None:
            return
        self.trace_directory.mkdir(parents=True, exist_ok=True)
        path = self.trace_directory / f"{self.sequence:03d}-{_safe_label(label)}.request.json"
        path.write_text(
            json.dumps(
                {"endpoint": _endpoint(self.settings.api_base_url), "payload": payload},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )


async def _sse_events(response: httpx.Response) -> AsyncIterator[tuple[str, str]]:
    data_lines: list[str] = []
    async for line in response.aiter_lines():
        if not line:
            if data_lines:
                yield "data", "\n".join(data_lines)
                data_lines.clear()
        elif line.startswith(":"):
            yield "comment", line[1:].lstrip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
    if data_lines:
        yield "data", "\n".join(data_lines)


def _first_choice(payload: object) -> Mapping[str, object] | None:
    if not isinstance(payload, Mapping):
        raise ModelProtocolError("模型流事件不是 JSON 对象")
    if payload.get("error"):
        raise ModelProtocolError(f"模型流返回错误事件：{payload['error']}")
    choices = payload.get("choices")
    if not isinstance(choices, Sequence) or not choices:
        return None
    choice = choices[0]
    if not isinstance(choice, Mapping):
        raise ModelProtocolError("模型流 choices[0] 格式错误")
    return choice


def _text(value: object) -> str:
    return value if isinstance(value, str) else ""


def _endpoint(base_url: str) -> str:
    parts = urlsplit(base_url)
    path = re.sub(r"/+", "/", parts.path).rstrip("/")
    normalized = urlunsplit((parts.scheme, parts.netloc, path, parts.query, parts.fragment))
    if normalized.endswith("/chat/completions"):
        return normalized
    return f"{normalized}/chat/completions"


def _safe_label(label: str) -> str:
    return re.sub(r"[^\w\u4e00-\u9fff-]+", "-", label).strip("-")


def _retryable(error: Exception) -> bool:
    if isinstance(error, httpx.HTTPStatusError):
        status = error.response.status_code
        return status in {408, 429} or status >= 500
    return isinstance(error, httpx.TransportError)


def _error_label(error: Exception) -> str:
    if isinstance(error, httpx.HTTPStatusError):
        return f"HTTP {error.response.status_code}"
    return type(error).__name__
