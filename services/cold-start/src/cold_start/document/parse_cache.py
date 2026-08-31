"""Reusable MinerU-only parsing cache for library documents."""

from __future__ import annotations

import hashlib
import json
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from cold_start.document.document_loader import MinerUDocumentLoader
from cold_start.global_exploration.artifacts import write_parsing_artifacts


@dataclass(frozen=True)
class CachedDocumentParsing:
    cache_directory: Path
    parsed_document_markdown: Path
    parser_name: str
    reused: bool


def parse_document_to_cache(
    *,
    source_path: Path,
    source_suffix: str,
    cache_directory: Path,
    progress: Callable[[str], None] | None = None,
) -> CachedDocumentParsing:
    """Parse one immutable source into a SHA-addressed cache without running exploration."""

    report = progress or (lambda _message: None)
    source = source_path.expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(f"资料库源文件不存在：{source}")
    suffix = source_suffix.lower()
    if not suffix.startswith("."):
        suffix = f".{suffix}"
    if suffix not in MinerUDocumentLoader.SUPPORTED_SUFFIXES:
        raise ValueError(f"不支持的 MinerU 文档类型：{source_suffix}")

    source_sha256 = hashlib.sha256(source.read_bytes()).hexdigest()
    cache = cache_directory.expanduser().resolve()
    cache.mkdir(parents=True, exist_ok=True)
    parsed_document = cache / "parsed-document.md"
    parsed_pages = cache / "parsed-pages.json"
    parsed_blocks = cache / "parsed-blocks.json"
    metadata_path = cache / "parsing-metadata.json"
    metadata = _matching_metadata(metadata_path, source_sha256)
    if metadata and all(path.is_file() for path in (parsed_document, parsed_pages, parsed_blocks)):
        parser_name = str(metadata.get("parser_name") or "mineru-cached")
        report(f"复用 MinerU 解析缓存：{parsed_document}")
        return CachedDocumentParsing(cache, parsed_document, parser_name, True)

    _preserve_incomplete_attempt(cache)
    staged_source = cache / f"source{suffix}"
    if not staged_source.is_file() or _sha256(staged_source) != source_sha256:
        shutil.copy2(source, staged_source)

    loader = MinerUDocumentLoader(progress=report)
    report(
        f"开始 MinerU 仅解析：{staged_source.name}；"
        f"{loader.parser_name}，计算设备 {loader.accelerator_description()}"
    )
    document = loader.load(staged_source, raw_output_directory=cache / "mineru-raw")
    paths = write_parsing_artifacts(run_directory=cache, document=document)
    metadata_payload = {
        "schema_version": "library-mineru-parse.v1",
        "source_sha256": source_sha256,
        "source_suffix": suffix,
        "parser_name": document.parser_name,
        "page_count": document.page_count,
        "block_count": len(document.blocks),
        "parsed_at": datetime.now(UTC).isoformat(),
    }
    temporary_metadata = cache / "parsing-metadata.json.tmp"
    temporary_metadata.write_text(
        json.dumps(metadata_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temporary_metadata.replace(metadata_path)
    report(
        f"MinerU 仅解析完成：{document.page_count} 页、"
        f"{len(document.blocks)} 个稳定块；{paths.parsed_document_markdown}"
    )
    return CachedDocumentParsing(
        cache,
        paths.parsed_document_markdown,
        document.parser_name,
        False,
    )


def _matching_metadata(path: Path, source_sha256: str) -> dict[str, object] | None:
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(raw, dict):
        return None
    if raw.get("schema_version") != "library-mineru-parse.v1":
        return None
    return raw if raw.get("source_sha256") == source_sha256 else None


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _preserve_incomplete_attempt(cache: Path) -> None:
    candidates = [cache / "mineru-raw", cache / "mineru.log"]
    existing = [path for path in candidates if path.exists()]
    if not existing:
        return
    recovery = cache / "failed-attempts" / datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    recovery.mkdir(parents=True, exist_ok=False)
    for path in existing:
        path.replace(recovery / path.name)
