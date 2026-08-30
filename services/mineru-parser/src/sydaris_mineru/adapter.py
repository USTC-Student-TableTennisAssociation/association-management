"""把 MinerU 稳定内容列表转换为 Sydaris 可检查的薄中间表示。"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from pathlib import Path
from typing import Any


def normalize_mineru_output(
    *,
    source_pdf: Path,
    raw_directory: Path,
    run_directory: Path,
    mineru_version: str,
    backend: str,
    effort: str,
    method: str,
) -> dict[str, Any]:
    """保留 MinerU 原始产物，并生成不依赖开发版 v2 Schema 的 Sydaris 文档。"""

    content_list_path = _find_one(raw_directory, "*_content_list.json")
    markdown_path = _find_markdown(raw_directory, source_pdf.stem)
    raw_items = json.loads(content_list_path.read_text(encoding="utf-8"))
    if not isinstance(raw_items, list):
        raise ValueError(f"MinerU content_list 顶层必须是数组：{content_list_path}")

    blocks: list[dict[str, Any]] = []
    page_counts: Counter[int] = Counter()
    for order, item in enumerate(raw_items):
        if not isinstance(item, dict):
            raise ValueError(f"MinerU content_list 第 {order + 1} 项不是对象")
        page_index = item.get("page_idx")
        if not isinstance(page_index, int) or page_index < 0:
            raise ValueError(f"MinerU content_list 第 {order + 1} 项缺少有效 page_idx")
        page_number = page_index + 1
        page_counts[page_number] += 1
        blocks.append(
            {
                "block_id": f"p{page_number:04d}-b{page_counts[page_number]:04d}",
                "order": order,
                "page_number": page_number,
                "block_type": str(item.get("type") or "unknown"),
                "sub_type": item.get("sub_type"),
                "heading_level": _heading_level(item),
                "bbox": _bbox(item.get("bbox"), order),
                "text": _block_text(item),
                "asset_path": _asset_path(
                    item,
                    content_list_directory=content_list_path.parent,
                    run_directory=run_directory,
                ),
            }
        )

    if not blocks:
        raise ValueError("MinerU content_list 没有可用内容块")

    page_numbers = sorted(page_counts)
    pages = [
        {
            "page_number": page_number,
            "blocks": [block for block in blocks if block["page_number"] == page_number],
        }
        for page_number in page_numbers
    ]
    copied_markdown = run_directory / "parsed-document.md"
    copied_markdown.write_text(
        _rewrite_markdown_assets(
            markdown_path.read_text(encoding="utf-8"),
            source_directory=markdown_path.parent,
            run_directory=run_directory,
        ),
        encoding="utf-8",
    )

    document = {
        "schema_version": "sydaris.mineru.document.v1",
        "source": {
            "path": str(source_pdf.resolve()),
            "title": source_pdf.stem,
            "sha256": hashlib.sha256(source_pdf.read_bytes()).hexdigest(),
            "page_count": max(page_numbers),
        },
        "parser": {
            "name": "mineru",
            "version": mineru_version,
            "backend": backend,
            "effort": effort,
            "method": method,
            "content_list": str(content_list_path.relative_to(run_directory)),
            "markdown": str(markdown_path.relative_to(run_directory)),
        },
        "pages": pages,
    }
    (run_directory / "sydaris-document.json").write_text(
        json.dumps(document, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return document


def _find_one(directory: Path, pattern: str) -> Path:
    candidates = sorted(
        path for path in directory.rglob(pattern) if not path.name.endswith("_content_list_v2.json")
    )
    if len(candidates) != 1:
        rendered = ", ".join(str(path) for path in candidates) or "无"
        raise ValueError(f"预期恰好一个 {pattern}，实际为：{rendered}")
    return candidates[0]


def _find_markdown(directory: Path, source_stem: str) -> Path:
    candidates = sorted(directory.rglob("*.md"))
    exact = [path for path in candidates if path.stem == source_stem]
    if len(exact) == 1:
        return exact[0]
    if len(candidates) == 1:
        return candidates[0]
    if candidates:
        return max(candidates, key=lambda path: path.stat().st_size)
    raise ValueError("MinerU 没有生成 Markdown 主文件")


def _heading_level(item: dict[str, Any]) -> int | None:
    if item.get("type") != "text":
        return None
    value = item.get("text_level")
    return value if isinstance(value, int) and value > 0 else None


def _bbox(value: Any, order: int) -> list[float] | None:
    if value is None:
        return None
    if not isinstance(value, list) or len(value) != 4:
        raise ValueError(f"MinerU content_list 第 {order + 1} 项 bbox 不是四元数组")
    if not all(isinstance(number, int | float) for number in value):
        raise ValueError(f"MinerU content_list 第 {order + 1} 项 bbox 含非数值")
    resolved = [float(number) for number in value]
    if not all(0 <= number <= 1000 for number in resolved):
        raise ValueError(f"MinerU content_list 第 {order + 1} 项 bbox 超出 0–1000")
    return resolved


def _block_text(item: dict[str, Any]) -> str:
    block_type = item.get("type")
    if block_type in {
        "text",
        "equation",
        "header",
        "footer",
        "page_number",
        "aside_text",
        "page_footnote",
    }:
        return str(item.get("text") or "").strip()
    if block_type == "list":
        return "\n".join(str(value).strip() for value in item.get("list_items", []) if value)
    if block_type == "table":
        return _join_fields(item, "table_caption", "table_body", "table_footnote")
    if block_type in {"image", "chart"}:
        return _join_fields(
            item,
            f"{block_type}_caption",
            "content",
            f"{block_type}_footnote",
        )
    if block_type == "code":
        return _join_fields(item, "code_caption", "code_body", "code_footnote")
    return str(item.get("text") or item.get("content") or "").strip()


def _join_fields(item: dict[str, Any], *names: str) -> str:
    values: list[str] = []
    for name in names:
        value = item.get(name)
        if isinstance(value, list):
            values.extend(str(part).strip() for part in value if part)
        elif value:
            values.append(str(value).strip())
    return "\n\n".join(value for value in values if value)


def _asset_path(
    item: dict[str, Any],
    *,
    content_list_directory: Path,
    run_directory: Path,
) -> str | None:
    value = item.get("img_path")
    if not value:
        return None
    path = Path(str(value))
    if path.is_absolute():
        return str(path)
    return str((content_list_directory / path).resolve().relative_to(run_directory))


def _rewrite_markdown_assets(
    markdown: str,
    *,
    source_directory: Path,
    run_directory: Path,
) -> str:
    """让根目录下的便读副本仍能打开 raw 目录中的图片。"""

    import re

    relative_source = source_directory.resolve().relative_to(run_directory)

    def replace(match: re.Match[str]) -> str:
        target = match.group("target")
        if target.startswith(("http://", "https://", "data:", "/", "#")):
            return match.group(0)
        rewritten = (relative_source / target).as_posix()
        return f"{match.group('prefix')}{rewritten}{match.group('suffix')}"

    return re.sub(
        r"(?P<prefix>!\[[^\]]*\]\()(?P<target>[^)]+)(?P<suffix>\))",
        replace,
        markdown,
    )
