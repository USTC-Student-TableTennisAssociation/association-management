import json

import httpx
import pytest

from cold_start.config import ModelSettings
from cold_start.llm.openai_compatible import OpenAICompatibleChatModel


class RecordingProgressReporter:
    def __init__(self) -> None:
        self.events: list[tuple[str, str]] = []

    def report(self, stage: str, message: str) -> None:
        self.events.append((stage, message))


class BrokenSseStream(httpx.AsyncByteStream):
    async def __aiter__(self):
        yield sse_event(
            {"choices": [{"delta": {"reasoning_content": "尚未完成的思考"}}]}
        ).encode()
        yield sse_event(
            {"choices": [{"delta": {"content": '{"partial": true'}}]}
        ).encode()
        raise httpx.RemoteProtocolError("远端在 [DONE] 前断开")


def sse_event(payload: object) -> str:
    data = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    return f"data: {data}\n\n"


@pytest.mark.asyncio
async def test_adapter_requires_and_accumulates_sse_stream(tmp_path) -> None:
    captured_request: httpx.Request | None = None
    progress = RecordingProgressReporter()
    stream_body = "".join(
        (
            ": keepalive\n\n",
            sse_event({"choices": [{"delta": {"role": "assistant"}}]}),
            sse_event({"choices": [{"delta": {"reasoning_content": "先理解问题。"}}]}),
            sse_event({"choices": [{"delta": {"content": "  勘探"}}]}),
            sse_event({"choices": [{"delta": {"content": "结果  "}}]}),
            sse_event({"choices": [{"delta": {}, "finish_reason": "stop"}]}),
            sse_event("[DONE]"),
        )
    )

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal captured_request
        captured_request = request
        return httpx.Response(
            200,
            headers={"Content-Type": "text/event-stream"},
            text=stream_body,
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        model = OpenAICompatibleChatModel(
            ModelSettings(
                model="test-model",
                api_base_url="http://model.test/v1/",
                api_key="secret",
            ),
            client=client,
            progress=progress,
            trace_directory=tmp_path,
            show_model_stream=True,
        )
        result = await model.complete(
            system_prompt="系统",
            user_prompt="用户",
            request_label="概念",
        )

    assert result == "勘探结果"
    assert captured_request is not None
    assert str(captured_request.url) == "http://model.test/v1/chat/completions"
    assert captured_request.headers["Authorization"] == "Bearer secret"
    assert captured_request.headers["Accept"] == "text/event-stream"
    body = json.loads(captured_request.content)
    assert body["model"] == "test-model"
    assert body["stream"] is True
    assert any(
        stage == "概念" and "收到首个正文片段" in message
        for stage, message in progress.events
    )
    assert any(
        stage == "概念" and "流式接收完成" in message
        for stage, message in progress.events
    )
    assert any(stage == "概念·思考" for stage, _ in progress.events)
    assert any(stage == "概念·正文" for stage, _ in progress.events)
    assert "先理解问题。" in next(tmp_path.glob("*.reasoning.partial.txt")).read_text(
        encoding="utf-8"
    )
    assert "勘探结果" in next(tmp_path.glob("*.content.partial.txt")).read_text(
        encoding="utf-8"
    )
    events = next(tmp_path.glob("*.events.jsonl")).read_text(encoding="utf-8")
    assert '"kind": "comment"' in events
    assert '"status": "complete"' in events


@pytest.mark.asyncio
async def test_adapter_rejects_non_stream_json_response() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "非流式结果"}}]},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        model = OpenAICompatibleChatModel(
            ModelSettings(
                model="test-model",
                api_base_url="http://model.test/v1",
                api_key=None,
                max_retries=1,
            ),
            client=client,
        )
        with pytest.raises(RuntimeError, match="结构流式请求连续失败"):
            await model.complete(
                system_prompt="系统",
                user_prompt="用户",
                request_label="结构",
            )


@pytest.mark.asyncio
async def test_adapter_keeps_partial_trace_when_remote_stream_breaks(tmp_path) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(
            200,
            headers={"Content-Type": "text/event-stream"},
            stream=BrokenSseStream(),
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        model = OpenAICompatibleChatModel(
            ModelSettings(
                model="test-model",
                api_base_url="http://model.test/v1",
                api_key=None,
                max_retries=1,
            ),
            client=client,
            trace_directory=tmp_path,
        )
        with pytest.raises(RuntimeError, match="概念流式请求连续失败"):
            await model.complete(
                system_prompt="系统",
                user_prompt="用户",
                request_label="概念",
            )

    assert "尚未完成的思考" in next(
        tmp_path.glob("*.reasoning.partial.txt")
    ).read_text(encoding="utf-8")
    assert '{"partial": true' in next(
        tmp_path.glob("*.content.partial.txt")
    ).read_text(encoding="utf-8")
    events = next(tmp_path.glob("*.events.jsonl")).read_text(encoding="utf-8")
    assert '"status": "error"' in events
    assert "RemoteProtocolError" in events
