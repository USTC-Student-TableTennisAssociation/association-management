from pathlib import Path

from cold_start.document.models import ParsedDocument, ParsedPage
from cold_start.global_exploration.units import (
    build_reading_units,
    build_structure_scan_unit,
)


def make_document() -> ParsedDocument:
    pages = tuple(
        ParsedPage(page_number=index, markdown=character * 10)
        for index, character in enumerate(("甲", "乙", "丙", "丁"), start=1)
    )
    return ParsedDocument(
        source_path=Path("/tmp/handbook.pdf"),
        title="测试手册",
        file_sha256="a" * 64,
        parser_name="test",
        pages=pages,
        markdown="全文",
    )


def test_build_reading_units_preserves_page_boundaries_and_overlap() -> None:
    units = build_reading_units(
        make_document().pages,
        target_chars=21,
        overlap_pages=1,
    )

    assert [unit.page_numbers for unit in units] == [(1, 2), (2, 3), (3, 4)]
    assert "<!-- source-page: 2 -->" in units[1].content


def test_page_count_comes_from_parsed_pages() -> None:
    assert make_document().page_count == 4


def test_build_structure_scan_unit_collects_headings_and_short_page_previews() -> None:
    pages = (
        ParsedPage(page_number=1, markdown="# 目录\n第一章 基本情况\n第二章 比赛"),
        ParsedPage(page_number=2, markdown="## 第一章 基本情况\n" + "协会介绍" * 20),
    )

    unit = build_structure_scan_unit(pages, preview_chars_per_page=20)

    assert unit.page_numbers == (1, 2)
    assert "〔第 1 页〕" in unit.content
    assert "# 目录" in unit.content
    assert "## 第一章 基本情况" in unit.content
    assert "协会介绍" in unit.content
    assert ("协会介绍" * 20) not in unit.content
