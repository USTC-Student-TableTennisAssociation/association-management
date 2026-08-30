import json
from pathlib import Path

from sydaris_mineru.adapter import normalize_mineru_output


def test_normalizes_stable_content_list(tmp_path: Path) -> None:
    source = tmp_path / "手册.pdf"
    source.write_bytes(b"pdf")
    raw = tmp_path / "run" / "mineru-raw" / "手册" / "hybrid"
    raw.mkdir(parents=True)
    (raw / "手册.md").write_text("# 标题\n\n![图](images/example.png)", encoding="utf-8")
    (raw / "手册_content_list.json").write_text(
        json.dumps(
            [
                {
                    "type": "text",
                    "text": "标题",
                    "text_level": 1,
                    "bbox": [1, 2, 3, 4],
                    "page_idx": 0,
                },
                {
                    "type": "image",
                    "img_path": "images/example.png",
                    "bbox": [4, 5, 6, 7],
                    "page_idx": 1,
                },
                {
                    "type": "table",
                    "table_caption": ["名单"],
                    "table_body": "<table></table>",
                    "bbox": [1, 1, 9, 9],
                    "page_idx": 1,
                },
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    document = normalize_mineru_output(
        source_pdf=source,
        raw_directory=tmp_path / "run" / "mineru-raw",
        run_directory=tmp_path / "run",
        mineru_version="3.4.4",
        backend="hybrid-engine",
        effort="medium",
        method="auto",
    )

    assert document["source"]["page_count"] == 2
    assert document["pages"][0]["blocks"][0]["heading_level"] == 1
    assert document["pages"][1]["blocks"][0]["asset_path"].endswith(
        "手册/hybrid/images/example.png"
    )
    assert document["pages"][1]["blocks"][1]["block_type"] == "table"
    parsed_markdown = (tmp_path / "run" / "parsed-document.md").read_text(encoding="utf-8")
    assert "mineru-raw/手册/hybrid/images/example.png" in parsed_markdown
    assert (tmp_path / "run" / "sydaris-document.json").is_file()
