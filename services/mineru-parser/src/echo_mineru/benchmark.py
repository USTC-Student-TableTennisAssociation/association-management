"""对 MinerU 产物执行可审计、非阻塞的回归检查。"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


def run_benchmark(
    *,
    document: dict[str, Any],
    markdown_path: Path,
    profile_path: Path | None,
) -> dict[str, Any]:
    pages = document["pages"]
    blocks = [block for page in pages for block in page["blocks"]]
    markdown = markdown_path.read_text(encoding="utf-8")
    checks = [
        _result("pages_are_contiguous", _pages_are_contiguous(pages), "页码从 1 连续递增"),
        _result(
            "all_blocks_have_text_or_asset", _blocks_have_content(blocks), "每块具有文字或资源"
        ),
        _result("all_bboxes_are_valid", _bboxes_are_valid(blocks), "坐标为空或合法四元组"),
    ]
    profile: dict[str, Any] | None = None
    if profile_path:
        profile = json.loads(profile_path.read_text(encoding="utf-8"))
        checks.extend(_profile_checks(profile, pages, blocks, markdown))

    report = {
        "schema_version": "sydaris.mineru.benchmark.v1",
        "profile": profile.get("name") if profile else None,
        "summary": {
            "page_count": len(pages),
            "block_count": len(blocks),
            "table_block_count": sum(block["block_type"] == "table" for block in blocks),
            "image_block_count": sum(block["block_type"] in {"image", "chart"} for block in blocks),
            "passed": sum(check["status"] == "passed" for check in checks),
            "failed": sum(check["status"] == "failed" for check in checks),
        },
        "checks": checks,
    }
    return report


def write_benchmark_report(report: dict[str, Any], run_directory: Path) -> None:
    (run_directory / "benchmark-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    lines = [
        "# MinerU 解析基准",
        "",
        f"- 配置：{report['profile'] or '仅通用检查'}",
        f"- 页面：{report['summary']['page_count']}",
        f"- 内容块：{report['summary']['block_count']}",
        f"- 表格块：{report['summary']['table_block_count']}",
        f"- 图片/图表块：{report['summary']['image_block_count']}",
        f"- 通过：{report['summary']['passed']}",
        f"- 未通过：{report['summary']['failed']}",
        "",
        "## 检查明细",
        "",
    ]
    symbol = {"passed": "通过", "failed": "未通过"}
    lines.extend(
        f"- **{symbol[check['status']]}** `{check['check_id']}`：{check['detail']}"
        for check in report["checks"]
    )
    (run_directory / "benchmark-report.md").write_text(
        "\n".join(lines) + "\n",
        encoding="utf-8",
    )


def _profile_checks(
    profile: dict[str, Any],
    pages: list[dict[str, Any]],
    blocks: list[dict[str, Any]],
    markdown: str,
) -> list[dict[str, str]]:
    checks: list[dict[str, str]] = []
    page_text = {
        page["page_number"]: _normalized("\n".join(block["text"] for block in page["blocks"]))
        for page in pages
    }
    document_text = _normalized("\n".join(block["text"] for block in blocks))
    for expected in profile.get("page_contains_all", []):
        page_number = int(expected["page"])
        values = [_normalized(value) for value in expected["values"]]
        missing = [value for value in values if value not in page_text.get(page_number, "")]
        detail = (
            f"第 {page_number} 页包含全部 {len(values)} 项"
            if not missing
            else f"第 {page_number} 页缺少：{', '.join(missing)}"
        )
        checks.append(_result(expected["check_id"], not missing, detail))
    for expected in profile.get("document_order", []):
        values = [_normalized(value) for value in expected["values"]]
        positions = [document_text.find(value) for value in values]
        passed = all(position >= 0 for position in positions) and positions == sorted(positions)
        detail = "指定片段均存在且顺序正确" if passed else f"片段位置：{positions}"
        checks.append(_result(expected["check_id"], passed, detail))
    for expected in profile.get("markdown_forbidden_regex", []):
        matches = re.findall(expected["pattern"], markdown, flags=re.MULTILINE)
        detail = "未出现禁用结构" if not matches else f"命中 {len(matches)} 次：{matches[:3]}"
        checks.append(_result(expected["check_id"], not matches, detail))
    for expected in profile.get("page_has_block_types", []):
        page_number = int(expected["page"])
        actual_types = {
            block["block_type"]
            for page in pages
            if page["page_number"] == page_number
            for block in page["blocks"]
        }
        expected_types = set(expected["types"])
        missing = sorted(expected_types - actual_types)
        detail = (
            f"第 {page_number} 页包含类型：{', '.join(sorted(expected_types))}"
            if not missing
            else f"第 {page_number} 页缺少类型：{', '.join(missing)}"
        )
        checks.append(_result(expected["check_id"], not missing, detail))
    minimum_tables = profile.get("minimum_table_blocks")
    if minimum_tables is not None:
        count = sum(block["block_type"] == "table" for block in blocks)
        checks.append(
            _result(
                "minimum_table_blocks",
                count >= int(minimum_tables),
                f"表格块 {count} 个，最低期望 {minimum_tables} 个",
            )
        )
    expected_pages = profile.get("expected_page_count")
    if expected_pages is not None:
        checks.append(
            _result(
                "expected_page_count",
                len(pages) == int(expected_pages),
                f"实际 {len(pages)} 页，期望 {expected_pages} 页",
            )
        )
    return checks


def _pages_are_contiguous(pages: list[dict[str, Any]]) -> bool:
    return [page["page_number"] for page in pages] == list(range(1, len(pages) + 1))


def _blocks_have_content(blocks: list[dict[str, Any]]) -> bool:
    return all(block["text"].strip() or block["asset_path"] for block in blocks)


def _bboxes_are_valid(blocks: list[dict[str, Any]]) -> bool:
    return all(
        block["bbox"] is None
        or (
            len(block["bbox"]) == 4
            and block["bbox"][0] <= block["bbox"][2]
            and block["bbox"][1] <= block["bbox"][3]
        )
        for block in blocks
    )


def _result(check_id: str, passed: bool, detail: str) -> dict[str, str]:
    return {"check_id": check_id, "status": "passed" if passed else "failed", "detail": detail}


def _normalized(value: str) -> str:
    return re.sub(r"\s+", "", value)
