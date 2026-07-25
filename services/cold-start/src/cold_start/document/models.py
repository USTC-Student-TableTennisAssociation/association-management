"""冷启动流程使用的文档中间表示。"""

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field


class ParsedPage(BaseModel):
    """保留页码锚点的一页结构化文本。"""

    model_config = ConfigDict(frozen=True)

    page_number: int = Field(ge=1)
    markdown: str


class ParsedDocument(BaseModel):
    """与具体 PDF 解析器解耦的文档表示。"""

    model_config = ConfigDict(frozen=True)

    source_path: Path
    title: str
    file_sha256: str
    parser_name: str
    pages: tuple[ParsedPage, ...]
    markdown: str

    @property
    def page_count(self) -> int:
        return len(self.pages)
