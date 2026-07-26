"""为两条阅读线路生成保留页码的原文单元。"""

from __future__ import annotations

from dataclasses import dataclass

from cold_start.document.models import ParsedPage


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


def build_full_document_unit(pages: tuple[ParsedPage, ...]) -> ReadingUnit:
    """把完整逐页原文交给只负责宏观切分的线路。"""

    if not pages:
        raise ValueError("完整文档阅读单元至少需要一页")

    return ReadingUnit(
        index=0,
        page_numbers=tuple(page.page_number for page in pages),
        content="\n\n".join(
            f"〔第 {page.page_number} 页〕\n{page.markdown}" for page in pages
        ),
    )
