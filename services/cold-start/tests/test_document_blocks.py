from cold_start.document.blocks import build_document_blocks
from cold_start.document.models import ParsedPage


def test_markdown_blocks_are_stable_and_keep_heading_context_across_pages() -> None:
    blocks = build_document_blocks(
        (
            ParsedPage(
                page_number=1,
                markdown=(
                    "# 比赛\n\n"
                    "比赛说明。\n\n"
                    "## 申请\n\n"
                    "- 准备材料\n"
                    "- 提交申请"
                ),
            ),
            ParsedPage(
                page_number=2,
                markdown=(
                    "申请后的补充说明。\n\n"
                    "| 物资 | 数量 |\n"
                    "| --- | --- |\n"
                    "| 球台 | 2 |"
                ),
            ),
        )
    )

    assert [block.block_id for block in blocks] == [
        "p0001-b0001",
        "p0001-b0002",
        "p0001-b0003",
        "p0001-b0004",
        "p0002-b0001",
        "p0002-b0002",
    ]
    assert [block.block_type for block in blocks] == [
        "heading",
        "paragraph",
        "heading",
        "list",
        "paragraph",
        "table",
    ]
    assert blocks[-1].heading_path == ("比赛", "申请")
    assert "球台" in blocks[-1].markdown
