from datetime import UTC, datetime
from pathlib import Path

from cold_start.document.models import ParsedDocument, ParsedPage
from cold_start.global_exploration.artifacts import write_exploration_artifacts
from cold_start.global_exploration.models import (
    ConceptSketch,
    GlobalExplorationSnapshot,
    ReconciliationReview,
    RouteStatistics,
    SourceMetadata,
)


def test_artifact_writer_keeps_machine_and_human_readable_outputs(tmp_path: Path) -> None:
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
        global_summary_markdown="总结",
        document_structure_markdown="结构",
        concept_sketch=ConceptSketch(document_level_observation="观察"),
        review_history=[
            ReconciliationReview(
                accepted_as_initial_impression=True,
                overall_assessment="可冻结",
            )
        ],
        frozen_with_unresolved_issues=False,
        route_statistics=RouteStatistics(
            summary_units=1,
            structure_units=1,
            concept_units=1,
            review_rounds=1,
        ),
    )

    paths = write_exploration_artifacts(
        output_root=tmp_path,
        document=document,
        snapshot=snapshot,
    )

    assert paths.snapshot_json.exists()
    assert paths.report_markdown.exists()
    assert paths.parsed_document_markdown.read_text(encoding="utf-8") == "# 全文"
    assert '"authority":"preliminary-low-authority"' in paths.snapshot_json.read_text(
        encoding="utf-8"
    ).replace(" ", "")
    assert "低权威初步印象" in paths.report_markdown.read_text(encoding="utf-8")
