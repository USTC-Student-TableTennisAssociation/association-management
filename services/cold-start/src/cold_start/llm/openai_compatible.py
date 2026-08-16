"""学校 OpenAI 兼容接口的流式适配器。"""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
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


class ModelRepetitionError(ModelProtocolError):
    """模型流进入可确认的逐字重复，主动中止当前单次请求。"""


class _RepetitionGuard:
    """只检测完整片段的连续循环，不把结构化字段复用误判为退化。"""

    def __init__(
        self,
        *,
        window_chars: int = 12_000,
        probe_chars: int = 160,
        required_occurrences: int = 3,
    ) -> None:
        self.window_chars = window_chars
        self.probe_chars = probe_chars
        self.required_occurrences = required_occurrences
        self.text = ""
        self.unchecked_chars = 0

    def append(self, value: str) -> str | None:
        self.text = (self.text + value)[-self.window_chars :]
        self.unchecked_chars += len(value)
        if self.unchecked_chars < self.probe_chars or len(self.text) < 1_000:
            return None
        self.unchecked_chars = 0
        probe = self.text[-self.probe_chars :]
        if not probe.strip():
            return None
        current_start = len(self.text) - self.probe_chars
        earlier = self.text[:current_start]
        previous_start = earlier.rfind(probe)
        while previous_start >= 0:
            period = current_start - previous_start
            first_start = current_start - period * (self.required_occurrences - 1)
            if first_start >= 0:
                cycles = [
                    self.text[first_start + period * index : first_start + period * (index + 1)]
                    for index in range(self.required_occurrences - 1)
                ]
                if cycles[0].strip() and all(cycle == cycles[0] for cycle in cycles[1:]):
                    return cycles[0]
            previous_start = earlier.rfind(probe, 0, previous_start)
        return None


