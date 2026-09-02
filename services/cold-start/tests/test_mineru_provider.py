from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from cold_start.document.document_loader import MinerUDocumentLoader
from cold_start.document.mineru_provider import (
    ApiMinerUProvider,
    LocalMinerUProvider,
    MinerUApiSettings,
    MinerUOptions,
    create_mineru_provider,
)


def options() -> MinerUOptions:
    return MinerUOptions(
        backend="hybrid-engine",
        effort="medium",
        method="auto",
        image_analysis=True,
    )


def test_api_settings_derive_ustc_mineru_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MINERU_API_BASE_URL", "https://api.llm.ustc.edu.cn/v1")
    monkeypatch.setenv("MINERU_API_KEY", "test-key")
    monkeypatch.setenv("MINERU_MODEL", "mineru")

    settings = MinerUApiSettings.from_environment()

    assert settings.resolved_file_parse_url() == (
        "https://api.llm.ustc.edu.cn/mineru/file_parse"
    )


def test_provider_auto_selects_api_when_mineru_base_url_exists(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("COLD_START_MINERU_PROVIDER", "auto")
    monkeypatch.setenv("MINERU_API_BASE_URL", "https://api.llm.ustc.edu.cn/v1")
    monkeypatch.setenv("AI_API_KEY", "shared-school-key")
    monkeypatch.delenv("MINERU_API_KEY", raising=False)

    provider = create_mineru_provider(options())

    assert isinstance(provider, ApiMinerUProvider)
    assert provider.settings.api_key == "shared-school-key"


def test_provider_can_be_forced_to_local(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COLD_START_MINERU_PROVIDER", "local")
    monkeypatch.setenv("MINERU_API_BASE_URL", "https://api.llm.ustc.edu.cn/v1")
    monkeypatch.setenv("MINERU_API_KEY", "test-key")

    assert isinstance(create_mineru_provider(options()), LocalMinerUProvider)


def test_api_provider_materializes_standard_mineru_response(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    source.write_bytes(b"public test pdf")
    content_list = [{
        "type": "text",
        "text": "测试标题",
        "text_level": 1,
        "bbox": [10, 20, 900, 80],
        "page_idx": 0,
    }, {
        "type": "image",
        "img_path": "images/chart.png",
        "content": "图表说明",
        "bbox": [20, 100, 800, 700],
        "page_idx": 0,
    }]

    def handler(request: httpx.Request) -> httpx.Response:
        request.read()
        assert request.headers["authorization"] == "Bearer secret-key"
        assert b'name="return_content_list"' in request.content
        assert b'name="return_images"' in request.content
        assert b'name="backend"' not in request.content
        assert b'name="effort"' not in request.content
        assert b'name="parse_method"' not in request.content
        assert b'name="image_analysis"' not in request.content
        assert b"source.pdf" in request.content
        return httpx.Response(200, json={
            "backend": "hybrid-engine",
            "version": "3.4.4",
            "results": {
                "source": {
                    "md_content": "# 测试标题",
                    "content_list": json.dumps(content_list, ensure_ascii=False),
                    "images": {
                        "chart.png": "data:image/png;base64,aW1hZ2U=",
                    },
                },
            },
        })

    provider = ApiMinerUProvider(
        options(),
        MinerUApiSettings(
            base_url="https://api.llm.ustc.edu.cn/v1",
            api_key="secret-key",
            model="mineru",
            timeout_seconds=30,
        ),
        transport=httpx.MockTransport(handler),
    )
    loader = MinerUDocumentLoader(
        effort="medium",
        provider=provider,
    )
    document = loader.load(source, raw_output_directory=tmp_path / "mineru-raw")

    assert document.parser_name == "mineru-api-3.4.4-hybrid-engine-medium"
    assert document.pages[0].markdown.startswith("# 测试标题")
    assert document.blocks[1].asset_path == "mineru-raw/source/api/images/chart.png"
    assert (tmp_path / "mineru-raw/source/api/source_content_list.json").is_file()
    assert (tmp_path / "mineru-raw/source/api/images/chart.png").read_bytes() == b"image"
    log = (tmp_path / "mineru.log").read_text(encoding="utf-8")
    assert "secret-key" not in log
    assert "api.llm.ustc.edu.cn" in log


def test_api_provider_cache_key_ignores_local_cli_options() -> None:
    settings = MinerUApiSettings(
        base_url="https://api.llm.ustc.edu.cn/v1",
        api_key="secret-key",
        model="mineru",
        timeout_seconds=30,
    )
    provider = ApiMinerUProvider(options(), settings)
    other_options = MinerUOptions(
        backend="pipeline",
        effort="high",
        method="ocr",
        image_analysis=False,
    )

    assert provider.cache_key == ApiMinerUProvider(other_options, settings).cache_key
    assert "api.llm.ustc.edu.cn" in provider.cache_key


def test_api_provider_keeps_a_safe_failure_log(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    source.write_bytes(b"pdf")

    provider = ApiMinerUProvider(
        options(),
        MinerUApiSettings(
            base_url="https://api.llm.ustc.edu.cn/v1",
            api_key="secret-key",
            model="mineru",
            timeout_seconds=30,
        ),
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(503, json={"detail": "busy"})
        ),
    )

    with pytest.raises(RuntimeError, match="HTTP 503"):
        provider.execute(source, tmp_path / "mineru-raw", progress=lambda _message: None)
    log = (tmp_path / "mineru.log").read_text(encoding="utf-8")
    assert "secret-key" not in log
    assert '"status": 503' in log
