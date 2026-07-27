import json
from collections.abc import Mapping

import httpx
import pytest

from cold_start.config import ModelSettings
from cold_start.llm.openai_compatible import (
    ModelProtocolError,
    OpenAICompatibleChatModel,
)


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
                api_base_url="http://model.test//v1/",
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
            request_label="测试",
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
        stage == "测试" and "收到首个正文片段" in message
        for stage, message in progress.events
    )
    assert any(
        stage == "测试" and "流式接收完成" in message
        for stage, message in progress.events
    )
    assert any(stage == "测试·思考" for stage, _ in progress.events)
    assert any(stage == "测试·正文" for stage, _ in progress.events)
    assert "先理解问题。" in next(tmp_path.glob("*.reasoning.partial.txt")).read_text(
        encoding="utf-8"
    )
    assert "勘探结果" in next(tmp_path.glob("*.content.partial.txt")).read_text(
        encoding="utf-8"
    )
    request_trace = json.loads(next(tmp_path.glob("*.request.json")).read_text())
    assert request_trace["payload"]["messages"] == [
        {"role": "system", "content": "系统"},
        {"role": "user", "content": "用户"},
    ]
    assert "Authorization" not in request_trace
    assert "secret" not in json.dumps(request_trace)


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
        with pytest.raises(ModelProtocolError, match="未收到 data 事件"):
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
        with pytest.raises(RuntimeError, match="测试流式传输连续失败"):
            await model.complete(
                system_prompt="系统",
                user_prompt="用户",
                request_label="测试",
            )

    assert "尚未完成的思考" in next(
        tmp_path.glob("*.reasoning.partial.txt")
    ).read_text(encoding="utf-8")
    assert '{"partial": true' in next(
        tmp_path.glob("*.content.partial.txt")
    ).read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_adapter_streams_tool_calls_and_accepts_tool_result_messages() -> None:
    request_bodies: list[dict[str, object]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        request_bodies.append(body)
        if len(request_bodies) == 1:
            stream_body = "".join(
                (
                    sse_event(
                        {
                            "choices": [
                                {
                                    "delta": {
                                        "reasoning_content": "需要调用文档检索。"
                                    }
                                }
                            ]
                        }
                    ),
                    sse_event(
                        {
                            "choices": [
                                {
                                    "delta": {
                                        "tool_calls": [
                                            {
                                                "index": 0,
                                                "id": "call_",
                                                "type": "function",
                                                "function": {
                                                    "name": "search_",
                                                    "arguments": '{"query":"',
                                                },
                                            }
                                        ]
                                    }
                                }
                            ]
                        }
                    ),
                    sse_event(
                        {
                            "choices": [
                                {
                                    "delta": {
                                        "tool_calls": [
                                            {
                                                "index": 0,
                                                "id": "001",
                                                "function": {
                                                    "name": "document",
                                                    "arguments": '二课"}',
                                                },
                                            }
                                        ]
                                    },
                                    "finish_reason": "tool_calls",
                                }
                            ]
                        }
                    ),
                    sse_event("[DONE]"),
                )
            )
        else:
            stream_body = "".join(
                (
                    sse_event({"choices": [{"delta": {"content": "已使用工具结果"}}]}),
                    sse_event("[DONE]"),
                )
            )
        return httpx.Response(
            200,
            headers={"Content-Type": "text/event-stream"},
            text=stream_body,
        )

    tool: Mapping[str, object] = {
        "type": "function",
        "function": {
            "name": "search_document",
            "parameters": {"type": "object"},
        },
    }
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        model = OpenAICompatibleChatModel(
            ModelSettings(
                model="test-model",
                api_base_url="http://model.test/v1",
                api_key=None,
            ),
            client=client,
        )
        first = await model.complete_turn(
            messages=[{"role": "user", "content": "查找二课"}],
            tools=[tool],
            tool_choice={
                "type": "function",
                "function": {"name": "search_document"},
            },
            thinking="enabled",
        )
        second = await model.complete_turn(
            messages=[
                {"role": "user", "content": "查找二课"},
                first.as_assistant_message(),
                {
                    "role": "tool",
                    "tool_call_id": first.tool_calls[0].id,
                    "content": "二课申请位于第 2 页",
                },
            ],
            thinking="enabled",
        )

    assert first.content == ""
    assert first.reasoning_content == "需要调用文档检索。"
    assert first.tool_calls[0].id == "call_001"
    assert first.tool_calls[0].name == "search_document"
    assert json.loads(first.tool_calls[0].arguments) == {"query": "二课"}
    assert second.content == "已使用工具结果"
    assert request_bodies[0]["tools"] == [tool]
    assert request_bodies[0]["tool_choice"] == {
        "type": "function",
        "function": {"name": "search_document"},
    }
    assert request_bodies[0]["thinking"] == {
        "type": "enabled",
        "clear_thinking": False,
    }
    second_messages = request_bodies[1]["messages"]
    assert isinstance(second_messages, list)
    assert second_messages[-2]["reasoning_content"] == "需要调用文档检索。"
    assert second_messages[-1]["role"] == "tool"
    assert second_messages[-1]["tool_call_id"] == "call_001"
    assert request_bodies[1]["thinking"] == {
        "type": "enabled",
        "clear_thinking": False,
    }


@pytest.mark.asyncio
async def test_adapter_returns_reasoning_only_turn_without_transport_retry() -> None:
    requests = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        del request
        return httpx.Response(
            200,
            headers={"Content-Type": "text/event-stream"},
            text="".join(
                (
                    sse_event(
                        {
                            "choices": [
                                {
                                    "delta": {
                                        "reasoning_content": "已经完成判断。"
                                    }
                                }
                            ]
                        }
                    ),
                    sse_event(
                        {
                            "choices": [
                                {"delta": {}, "finish_reason": "stop"}
                            ]
                        }
                    ),
                    sse_event("[DONE]"),
                )
            ),
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        model = OpenAICompatibleChatModel(
            ModelSettings(
                model="test-model",
                api_base_url="http://model.test/v1",
                api_key=None,
                max_retries=2,
            ),
            client=client,
        )
        turn = await model.complete_turn(
            messages=[{"role": "user", "content": "输出 JSON"}],
            thinking="enabled",
        )

    assert requests == 1
    assert turn.content == ""
    assert turn.reasoning_content == "已经完成判断。"
