import json
from pathlib import Path

from sydaris_mineru.benchmark import run_benchmark


def test_profile_reports_order_and_forbidden_heading(tmp_path: Path) -> None:
    markdown = tmp_path / "parsed-document.md"
    markdown.write_text("# 标题\n\n甲乙丙", encoding="utf-8")
    profile = tmp_path / "profile.json"
    profile.write_text(
        json.dumps(
            {
                "name": "示例",
                "expected_page_count": 1,
                "minimum_table_blocks": 0,
                "page_contains_all": [{"check_id": "page", "page": 1, "values": ["甲"]}],
                "document_order": [{"check_id": "order", "values": ["甲", "乙", "丙"]}],
                "markdown_forbidden_regex": [{"check_id": "heading", "pattern": "^## QQ$"}],
                "page_has_block_types": [{"check_id": "types", "page": 1, "types": ["text"]}],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    document = {
        "pages": [
            {
                "page_number": 1,
                "blocks": [
                    {
                        "block_type": "text",
                        "text": "甲乙丙",
                        "asset_path": None,
                        "bbox": [0, 0, 1, 1],
                    }
                ],
            }
        ]
    }

    report = run_benchmark(document=document, markdown_path=markdown, profile_path=profile)

    assert report["summary"]["failed"] == 0
    assert report["summary"]["passed"] == 9
