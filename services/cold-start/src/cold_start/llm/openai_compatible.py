"""OpenAI 兼容聊天完成接口。"""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO

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
        trace_directory: Path | None = None,
        show_model_stream: bool = False,
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
        self._trace_directory = trace_directory
        self._show_model_stream = show_model_stream
        self._request_sequence = 0

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
        self._request_sequence += 1
        request_sequence = self._request_sequence
        self._write_request_trace(
            request_sequence=request_sequence,
            request_label=request_label,
            endpoint=endpoint,
            payload=payload,
        )

        last_error: Exception | None = None
        for attempt in range(self._settings.max_retries):
            try:
                return await self._receive_stream(
                    endpoint=endpoint,
                    headers=headers,
                    payload=payload,
                    request_label=request_label,
                    request_sequence=request_sequence,
                    attempt=attempt + 1,
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

    def _write_request_trace(
        self,
        *,
        request_sequence: int,
        request_label: str,
        endpoint: str,
        payload: Mapping[str, Any],
    ) -> None:
        """在发送前保存不含鉴权信息的完整模型输入。"""

        if self._trace_directory is None:
            return
        self._trace_directory.mkdir(parents=True, exist_ok=True)
        safe_label = _safe_request_label(request_label)
        path = self._trace_directory / (
            f"{request_sequence:03d}-{safe_label}.request.json"
        )
        path.write_text(
            json.dumps(
                {
                    "endpoint": endpoint,
                    "request_label": request_label,
                    "payload": payload,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

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
        request_sequence: int,
        attempt: int,
    ) -> str:
        started_at = time.perf_counter()
        last_progress_at = started_at
        content_chars = 0
        reasoning_chars = 0
        event_count = 0
        comment_count = 0
        received_any_event = False
        received_data_event = False
        received_done = False
        received_content = False
        received_reasoning = False
        content_parts: list[str] = []
        pending_content_parts: list[str] = []
        pending_reasoning_parts: list[str] = []
        trace = _StreamTrace.create(
            directory=self._trace_directory,
            request_sequence=request_sequence,
            request_label=request_label,
            attempt=attempt,
            started_at=started_at,
        )

        try:
            async with self._client.stream(
                "POST",
                endpoint,
                headers=headers,
                json=payload,
            ) as response:
                response.raise_for_status()
                async for sse_event in self._iter_sse_events(response):
                    now = time.perf_counter()
                    event_count += 1
                    trace.record_event(sse_event, now=now)

                    if not received_any_event:
                        received_any_event = True
                        self._progress.report(
                            request_label,
                            (
                                f"收到首个 SSE 事件，等待 "
                                f"{now - started_at:.1f} 秒，类型 {sse_event.kind}"
                            ),
                        )

                    if sse_event.kind == "comment":
                        comment_count += 1
                    else:
                        received_data_event = True
                        if sse_event.data == "[DONE]":
                            received_done = True
                            break
                        event = json.loads(sse_event.data)
                        if isinstance(event, Mapping) and event.get("error"):
                            raise ValueError(f"模型流返回错误事件：{event['error']}")
                        delta = self._extract_delta(event)
                        if delta.reasoning:
                            trace.append_reasoning(delta.reasoning)
                            pending_reasoning_parts.append(delta.reasoning)
                            reasoning_chars += len(delta.reasoning)
                            if not received_reasoning:
                                received_reasoning = True
                                self._progress.report(
                                    request_label,
                                    (
                                        "收到首个思考片段，等待 "
                                        f"{now - started_at:.1f} 秒"
                                    ),
                                )
                        if delta.content:
                            trace.append_content(delta.content)
                            content_parts.append(delta.content)
                            pending_content_parts.append(delta.content)
                            content_chars += len(delta.content)
                            if not received_content:
                                received_content = True
                                self._progress.report(
                                    request_label,
                                    (
                                        "收到首个正文片段，等待 "
                                        f"{now - started_at:.1f} 秒"
                                    ),
                                )

                    if (
                        now - last_progress_at
                        >= self._settings.stream_progress_interval_seconds
                    ):
                        self._report_stream_activity(
                            request_label=request_label,
                            event_count=event_count,
                            comment_count=comment_count,
                            content_chars=content_chars,
                            reasoning_chars=reasoning_chars,
                            elapsed_seconds=now - started_at,
                            pending_content_parts=pending_content_parts,
                            pending_reasoning_parts=pending_reasoning_parts,
                        )
                        trace.flush()
                        last_progress_at = now

            if not received_data_event:
                raise ValueError("模型响应不是 SSE 流：未收到 data 事件")
            if not received_done:
                raise ValueError("模型 SSE 流未以 [DONE] 正常结束")
            content = "".join(content_parts).strip()
            if not content:
                raise ValueError("模型 SSE 流没有返回 content")
            trace.record_status("complete")
            self._progress.report(
                request_label,
                (
                    f"流式接收完成：正文 {content_chars} 字符，"
                    f"思考 {reasoning_chars} 字符，事件 {event_count} 个，"
                    f"耗时 {time.perf_counter() - started_at:.1f} 秒"
                ),
            )
            return content
        except BaseException as error:
            trace.record_status("error", detail=type(error).__name__)
            raise
        finally:
            self._flush_model_text(
                request_label=request_label,
                pending_content_parts=pending_content_parts,
                pending_reasoning_parts=pending_reasoning_parts,
            )
            trace.close()

    @staticmethod
    async def _iter_sse_events(response: httpx.Response) -> AsyncIterator[_SseEvent]:
        data_lines: list[str] = []
        async for line in response.aiter_lines():
            if not line:
                if data_lines:
                    yield _SseEvent(kind="data", data="\n".join(data_lines))
                    data_lines = []
                continue
            if line.startswith(":"):
                yield _SseEvent(kind="comment", data=line[1:].lstrip())
                continue
            if line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
        if data_lines:
            yield _SseEvent(kind="data", data="\n".join(data_lines))

    @staticmethod
    def _extract_delta(payload: object) -> _ModelDelta:
        if not isinstance(payload, Mapping):
            raise ValueError("模型流事件不是 JSON 对象")
        choices = payload.get("choices")
        if not isinstance(choices, Sequence) or not choices:
            return _ModelDelta()
        first_choice = choices[0]
        if not isinstance(first_choice, Mapping):
            raise ValueError("模型流 choices[0] 格式错误")
        delta = first_choice.get("delta")
        if not isinstance(delta, Mapping):
            raise ValueError("模型流事件缺少 delta")
        content = OpenAICompatibleChatModel._extract_text(delta.get("content"))
        reasoning = "".join(
            OpenAICompatibleChatModel._extract_text(delta.get(field))
            for field in ("reasoning_content", "reasoning", "thinking")
        )
        return _ModelDelta(content=content, reasoning=reasoning)

    @staticmethod
    def _extract_text(value: object) -> str:
        if isinstance(value, str):
            return value
        if isinstance(value, Sequence):
            text_parts = [
                item["text"]
                for item in value
                if isinstance(item, Mapping) and isinstance(item.get("text"), str)
            ]
            return "".join(text_parts)
        return ""

    def _report_stream_activity(
        self,
        *,
        request_label: str,
        event_count: int,
        comment_count: int,
        content_chars: int,
        reasoning_chars: int,
        elapsed_seconds: float,
        pending_content_parts: list[str],
        pending_reasoning_parts: list[str],
    ) -> None:
        self._flush_model_text(
            request_label=request_label,
            pending_content_parts=pending_content_parts,
            pending_reasoning_parts=pending_reasoning_parts,
        )
        self._progress.report(
            request_label,
            (
                f"SSE 活跃：事件 {event_count} 个，心跳 {comment_count} 个，"
                f"正文 {content_chars} 字符，思考 {reasoning_chars} 字符，"
                f"已用 {elapsed_seconds:.1f} 秒"
            ),
        )

    def _flush_model_text(
        self,
        *,
        request_label: str,
        pending_content_parts: list[str],
        pending_reasoning_parts: list[str],
    ) -> None:
        if self._show_model_stream:
            if pending_reasoning_parts:
                self._progress.report(
                    f"{request_label}·思考",
                    "".join(pending_reasoning_parts),
                )
            if pending_content_parts:
                self._progress.report(
                    f"{request_label}·正文",
                    "".join(pending_content_parts),
                )
        pending_reasoning_parts.clear()
        pending_content_parts.clear()

    @staticmethod
    def _error_label(error: Exception) -> str:
        if isinstance(error, httpx.HTTPStatusError):
            return f"HTTP {error.response.status_code}"
        return type(error).__name__


@dataclass(frozen=True)
class _SseEvent:
    kind: str
    data: str


@dataclass(frozen=True)
class _ModelDelta:
    content: str = ""
    reasoning: str = ""


def _safe_request_label(request_label: str) -> str:
    return re.sub(r"[^\w\u4e00-\u9fff-]+", "-", request_label).strip("-")


class _StreamTrace:
    """把单次模型尝试的原始事件和部分输出持续写入本地。"""

    def __init__(
        self,
        *,
        events_file: TextIO,
        content_file: TextIO,
        reasoning_file: TextIO,
        started_at: float,
    ) -> None:
        self._events_file = events_file
        self._content_file = content_file
        self._reasoning_file = reasoning_file
        self._started_at = started_at

    @classmethod
    def create(
        cls,
        *,
        directory: Path | None,
        request_sequence: int,
        request_label: str,
        attempt: int,
        started_at: float,
    ) -> _StreamTrace:
        if directory is None:
            return _NullStreamTrace()
        directory.mkdir(parents=True, exist_ok=True)
        safe_label = _safe_request_label(request_label)
        stem = f"{request_sequence:03d}-{safe_label}-attempt-{attempt}"
        return cls(
            events_file=(directory / f"{stem}.events.jsonl").open(
                "w",
                encoding="utf-8",
            ),
            content_file=(directory / f"{stem}.content.partial.txt").open(
                "w",
                encoding="utf-8",
            ),
            reasoning_file=(directory / f"{stem}.reasoning.partial.txt").open(
                "w",
                encoding="utf-8",
            ),
            started_at=started_at,
        )

    def record_event(self, event: _SseEvent, *, now: float) -> None:
        self._events_file.write(
            json.dumps(
                {
                    "elapsed_seconds": round(now - self._started_at, 3),
                    "kind": event.kind,
                    "data": event.data,
                },
                ensure_ascii=False,
            )
            + "\n"
        )

    def append_content(self, text: str) -> None:
        self._content_file.write(text)

    def append_reasoning(self, text: str) -> None:
        self._reasoning_file.write(text)

    def record_status(self, status: str, *, detail: str | None = None) -> None:
        self._events_file.write(
            json.dumps(
                {
                    "elapsed_seconds": round(
                        time.perf_counter() - self._started_at,
                        3,
                    ),
                    "kind": "status",
                    "status": status,
                    "detail": detail,
                },
                ensure_ascii=False,
            )
            + "\n"
        )
        self.flush()

    def flush(self) -> None:
        self._events_file.flush()
        self._content_file.flush()
        self._reasoning_file.flush()

    def close(self) -> None:
        self.flush()
        self._events_file.close()
        self._content_file.close()
        self._reasoning_file.close()


class _NullStreamTrace(_StreamTrace):
    def __init__(self) -> None:
        pass

    def record_event(self, event: _SseEvent, *, now: float) -> None:
        del event, now

    def append_content(self, text: str) -> None:
        del text

    def append_reasoning(self, text: str) -> None:
        del text

    def record_status(self, status: str, *, detail: str | None = None) -> None:
        del status, detail

    def flush(self) -> None:
        pass

    def close(self) -> None:
        pass
