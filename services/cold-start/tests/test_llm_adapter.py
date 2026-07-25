import json

import httpx
import pytest

from cold_start.config import ModelSettings
from cold_start.llm.openai_compatible import OpenAICompatibleChatModel


@pytest.mark.asyncio
async def test_openai_compatible_adapter_builds_endpoint_and_extracts_text() -> None:
    captured_request: httpx.Request | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal captured_request
        captured_request = request
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "  勘探结果  "}}]},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        model = OpenAICompatibleChatModel(
            ModelSettings(
                model="test-model",
                api_base_url="http://model.test/v1/",
                api_key="secret",
            ),
            client=client,
        )
        result = await model.complete(
            system_prompt="系统",
            user_prompt="用户",
        )

    assert result == "勘探结果"
    assert captured_request is not None
    assert str(captured_request.url) == "http://model.test/v1/chat/completions"
    assert captured_request.headers["Authorization"] == "Bearer secret"
    body = json.loads(captured_request.content)
    assert body["model"] == "test-model"
