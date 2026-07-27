from datetime import UTC, datetime
from pathlib import Path

from cold_start.document.blocks import build_document_blocks
from cold_start.document.models import ParsedDocument, ParsedPage
from cold_start.global_exploration.artifacts import (
    create_exploration_run_directory,
    write_exploration_artifacts,
)
from cold_start.global_exploration.models import (
    GlobalExplorationSnapshot,
    SourceMetadata,
)
from cold_start.region_tree.models import RegionNode, RegionTreeSnapshot


def test_artifact_writer_keeps_context_tree_and_source(tmp_path: Path) -> None:
    pages = (ParsedPage(page_number=1, markdown="# 首页\n\n正文"),)
    blocks = build_document_blocks(pages)
    document = ParsedDocument(
        source_path=Path("/tmp/handbook.pdf"),
        title="手册",
        file_sha256="c" * 64,
        parser_name="test",
        pages=pages,
        blocks=blocks,
        markdown="# 首页\n\n正文",
    )
    root = RegionNode(
        node_id="region-0001",
        parent_id=None,
        depth=0,
        label="手册",
        introduction="完整测试手册。",
        start_block_id=blocks[0].block_id,
        end_block_id=blocks[-1].block_id,
        source_pages=[1],
        status="leaf",
    )
    snapshot = GlobalExplorationSnapshot(
        created_at=datetime(2026, 7, 25, tzinfo=UTC),
        source=SourceMetadata(
            path=str(document.source_path),
            title=document.title,
            sha256=document.file_sha256,
            parser=document.parser_name,
            page_count=1,
            block_count=2,
        ),
        document_context_markdown="这是一份协会内部手册。",
        context_model_calls=1,
        region_tree=RegionTreeSnapshot(
            status="frozen",
            root_node_id=root.node_id,
            nodes=[root],
            leaf_node_ids=[root.node_id],
            model_calls=1,
        ),
    )
    directory = create_exploration_run_directory(
        output_root=tmp_path,
        document=document,
    )
    paths = write_exploration_artifacts(
        run_directory=directory,
        document=document,
        snapshot=snapshot,
    )

    assert paths.snapshot_json.exists()
    assert paths.region_tree_json.exists()
    assert paths.parsed_blocks_json.exists()
    assert paths.document_context_markdown.read_text() == "这是一份协会内部手册。"
    assert "region-0001" in paths.region_tree_markdown.read_text()
    assert "区域树" in paths.report_markdown.read_text()
