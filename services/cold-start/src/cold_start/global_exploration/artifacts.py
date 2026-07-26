"""将两条线路的全局勘探结果和调试中间产物落盘。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from cold_start.document.models import ParsedDocument
from cold_start.global_exploration.models import GlobalExplorationSnapshot


@dataclass(frozen=True)
class ArtifactPaths:
    run_directory: Path
    snapshot_json: Path
    report_markdown: Path
    document_context_markdown: Path
    macro_sections_json: Path
    parsed_document_markdown: Path
    parsed_pages_json: Path


def create_exploration_run_directory(
    *,
    output_root: Path,
    document: ParsedDocument,
) -> Path:
    """在模型调用前创建目录，使失败请求仍能留下流式调试记录。"""

    started_at = datetime.now(UTC)
    run_id = f"{started_at:%Y%m%dT%H%M%SZ}-{document.file_sha256[:10]}"
    run_directory = output_root.expanduser().resolve() / run_id
    run_directory.mkdir(parents=True, exist_ok=False)
    return run_directory


def write_exploration_artifacts(
    *,
    run_directory: Path,
    document: ParsedDocument,
    snapshot: GlobalExplorationSnapshot,
) -> ArtifactPaths:
    """写入主快照、两条线路产物和 PDF 解析结果。"""

    snapshot_json = run_directory / "global-exploration.json"
    report_markdown = run_directory / "global-exploration.md"
    document_context_markdown = run_directory / "document-context.md"
    macro_sections_json = run_directory / "macro-sections.json"
    parsed_document_markdown = run_directory / "parsed-document.md"
    parsed_pages_json = run_directory / "parsed-pages.json"

    snapshot_json.write_text(
        snapshot.model_dump_json(indent=2),
        encoding="utf-8",
    )
    report_markdown.write_text(
        _render_report(snapshot),
        encoding="utf-8",
    )
    document_context_markdown.write_text(
        snapshot.document_context_markdown,
        encoding="utf-8",
    )
    macro_sections_json.write_text(
        json.dumps(
            [section.model_dump() for section in snapshot.macro_sections],
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    parsed_document_markdown.write_text(
        document.markdown,
        encoding="utf-8",
    )
    parsed_pages_json.write_text(
        json.dumps(
            [page.model_dump() for page in document.pages],
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    return ArtifactPaths(
        run_directory=run_directory,
        snapshot_json=snapshot_json,
        report_markdown=report_markdown,
        document_context_markdown=document_context_markdown,
        macro_sections_json=macro_sections_json,
        parsed_document_markdown=parsed_document_markdown,
        parsed_pages_json=parsed_pages_json,
    )


def _render_report(snapshot: GlobalExplorationSnapshot) -> str:
    sections = "\n".join(
        (
            f"- **{section.label}**：第 {section.start_page}–"
            f"{section.end_page} 页"
        )
        for section in snapshot.macro_sections
    )
    return f"""# 全局勘探结果

> 权威级别：低权威初步观察
> 输入：{snapshot.source.title}（{snapshot.source.page_count} 页）
> SHA-256：`{snapshot.source.sha256}`

## 文档上下文

{snapshot.document_context_markdown}

## 宏观阅读分区

{sections}
"""
