from datetime import UTC, datetime
from pathlib import Path

from cold_start.document.models import ParsedDocument, ParsedPage
from cold_start.global_exploration.artifacts import (
    create_exploration_run_directory,
    write_exploration_artifacts,
)
from cold_start.global_exploration.models import (
    DocumentMemoryLandscape,
    ExplorationBoundaryReview,
    GlobalExplorationSnapshot,
    LandscapeObservationBatch,
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
        document_profile_markdown="文档画像",
        document_structure_markdown="结构",
        document_memory_landscape=DocumentMemoryLandscape(
            scope_note="只用于定位后续阅读区域。"
        ),
        review_history=[
            ExplorationBoundaryReview(
                acceptable_as_global_exploration=True,
                overall_assessment="可冻结",
            )
        ],
        frozen_with_boundary_issues=False,
        route_statistics=RouteStatistics(
            profile_units=1,
            structure_scans=1,
            landscape_units=1,
            landscape_merge_calls=1,
            review_rounds=1,
        ),
        landscape_observations=(
            LandscapeObservationBatch(unit_pages=[1]),
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
    assert paths.landscape_observations_json.exists()
    assert paths.parsed_document_markdown.read_text(encoding="utf-8") == "# 全文"
    snapshot_text = paths.snapshot_json.read_text(encoding="utf-8").replace(" ", "")
    assert '"authority":"preliminary-low-authority"' in snapshot_text
    assert '"schema_version":"global-exploration.v3"' in snapshot_text
    assert "landscape_observations" not in snapshot_text
    assert "低权威初步观察" in paths.report_markdown.read_text(encoding="utf-8")
    assert '"unit_pages": [' in paths.landscape_observations_json.read_text(
        encoding="utf-8"
    )