class _RequestRateLimiter:
    """在一个模型客户端内匀速安排所有真实 HTTP 请求尝试。"""

    def __init__(
        self,
        requests_per_minute: int,
        *,
        progress: ProgressReporter,
        clock: Callable[[], float] = time.perf_counter,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self.interval_seconds = 60.0 / requests_per_minute
        self.progress = progress
        self.clock = clock
        self.sleep = sleep
        self.lock = asyncio.Lock()
        self.next_start_at = 0.0

    async def acquire(self, label: str) -> None:
        async with self.lock:
            now = self.clock()
            start_at = max(now, self.next_start_at)
            self.next_start_at = start_at + self.interval_seconds
            delay = start_at - now
        if delay <= 0:
            return
        self.progress.report(
            label,
            f"RPM 限速排队：等待 {delay:.1f} 秒后发起请求",
        )
        await self.sleep(delay)


class _RequestConcurrencyLimiter:
    """限制已经发出、仍在 thinking 或流式输出的真实 HTTP 请求数量。"""

    def __init__(
        self,
        max_in_flight: int,
        *,
        progress: ProgressReporter,
    ) -> None:
        self.max_in_flight = max_in_flight
        self.progress = progress
        self.semaphore = asyncio.Semaphore(max_in_flight)
        self.active = 0

    async def acquire(self, label: str) -> None:
        if self.semaphore.locked():
            self.progress.report(
                label,
                f"模型并发排队：等待空闲槽位（在途上限 {self.max_in_flight}）",
            )
        await self.semaphore.acquire()
        self.active += 1
        self.progress.report(
            label,
            f"模型请求已发出：thinking / 流式输出在途 {self.active}/{self.max_in_flight}",
        )

    def release(self) -> None:
        self.active -= 1
        self.semaphore.release()


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
    """持续保存原始 SSE、正文和思考，进程中断时仍可检查。"""

    def __init__(
        self,
        directory: Path | None,
        *,
        sequence: int,
        label: str,
        attempt: int,
    ) -> None:
        self.files: dict[str, TextIO] = {}
        self.events_file: TextIO | None = None
        self.event_index = 0
        self.tool_calls_path: Path | None = None
        if directory is None:
            return
        directory.mkdir(parents=True, exist_ok=True)
        # Global Resolution artifacts can already sit more than 200 characters
        # deep on Windows. Repeating a human-readable (and sometimes Chinese)
        # request label in every trace filename can push the full path past the
        # classic MAX_PATH boundary. Keep identity in the request trace instead
        # and use a deliberately short, stable filename here.
        stem = f"{sequence:03d}-a{attempt}"
        self.tool_calls_path = directory / f"{stem}.tool-calls.json"
        self.events_file = (directory / f"{stem}.sse.jsonl").open("w", encoding="utf-8")
        for kind in ("content", "reasoning"):
            self.files[kind] = (directory / f"{stem}.{kind}.txt").open("w", encoding="utf-8")

    def text(self, kind: str, value: str) -> None:
        if file := self.files.get(kind):
            file.write(value)

    def event(self, kind: str, data: str, elapsed_seconds: float) -> None:
        if self.events_file is None:
            return
        self.event_index += 1
        self.events_file.write(
            json.dumps(
                {
                    "index": self.event_index,
                    "elapsed_seconds": round(elapsed_seconds, 3),
                    "kind": kind,
                    "data": data,
                },
                ensure_ascii=False,
            )
            + "\n"
        )

    def flush(self) -> None:
        for file in self.files.values():
            file.flush()
        if self.events_file is not None:
            self.events_file.flush()

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
        if self.events_file is not None:
            self.events_file.close()


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
        self.rate_limiter = _RequestRateLimiter(
            settings.requests_per_minute,
            progress=self.progress,
        )
        self.concurrency_limiter = _RequestConcurrencyLimiter(
            settings.max_in_flight,
            progress=self.progress,
        )
        self.trace_directory = trace_directory
        self.show_model_stream = show_model_stream
        self.sequence = _last_trace_sequence(trace_directory)

    async def complete(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float | None = None,
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
        temperature: float | None = None,
        request_label: str = "模型",
        thinking: ThinkingMode | None = None,
    ) -> ModelTurn:
        payload: dict[str, object] = {
            "model": self.settings.model,
            "messages": list(messages),
            "stream": True,
        }
        if temperature is not None:
            payload["temperature"] = temperature
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
        sequence = self.sequence
        self._save_request(sequence, request_label, payload)
        endpoint = _endpoint(self.settings.api_base_url)
        last_error: Exception | None = None
        for attempt in range(1, self.settings.max_retries + 1):
            try:
                await self.rate_limiter.acquire(request_label)
                await self.concurrency_limiter.acquire(request_label)
                try:
                    return await self._stream(
                        endpoint,
                        headers,
                        payload,
                        sequence=sequence,
                        label=request_label,
                        attempt=attempt,
                    )
                finally:
                    self.concurrency_limiter.release()
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
        sequence: int,
        label: str,
        attempt: int,
    ) -> ModelTurn:
        started = last_report = time.perf_counter()
        trace = _Trace(
            self.trace_directory,
            sequence=sequence,
            label=label,
            attempt=attempt,
        )
        content: list[str] = []
        reasoning: list[str] = []
        pending_content: list[str] = []
        pending_reasoning: list[str] = []
        calls: dict[int, _ToolParts] = {}
        events = comments = 0
        reasoning_guard = _RepetitionGuard()
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
                    trace.event(kind, data, now - started)
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
                            reasoning_guard,
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
        reasoning_guard: _RepetitionGuard,
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
            repeated = reasoning_guard.append(value) if kind == "reasoning" else None
            if repeated is not None:
                display = "思考"
                trace.flush()
                self.progress.report(
                    label,
                    f"检测到{display}逐字重复，已中止当前单次请求并保留原始 SSE",
                )
                raise ModelRepetitionError(f"{label}的{display}连续重复同一片段：{repeated[:80]!r}")
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
                        f"收到首个工具调用片段，等待 {time.perf_counter() - started:.1f} 秒",
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

    def _save_request(
        self,
        sequence: int,
        label: str,
        payload: Mapping[str, object],
    ) -> None:
        if self.trace_directory is None:
            return
        self.trace_directory.mkdir(parents=True, exist_ok=True)
        path = self.trace_directory / f"{sequence:03d}.request.json"
        path.write_text(
            json.dumps(
                {
                    "label": label,
                    "endpoint": _endpoint(self.settings.api_base_url),
                    "payload": payload,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )


def _last_trace_sequence(directory: Path | None) -> int:
    if directory is None or not directory.is_dir():
        return 0
    values = []
    for path in directory.glob("*.request.json"):
        prefix = path.name.partition("-")[0]
        if prefix.isdigit():
            values.append(int(prefix))
    return max(values, default=0)


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


def _retryable(error: Exception) -> bool:
    if isinstance(error, httpx.HTTPStatusError):
        status = error.response.status_code
        return status in {408, 429} or status >= 500
    return isinstance(error, httpx.TransportError)


def _error_label(error: Exception) -> str:
    if isinstance(error, httpx.HTTPStatusError):
        return f"HTTP {error.response.status_code}"
    return type(error).__name__
