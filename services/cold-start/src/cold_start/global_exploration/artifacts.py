"""写入全局勘探的必要产物。"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from cold_start.document.models import ParsedBlock, ParsedDocument
from cold_start.global_exploration.models import GlobalExplorationSnapshot
from cold_start.region_tree.models import RegionNode


@dataclass(frozen=True)
class ArtifactPaths:
    run_directory: Path
    snapshot_json: Path
    report_markdown: Path
    document_context_markdown: Path
    region_tree_json: Path
    region_tree_checks_json: Path
    region_tree_markdown: Path
    parsed_document_markdown: Path
    parsed_pages_json: Path
    parsed_blocks_json: Path
    mineru_raw_directory: Path
    mineru_log: Path


def create_exploration_run_directory(
    *,
    output_root: Path,
    source_path: Path,
) -> Path:
    source = source_path.expanduser().resolve()
    file_sha256 = hashlib.sha256(source.read_bytes()).hexdigest()
    run_id = f"{datetime.now(UTC):%Y%m%dT%H%M%SZ}-{file_sha256[:10]}"
    directory = output_root.expanduser().resolve() / run_id
    directory.mkdir(parents=True, exist_ok=False)
    return directory


def _artifact_paths(run_directory: Path) -> ArtifactPaths:
    return ArtifactPaths(
        run_directory=run_directory,
        snapshot_json=run_directory / "global-exploration.json",
        report_markdown=run_directory / "global-exploration.md",
        document_context_markdown=run_directory / "document-context.md",
        region_tree_json=run_directory / "region-tree.json",
        region_tree_checks_json=run_directory / "region-tree-checks.json",
        region_tree_markdown=run_directory / "region-tree.md",
        parsed_document_markdown=run_directory / "parsed-document.md",
        parsed_pages_json=run_directory / "parsed-pages.json",
        parsed_blocks_json=run_directory / "parsed-blocks.json",
        mineru_raw_directory=run_directory / "mineru-raw",
        mineru_log=run_directory / "mineru.log",
    )


def write_parsing_artifacts(
    *,
    run_directory: Path,
    document: ParsedDocument,
) -> ArtifactPaths:
    paths = _artifact_paths(run_directory)
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


def write_exploration_artifacts(
    *,
    run_directory: Path,
    document: ParsedDocument,
    snapshot: GlobalExplorationSnapshot,
) -> ArtifactPaths:
    paths = write_parsing_artifacts(
        run_directory=run_directory,
        document=document,
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
    paths.region_tree_checks_json.write_text(
        json.dumps(
            {
                "structure_check": snapshot.region_tree.structure_check.model_dump(),
                "source_issues": [
                    issue.model_dump() for issue in snapshot.region_tree.source_issues
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    paths.region_tree_markdown.write_text(_tree(snapshot), encoding="utf-8")
    return paths


def load_exploration_inputs(
    run_directory: Path,
) -> tuple[GlobalExplorationSnapshot, tuple[ParsedBlock, ...]]:
    directory = run_directory.expanduser().resolve()
    paths = _artifact_paths(directory)
    if not paths.snapshot_json.is_file() or not paths.parsed_blocks_json.is_file():
        raise ValueError("运行目录缺少 global-exploration.json 或 parsed-blocks.json")
    exploration = GlobalExplorationSnapshot.model_validate_json(
        paths.snapshot_json.read_text(encoding="utf-8")
    )
    raw_blocks = json.loads(paths.parsed_blocks_json.read_text(encoding="utf-8"))
    blocks = tuple(ParsedBlock.model_validate(item) for item in raw_blocks)
    if len(blocks) != exploration.source.block_count:
        raise ValueError("parsed-blocks.json 与全局勘探快照的块数量不一致")
    return exploration, blocks


def _report(snapshot: GlobalExplorationSnapshot) -> str:
    tree = snapshot.region_tree
    issues = "\n".join(f"- {item}" for item in tree.issues) or "无。"
    source_issues = (
        "\n".join(
            f"- `{', '.join(item.block_ids)}`：{item.reason}"
            for item in tree.source_issues
        )
        or "无。"
    )
    return f"""# 全局勘探结果

> 输入：{snapshot.source.title}（{snapshot.source.page_count} 页，
> {snapshot.source.block_count} 个原文块）
> 区域树状态：{tree.status}

## 文档背景

{snapshot.document_context_markdown}

## 区域树

- 节点：{len(tree.nodes)}
- 叶子：{len(tree.leaf_node_ids)}
- 含自有内容的节点：{len(tree.content_node_ids)}
- 仅含结构原文的节点：{len(tree.structural_context_node_ids)}
- 初次结构问题：{len(tree.structure_check.initial_issues)}
- 未解决结构问题：{len(tree.structure_check.remaining_issues)}
- 来源解析警告：{len(tree.source_issues)}
- 模型调用：{tree.model_calls}
- 工具调用：{tree.tool_calls}

## 来源解析警告

{source_issues}

## 待人工检查

{issues}
"""


def _tree(snapshot: GlobalExplorationSnapshot) -> str:
    nodes = {node.node_id: node for node in snapshot.region_tree.nodes}
    lines = ["# 区域树", ""]

    def visit(node: RegionNode) -> None:
        prefix = "  " * node.depth
        role = (
            f"，自有原文={node.owned_source_role}"
            if node.owned_source_role
            else ""
        )
        lines.append(
            f"{prefix}- **{node.label}** (`{node.node_id}`，"
            f"`{node.start_block_id}` → `{node.end_block_id}`，{node.status}{role})"
        )
        lines.append(f"{prefix}  {node.introduction}")
        if node.owned_segments:
            ranges = "、".join(
                f"`{item.start_block_id}` → `{item.end_block_id}`"
                for item in node.owned_segments
            )
            lines.append(f"{prefix}  自有范围：{ranges}")
        for child_id in node.child_ids:
            visit(nodes[child_id])

    visit(nodes[snapshot.region_tree.root_node_id])
    return "\n".join(lines) + "\n"
