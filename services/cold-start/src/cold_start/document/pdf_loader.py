"""基于 Docling 的 PDF 解析器。"""

from __future__ import annotations

import hashlib
from io import BytesIO
from pathlib import Path

from cold_start.document.blocks import build_document_blocks
from cold_start.document.models import ParsedDocument, ParsedPage


class DoclingPdfLoader:
    """用 Docling 保留阅读顺序、表格结构和页码来源。"""

    parser_name = "docling"

    def load(self, source_path: Path) -> ParsedDocument:
        path = source_path.expanduser().resolve()
        self._validate_path(path)

        # 延迟导入，令不需要真实解析器的单元测试无需加载模型依赖。
        from docling.datamodel.base_models import DocumentStream
        from docling.document_converter import DocumentConverter

        source_bytes = path.read_bytes()
        file_sha256 = hashlib.sha256(source_bytes).hexdigest()
        result = DocumentConverter().convert(
            DocumentStream(
                name=f"{file_sha256}.pdf",
                stream=BytesIO(source_bytes),
            )
        )
        document = result.document
        page_numbers = sorted(int(page_number) for page_number in document.pages)

        pages = tuple(
            ParsedPage(
                page_number=page_number,
                markdown=self._export_page(document, page_number),
            )
            for page_number in page_numbers
        )
        if not pages:
            raise ValueError(f"PDF 未解析出任何页面：{path}")
        if not any(page.markdown.strip() for page in pages):
            raise ValueError(f"PDF 未解析出可用文本：{path}")

        parsed_document = ParsedDocument(
            source_path=path,
            title=path.stem,
            file_sha256=file_sha256,
            parser_name=self.parser_name,
            pages=pages,
            markdown=document.export_to_markdown(
                page_break_placeholder="\n\n<!-- page-break -->\n\n",
                traverse_pictures=True,
            ).strip(),
        )
        return parsed_document.model_copy(
            update={"blocks": build_document_blocks(parsed_document.pages)}
        )

    @staticmethod
    def _export_page(document: object, page_number: int) -> str:
        markdown = document.export_to_markdown(
            page_no=page_number,
            traverse_pictures=True,
        ).strip()
        if markdown:
            return markdown
        return document.export_to_text(
            page_no=page_number,
            traverse_pictures=True,
        ).strip()

    @staticmethod
    def _validate_path(path: Path) -> None:
        if not path.exists():
            raise FileNotFoundError(f"PDF 文件不存在：{path}")
        if not path.is_file():
            raise ValueError(f"输入不是文件：{path}")
        if path.suffix.lower() != ".pdf":
            raise ValueError(f"当前只接受单个 PDF 文件：{path}")
