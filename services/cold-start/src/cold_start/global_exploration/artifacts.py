"""写入全局勘探的必要产物。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from cold_start.document.models import ParsedDocument
from cold_start.global_exploration.models import GlobalExplorationSnapshot
from cold_start.region_tree.models import RegionNode


@dataclass(frozen=True)
class ArtifactPaths:
    run_directory: Path
    snapshot_json: Path
    report_markdown: Path
    document_context_markdown: Path
    region_tree_json: Path
    region_tree_markdown: Path
    parsed_document_markdown: Path
    parsed_pages_json: Path
    parsed_blocks_json: Path


def create_exploration_run_directory(
    *,
    output_root: Path,
    document: ParsedDocument,
) -> Path:
    run_id = f"{datetime.now(UTC):%Y%m%dT%H%M%SZ}-{document.file_sha256[:10]}"
    directory = output_root.expanduser().resolve() / run_id
    directory.mkdir(parents=True, exist_ok=False)
    return directory


def write_exploration_artifacts(
    *,
    run_directory: Path,
    document: ParsedDocument,
    snapshot: GlobalExplorationSnapshot,
) -> ArtifactPaths:
    paths = ArtifactPaths(
        run_directory=run_directory,
        snapshot_json=run_directory / "global-exploration.json",
        report_markdown=run_directory / "global-exploration.md",
        document_context_markdown=run_directory / "document-context.md",
        region_tree_json=run_directory / "region-tree.json",
        region_tree_markdown=run_directory / "region-tree.md",
        parsed_document_markdown=run_directory / "parsed-document.md",
        parsed_pages_json=run_directory / "parsed-pages.json",
        parsed_blocks_json=run_directory / "parsed-blocks.json",
    )
    paths.snapshot_json.write_text(snapshot.model_dump_json(indent=2), encoding="utf-8")
    paths.report_markdown.write_text(_report(snapshot), encoding="utf-8")
    paths.document_context_markdown.write_text(
        snapshot.document_context_markdown,
        encoding="utf-8",
    )
    paths.region_tree_json.write_text(
        snapshot.region_tree.model_dump_json(indent=2),
        encoding="utf-8",
    )
    paths.region_tree_markdown.write_text(_tree(snapshot), encoding="utf-8")
    paths.parsed_document_markdown.write_text(document.markdown, encoding="utf-8")
    paths.parsed_pages_json.write_text(
        json.dumps(
            [page.model_dump() for page in document.pages],
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    paths.parsed_blocks_json.write_text(
        json.dumps(
            [block.model_dump() for block in document.blocks],
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return paths


def _report(snapshot: GlobalExplorationSnapshot) -> str:
    tree = snapshot.region_tree
    issues = "\n".join(f"- {item}" for item in tree.issues) or "无。"
    return f"""# 全局勘探结果

> 输入：{snapshot.source.title}（{snapshot.source.page_count} 页，
> {snapshot.source.block_count} 个原文块）
> 区域树状态：{tree.status}

## 文档背景

{snapshot.document_context_markdown}

## 区域树

- 节点：{len(tree.nodes)}
- 叶子：{len(tree.leaf_node_ids)}
- 模型调用：{tree.model_calls}
- 工具调用：{tree.tool_calls}

## 待人工检查

{issues}
"""


def _tree(snapshot: GlobalExplorationSnapshot) -> str:
    nodes = {node.node_id: node for node in snapshot.region_tree.nodes}
    lines = ["# 区域树", ""]

    def visit(node: RegionNode) -> None:
        prefix = "  " * node.depth
        lines.append(
            f"{prefix}- **{node.label}** (`{node.node_id}`，"
            f"`{node.start_block_id}` → `{node.end_block_id}`，{node.status})"
        )
        lines.append(f"{prefix}  {node.introduction}")
        for child_id in node.child_ids:
            visit(nodes[child_id])

    visit(nodes[snapshot.region_tree.root_node_id])
    return "\n".join(lines) + "\n"
