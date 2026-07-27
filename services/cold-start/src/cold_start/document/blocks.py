"""把逐页 Markdown 编译为稳定、不可从内部切分的来源块。"""

from __future__ import annotations

import re

from cold_start.document.models import ParsedBlock, ParsedPage

HEADING_PATTERN = re.compile(r"^\s{0,3}(#{1,6})\s+(.+?)\s*$")
LIST_PATTERN = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+\S")
TABLE_SEPARATOR_PATTERN = re.compile(
    r"^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$"
)
IMAGE_PATTERN = re.compile(r"^\s*(?:!\[[^\]]*]\([^)]+\)|<!--\s*image\s*-->)")
CAPTION_PATTERN = re.compile(r"^\s*(?:图|表|figure|table)\s*[\d.：:]", re.IGNORECASE)


def build_document_blocks(pages: tuple[ParsedPage, ...]) -> tuple[ParsedBlock, ...]:
    """按标题、段落、列表和表格边界建立全文稳定块序列。"""

    if not pages:
        raise ValueError("建立来源块至少需要一页文档")

    blocks: list[ParsedBlock] = []
    heading_stack: list[str] = []
    for page in pages:
        page_blocks = _split_page_markdown(page.markdown)
        for page_block_index, (block_type, markdown, heading_level) in enumerate(
            page_blocks,
            start=1,
        ):
            if block_type == "heading":
                assert heading_level is not None
                heading_text = _heading_text(markdown)
                heading_stack = heading_stack[: heading_level - 1]
                heading_stack.append(heading_text)

            blocks.append(
                ParsedBlock(
                    block_id=f"p{page.page_number:04d}-b{page_block_index:04d}",
                    order=len(blocks),
                    block_type=block_type,
                    source_pages=(page.page_number,),
                    heading_level=heading_level,
                    heading_path=tuple(heading_stack),
                    markdown=markdown,
                )
            )

    if not blocks:
        raise ValueError("文档没有可用于区域切分的来源块")
    return tuple(blocks)


def format_blocks(blocks: tuple[ParsedBlock, ...] | list[ParsedBlock]) -> str:
    """渲染供模型阅读的带稳定锚点原文。"""

    return "\n\n".join(
        (
            f"[{block.block_id} | {block.block_type} | "
            f"第 {'、'.join(str(page) for page in block.source_pages)} 页]\n"
            f"{block.markdown}"
        )
        for block in blocks
    )


def render_heading_outline(
    blocks: tuple[ParsedBlock, ...] | list[ParsedBlock],
) -> str:
    headings = [
        (
            "  " * ((block.heading_level or 1) - 1)
            + f"- {block.block_id} "
            + _heading_text(block.markdown)
        )
        for block in blocks
        if block.block_type == "heading"
    ]
    return "\n".join(headings) if headings else "（当前区域没有显式标题）"


def _split_page_markdown(
    markdown: str,
) -> list[tuple[str, str, int | None]]:
    lines = markdown.splitlines()
    blocks: list[tuple[str, str, int | None]] = []
    cursor = 0

    while cursor < len(lines):
        line = lines[cursor]
        if not line.strip():
            cursor += 1
            continue

        heading = HEADING_PATTERN.match(line)
        if heading:
            blocks.append(("heading", line.strip(), len(heading.group(1))))
            cursor += 1
            continue

        if _starts_table(lines, cursor):
            collected = [line]
            cursor += 1
            while cursor < len(lines) and _is_table_line(lines[cursor]):
                collected.append(lines[cursor])
                cursor += 1
            blocks.append(("table", "\n".join(collected).strip(), None))
            continue

        if LIST_PATTERN.match(line):
            collected = [line]
            cursor += 1
            while cursor < len(lines):
                candidate = lines[cursor]
                if not candidate.strip():
                    break
                if HEADING_PATTERN.match(candidate) or _starts_table(lines, cursor):
                    break
                if LIST_PATTERN.match(candidate) or candidate.startswith((" ", "\t")):
                    collected.append(candidate)
                    cursor += 1
                    continue
                break
            blocks.append(("list", "\n".join(collected).strip(), None))
            continue

        if IMAGE_PATTERN.match(line):
            collected = [line]
            cursor += 1
            if cursor < len(lines) and CAPTION_PATTERN.match(lines[cursor]):
                collected.append(lines[cursor])
                cursor += 1
            blocks.append(("figure", "\n".join(collected).strip(), None))
            continue

        block_type = "quote" if line.lstrip().startswith(">") else "paragraph"
        collected = [line]
        cursor += 1
        while cursor < len(lines):
            candidate = lines[cursor]
            if not candidate.strip():
                break
            if (
                HEADING_PATTERN.match(candidate)
                or LIST_PATTERN.match(candidate)
                or IMAGE_PATTERN.match(candidate)
                or _starts_table(lines, cursor)
            ):
                break
            if block_type == "quote" and not candidate.lstrip().startswith(">"):
                break
            collected.append(candidate)
            cursor += 1
        rendered = "\n".join(collected).strip()
        resolved_type = (
            "caption"
            if block_type == "paragraph" and CAPTION_PATTERN.match(rendered)
            else block_type
        )
        blocks.append((resolved_type, rendered, None))

    return blocks


def _starts_table(lines: list[str], cursor: int) -> bool:
    if cursor + 1 >= len(lines):
        return False
    return "|" in lines[cursor] and bool(
        TABLE_SEPARATOR_PATTERN.match(lines[cursor + 1])
    )


def _is_table_line(line: str) -> bool:
    return bool(line.strip()) and "|" in line


def _heading_text(markdown: str) -> str:
    match = HEADING_PATTERN.match(markdown)
    return match.group(2).strip() if match else markdown.strip()
