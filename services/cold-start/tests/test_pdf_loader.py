import json
from pathlib import Path

import pytest

from cold_start.document.pdf_loader import MinerUPdfLoader


def test_mineru_loader_uses_verified_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    for variable in (
        "COLD_START_MINERU_BACKEND",
        "COLD_START_MINERU_EFFORT",
        "COLD_START_MINERU_METHOD",
        "COLD_START_MINERU_IMAGE_ANALYSIS",
    ):
        monkeypatch.delenv(variable, raising=False)

    loader = MinerUPdfLoader()

    assert loader.backend == "hybrid-engine"
    assert loader.effort == "high"
    assert loader.method == "auto"
    assert loader.image_analysis is True


def test_mineru_loader_builds_explicit_command() -> None:
    command = MinerUPdfLoader()._command(
        "mineru",
        Path("input.pdf"),
        Path("raw"),
    )

    assert command == [
        "mineru",
        "-p",
        "input.pdf",
        "-o",
        "raw",
        "-b",
        "hybrid-engine",
        "--effort",
        "high",
        "-m",
        "auto",
        "--image-analysis",
        "true",
    ]


def test_mineru_content_list_becomes_native_source_blocks(tmp_path: Path) -> None:
    source = tmp_path / "手册.pdf"
    source.write_bytes(b"pdf")
    run_directory = tmp_path / "run"
    raw = run_directory / "mineru-raw" / "手册" / "hybrid_auto"
    images = raw / "images"
    images.mkdir(parents=True)
    (images / "record.jpg").write_bytes(b"image")
    (raw / "手册_content_list.json").write_text(
        json.dumps(
            [
                {
                    "type": "text",
                    "text": "乒协概览",
                    "text_level": 1,
                    "bbox": [10, 20, 900, 80],
                    "page_idx": 0,
                },
                {
                    "type": "list",
                    "sub_type": "text",
                    "list_items": ["1. 第一项", "2. 第二项"],
                    "bbox": [10, 90, 900, 160],
                    "page_idx": 0,
                },
                {
                    "type": "table",
                    "table_caption": ["Table B.1: 历任会长名单"],
                    "table_body": "<table><tr><td>2025-2026</td><td>魏汉东</td></tr></table>",
                    "bbox": [10, 200, 900, 500],
                    "page_idx": 1,
                },
                {
                    "type": "image",
                    "sub_type": "text_image",
                    "img_path": "images/record.jpg",
                    "content": "乒协筹委会成立名单",
                    "bbox": [20, 520, 880, 900],
                    "page_idx": 1,
                },
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    document = MinerUPdfLoader()._load_content_list(
        source,
        run_directory / "mineru-raw",
    )

    assert document.page_count == 2
    assert len(document.blocks) == 4
    assert document.blocks[0].block_type == "heading"
    assert document.blocks[0].bbox == (10.0, 20.0, 900.0, 80.0)
    assert document.blocks[2].block_type == "table"
    assert "<table>" in document.blocks[2].markdown
    assert document.blocks[3].source_sub_type == "text_image"
    assert document.blocks[3].asset_path == (
        "mineru-raw/手册/hybrid_auto/images/record.jpg"
    )
    assert "乒协筹委会成立名单" in document.blocks[3].markdown


def test_mineru_loader_rejects_unknown_configuration() -> None:
    with pytest.raises(ValueError, match="COLD_START_MINERU_EFFORT"):
        MinerUPdfLoader(effort="extreme")  # type: ignore[arg-type]
