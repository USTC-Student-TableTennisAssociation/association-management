from __future__ import annotations

from pathlib import Path

import cold_start.document.parse_cache as parse_cache
from cold_start.document.blocks import build_document_blocks
from cold_start.document.models import ParsedDocument, ParsedPage


class FakeDocumentLoader:
    calls = 0
    parser_name = "fake-mineru"
    SUPPORTED_SUFFIXES = frozenset({".pdf", ".docx", ".pptx", ".xlsx"})

    def __init__(self, *, progress=None) -> None:
        self.progress = progress or (lambda _message: None)

    @staticmethod
    def accelerator_description() -> str:
        return "fake-device"

    def load(self, source_path: Path, *, raw_output_directory: Path) -> ParsedDocument:
        type(self).calls += 1
        assert source_path.name == "source.docx"
        assert source_path.read_bytes() == b"docx"
        raw_output_directory.mkdir()
        pages = (ParsedPage(page_number=1, markdown="# 章程\n\n可见正文"),)
        return ParsedDocument(
            source_path=source_path,
            title="章程",
            file_sha256="a" * 64,
            parser_name="mineru-test-office",
            pages=pages,
            blocks=build_document_blocks(pages),
            markdown="# 章程\n\n可见正文",
        )


def test_parse_document_cache_stages_extensionless_blob_and_reuses_result(
    tmp_path: Path,
    monkeypatch,
) -> None:
    source = tmp_path / "blob-without-extension"
    source.write_bytes(b"docx")
    cache = tmp_path / "cache"
    FakeDocumentLoader.calls = 0
    monkeypatch.setattr(parse_cache, "MinerUDocumentLoader", FakeDocumentLoader)

    first = parse_cache.parse_document_to_cache(
        source_path=source,
        source_suffix="docx",
        cache_directory=cache,
    )
    second = parse_cache.parse_document_to_cache(
        source_path=source,
        source_suffix="docx",
        cache_directory=cache,
    )

    assert first.reused is False
    assert second.reused is True
    assert FakeDocumentLoader.calls == 1
    assert first.parsed_document_markdown.read_text(encoding="utf-8") == (
        "# 章程\n\n可见正文"
    )
    assert (cache / "parsed-pages.json").is_file()
    assert (cache / "parsed-blocks.json").is_file()
    assert (cache / "mineru-raw").is_dir()


def test_parse_document_cache_preserves_incomplete_mineru_attempt(
    tmp_path: Path,
    monkeypatch,
) -> None:
    source = tmp_path / "blob"
    source.write_bytes(b"docx")
    cache = tmp_path / "cache"
    (cache / "mineru-raw").mkdir(parents=True)
    (cache / "mineru-raw" / "partial.json").write_text("{}", encoding="utf-8")
    (cache / "mineru.log").write_text("failed", encoding="utf-8")
    FakeDocumentLoader.calls = 0
    monkeypatch.setattr(parse_cache, "MinerUDocumentLoader", FakeDocumentLoader)

    parse_cache.parse_document_to_cache(
        source_path=source,
        source_suffix="docx",
        cache_directory=cache,
    )

    recovered = list((cache / "failed-attempts").glob("*/mineru-raw/partial.json"))
    recovered_logs = list((cache / "failed-attempts").glob("*/mineru.log"))
    assert len(recovered) == 1
    assert len(recovered_logs) == 1
    assert (cache / "mineru-raw").is_dir()
