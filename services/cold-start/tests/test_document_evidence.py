from __future__ import annotations

from cold_start.compilation.source_semantics import _semantic_blocks_for_node
from cold_start.document.blocks import format_blocks
from cold_start.document.evidence_links import attach_document_evidence
from cold_start.document.models import ParsedBlock
from cold_start.region_tree.models import RegionNode, SourceSegment
from cold_start.region_tree.runtime import BlockIndex


def _block(
    block_id: str,
    order: int,
    markdown: str,
    *,
    source_type: str = "text",
    block_type: str = "paragraph",
    page: int = 1,
) -> ParsedBlock:
    return ParsedBlock(
        block_id=block_id,
        order=order,
        block_type=block_type,
        source_pages=(page,),
        source_type=source_type,
        markdown=markdown,
    )


def test_page_footnote_attaches_across_a_following_heading() -> None:
    blocks = attach_document_evidence(
        (
            _block("p0001-b0001", 0, "钟会长 $^{1}$ 鼓励大家留下。"),
            _block(
                "p0001-b0002",
                1,
                "## 12.2 下一节",
                block_type="heading",
            ),
            _block("p0001-b0003", 2, "下一节正文。"),
            _block(
                "p0001-b0004",
                3,
                "$^{1}$ 钟轹弘 24-25 级乒协会长",
                source_type="page_footnote",
                block_type="caption",
            ),
        )
    )

    assert [item.block_id for item in blocks[0].attached_evidence] == ["p0001-b0004"]
    assert blocks[1].attached_evidence == ()
    rendered = format_blocks(list(blocks))
    assert "footnote:1->p0001-b0004" in rendered
    assert "source_type=page_footnote" in rendered


def test_footnote_numbers_are_matched_within_each_page() -> None:
    blocks = attach_document_evidence(
        (
            _block("p0001-b0001", 0, "甲 $^{1}$", page=1),
            _block(
                "p0001-b0002",
                1,
                "$^{1}$ 第一页说明",
                source_type="page_footnote",
                block_type="caption",
                page=1,
            ),
            _block("p0002-b0001", 2, "乙 $^{1}$", page=2),
            _block(
                "p0002-b0002",
                3,
                "$^{1}$ 第二页说明",
                source_type="page_footnote",
                block_type="caption",
                page=2,
            ),
        )
    )

    assert blocks[0].attached_evidence[0].block_id == "p0001-b0002"
    assert blocks[2].attached_evidence[0].block_id == "p0002-b0002"


def test_unmatched_page_footnote_remains_unattached() -> None:
    blocks = attach_document_evidence(
        (
            _block("p0001-b0001", 0, "正文没有标记。"),
            _block(
                "p0001-b0002",
                1,
                "$^{2}$ 无对应引用",
                source_type="page_footnote",
                block_type="caption",
            ),
        )
    )

    assert all(not block.attached_evidence for block in blocks)


def test_linked_footnote_compiles_with_its_marker_region_not_its_physical_region() -> None:
    blocks = attach_document_evidence(
        (
            _block("p0001-b0001", 0, "钟会长 $^{1}$ 鼓励大家留下。"),
            _block("p0001-b0002", 1, "## 12.2 下一节", block_type="heading"),
            _block("p0001-b0003", 2, "下一节正文。"),
            _block(
                "p0001-b0004",
                3,
                "$^{1}$ 钟轹弘 24-25 级乒协会长",
                source_type="page_footnote",
                block_type="caption",
            ),
        )
    )
    marker_region = RegionNode(
        node_id="region-0001",
        parent_id=None,
        depth=0,
        label="12.1 上一节",
        introduction="包含带脚注的人物称呼。",
        start_block_id="p0001-b0001",
        end_block_id="p0001-b0001",
        source_pages=[1],
        status="leaf",
        owned_segments=[
            SourceSegment(
                start_block_id="p0001-b0001",
                end_block_id="p0001-b0001",
            )
        ],
        owned_source_role="content_source",
    )
    physical_region = RegionNode(
        node_id="region-0002",
        parent_id=None,
        depth=0,
        label="12.2 下一节",
        introduction="物理上包含页脚注。",
        start_block_id="p0001-b0002",
        end_block_id="p0001-b0004",
        source_pages=[1],
        status="leaf",
        owned_segments=[
            SourceSegment(
                start_block_id="p0001-b0002",
                end_block_id="p0001-b0004",
            )
        ],
        owned_source_role="content_source",
    )
    index = BlockIndex(blocks)

    assert [
        item.block_id for item in _semantic_blocks_for_node(index, marker_region)
    ] == ["p0001-b0001", "p0001-b0004"]
    assert [
        item.block_id for item in _semantic_blocks_for_node(index, physical_region)
    ] == ["p0001-b0002", "p0001-b0003"]
