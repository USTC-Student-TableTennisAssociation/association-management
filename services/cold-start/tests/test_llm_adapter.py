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


def sse_event(payload: object) -> str:
    data = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    return f"data: {data}\n\n"


@pytest.mark.asyncio
async def test_adapter_requires_and_accumulates_sse_stream() -> None:
    captured_request: httpx.Request | None = None
    progress = RecordingProgressReporter()
    stream_body = "".join(
        (
            sse_event({"choices": [{"delta": {"role": "assistant"}}]}),
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
        stage == "概念" and "收到首个流式片段" in message
        for stage, message in progress.events
    )
    assert any(
        stage == "概念" and "流式接收完成" in message
        for stage, message in progress.events
    )


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
