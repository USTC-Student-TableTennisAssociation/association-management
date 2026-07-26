"""按阅读路径生成不同的、保留页码的阅读单元。"""

from __future__ import annotations

import re
from dataclasses import dataclass

from cold_start.document.models import ParsedPage

MARKDOWN_HEADING_PATTERN = re.compile(r"^\s{0,3}#{1,6}\s+\S.*$")


@dataclass(frozen=True)
class ReadingUnit:
    index: int
    page_numbers: tuple[int, ...]
    content: str

    @property
    def page_label(self) -> str:
        if len(self.page_numbers) == 1:
            return f"第 {self.page_numbers[0]} 页"
        return f"第 {self.page_numbers[0]}–{self.page_numbers[-1]} 页"


def build_reading_units(
    pages: tuple[ParsedPage, ...],
    *,
    target_chars: int,
    overlap_pages: int = 0,
) -> tuple[ReadingUnit, ...]:
    """在页边界切分；target_chars 是软上限，避免截断页内表格或段落。"""

    if target_chars < 1:
        raise ValueError("target_chars 必须大于 0")
    if overlap_pages < 0:
        raise ValueError("overlap_pages 不能为负数")

    units: list[ReadingUnit] = []
    current: list[ParsedPage] = []
    current_chars = 0

    def append_current() -> None:
        if not current:
            return
        body = "\n\n".join(
            f"<!-- source-page: {page.page_number} -->\n{page.markdown}"
            for page in current
        )
        units.append(
            ReadingUnit(
                index=len(units),
                page_numbers=tuple(page.page_number for page in current),
                content=body,
            )
        )

    for page in pages:
        page_chars = len(page.markdown)
        if current and current_chars + page_chars > target_chars:
            append_current()
            retained = current[-overlap_pages:] if overlap_pages else []
            current = list(retained)
            current_chars = sum(len(item.markdown) for item in current)
        current.append(page)
        current_chars += page_chars

    append_current()
    return tuple(units)


def build_structure_scan_unit(
    pages: tuple[ParsedPage, ...],
    *,
    preview_chars_per_page: int,
) -> ReadingUnit:
    """汇集标题和逐页短预览，供结构路径进行一次轻量导航扫描。"""

    if preview_chars_per_page < 1:
        raise ValueError("preview_chars_per_page 必须大于 0")
    if not pages:
        raise ValueError("结构扫描至少需要一页文档")

    page_previews: list[str] = []
    for page in pages:
        headings = [
            line.strip()
            for line in page.markdown.splitlines()
            if MARKDOWN_HEADING_PATTERN.match(line)
        ]
        heading_block = "\n".join(headings) if headings else "（未检测到 Markdown 标题）"
        preview = page.markdown.strip()[:preview_chars_per_page]
        page_previews.append(
            f"〔第 {page.page_number} 页〕\n"
            f"检测到的标题：\n{heading_block}\n"
            f"页面开头预览：\n{preview or '（本页无可用文本）'}"
        )

    return ReadingUnit(
        index=0,
        page_numbers=tuple(page.page_number for page in pages),
        content="\n\n".join(page_previews),
    )
