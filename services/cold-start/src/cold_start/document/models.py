"""冷启动流程使用的文档中间表示。"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

BlockType = Literal[
    "heading",
    "paragraph",
    "list",
    "table",
    "figure",
    "caption",
    "quote",
    "other",
]

class ParsedPage(BaseModel):
    """保留页码锚点的一页结构化文本。"""

    model_config = ConfigDict(frozen=True)

    page_number: int = Field(ge=1)
    markdown: str


class ParsedBlock(BaseModel):
    """不可跨越内部切分的最小来源块。"""

    model_config = ConfigDict(frozen=True)

    block_id: str = Field(pattern=r"^p\d{4}-b\d{4}$")
    order: int = Field(ge=0)
    block_type: BlockType
    source_pages: tuple[int, ...] = Field(min_length=1)
    heading_level: int | None = Field(default=None, ge=1, le=6)
    heading_path: tuple[str, ...] = ()
    source_type: str | None = None
    source_sub_type: str | None = None
    bbox: tuple[float, float, float, float] | None = None
    asset_path: str | None = None
    markdown: str = Field(min_length=1)


class ParsedDocument(BaseModel):
    """与具体 PDF 解析器解耦的文档表示。"""

    model_config = ConfigDict(frozen=True)

    source_path: Path
    title: str
    file_sha256: str
    parser_name: str
    pages: tuple[ParsedPage, ...]
    blocks: tuple[ParsedBlock, ...] = ()
    markdown: str

    @property
    def page_count(self) -> int:
        return len(self.pages)
