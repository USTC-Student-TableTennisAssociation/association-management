from datetime import UTC, datetime
from pathlib import Path

from cold_start.document.models import ParsedDocument, ParsedPage
from cold_start.global_exploration.artifacts import (
    create_exploration_run_directory,
    write_exploration_artifacts,
)
from cold_start.global_exploration.models import (
    GlobalExplorationSnapshot,
    MacroSection,
    RouteStatistics,
    SourceMetadata,
)


def test_artifact_writer_keeps_two_routes_and_debug_outputs(tmp_path: Path) -> None:
    document = ParsedDocument(
        source_path=Path("/tmp/handbook.pdf"),
        title="手册",
        file_sha256="c" * 64,
        parser_name="test",
        pages=(ParsedPage(page_number=1, markdown="# 首页"),),
        markdown="# 全文",
    )
    snapshot = GlobalExplorationSnapshot(
        created_at=datetime(2026, 7, 25, tzinfo=UTC),
        source=SourceMetadata(
            path=str(document.source_path),
            title=document.title,
            sha256=document.file_sha256,
            parser=document.parser_name,
            page_count=1,
        ),
        document_context_markdown="这是一份协会内部手册。",
        macro_sections=[
            MacroSection(label="手册内容", start_page=1, end_page=1),
        ],
        route_statistics=RouteStatistics(
            context_units=1,
            macro_section_calls=1,
        ),
    )

    run_directory = create_exploration_run_directory(
        output_root=tmp_path,
        document=document,
    )
    paths = write_exploration_artifacts(
        run_directory=run_directory,
        document=document,
        snapshot=snapshot,
    )

    assert paths.snapshot_json.exists()
    assert paths.report_markdown.exists()
    assert paths.document_context_markdown.read_text(encoding="utf-8") == (
        "这是一份协会内部手册。"
    )
    assert paths.macro_sections_json.exists()
    assert paths.parsed_document_markdown.read_text(encoding="utf-8") == "# 全文"
    snapshot_text = paths.snapshot_json.read_text(encoding="utf-8").replace(" ", "")
    assert '"authority":"preliminary-low-authority"' in snapshot_text
    assert '"schema_version":"global-exploration.v4"' in snapshot_text
    report = paths.report_markdown.read_text(encoding="utf-8")
    assert "文档上下文" in report
    assert "宏观阅读分区" in report
