"""将全局勘探快照、局部观察和可读报告落盘。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from cold_start.document.models import ParsedDocument
from cold_start.global_exploration.models import (
    DocumentMemoryLandscape,
    ExplorationBoundaryReview,
    GlobalExplorationSnapshot,
)


@dataclass(frozen=True)
class ArtifactPaths:
    run_directory: Path
    snapshot_json: Path
    report_markdown: Path
    landscape_observations_json: Path
    parsed_document_markdown: Path
    parsed_pages_json: Path


def create_exploration_run_directory(
    *,
    output_root: Path,
    document: ParsedDocument,
) -> Path:
    """在模型调用前创建运行目录，使失败调用也能保留调试产物。"""

    started_at = datetime.now(UTC)
    run_id = f"{started_at:%Y%m%dT%H%M%SZ}-{document.file_sha256[:10]}"
    run_directory = output_root.expanduser().resolve() / run_id
    run_directory.mkdir(parents=True, exist_ok=False)
    return run_directory


def write_exploration_artifacts(
    *,
    run_directory: Path,
    document: ParsedDocument,
    snapshot: GlobalExplorationSnapshot,
) -> ArtifactPaths:
    """在已创建的运行目录中写入解析结果与勘探快照。"""

    snapshot_json = run_directory / "global-exploration.json"
    report_markdown = run_directory / "global-exploration.md"
    landscape_observations_json = run_directory / "landscape-observations.json"
    parsed_document_markdown = run_directory / "parsed-document.md"
    parsed_pages_json = run_directory / "parsed-pages.json"

    snapshot_json.write_text(
        snapshot.model_dump_json(indent=2),
        encoding="utf-8",
    )
    report_markdown.write_text(
        _render_report(snapshot),
        encoding="utf-8",
    )
    landscape_observations_json.write_text(
        json.dumps(
            [
                observation.model_dump()
                for observation in snapshot.landscape_observations
            ],
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    parsed_document_markdown.write_text(
        document.markdown,
        encoding="utf-8",
    )
    parsed_pages_json.write_text(
        json.dumps(
            [page.model_dump() for page in document.pages],
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    return ArtifactPaths(
        run_directory=run_directory,
        snapshot_json=snapshot_json,
        report_markdown=report_markdown,
        landscape_observations_json=landscape_observations_json,
        parsed_document_markdown=parsed_document_markdown,
        parsed_pages_json=parsed_pages_json,
    )


def _render_report(snapshot: GlobalExplorationSnapshot) -> str:
    blocking_label = "是" if snapshot.frozen_with_boundary_issues else "否"
    return f"""# 全局勘探阅读地图

> 权威级别：低权威初步观察
> 输入：{snapshot.source.title}（{snapshot.source.page_count} 页）
> SHA-256：`{snapshot.source.sha256}`
> 冻结时仍有全局勘探边界问题：{blocking_label}

## 文档全局画像

{snapshot.document_profile_markdown}

## 文档结构导航

{snapshot.document_structure_markdown}

## 文档记忆地形

{_render_memory_landscape(snapshot.document_memory_landscape)}

## 全局勘探边界校验

{_render_review_history(snapshot.review_history)}
"""


def _render_memory_landscape(landscape: DocumentMemoryLandscape) -> str:
    lines = [landscape.scope_note]

    lines.extend(["", "### 记忆区域", ""])
    if landscape.memory_areas:
        lines.extend(
            f"- **{area.label}**：{area.coverage}{_pages(area.source_pages)}"
            for area in landscape.memory_areas
        )
    else:
        lines.append("- 暂无。")

    lines.extend(["", "### 全局信号", ""])
    if landscape.global_signals:
        for signal in landscape.global_signals:
            basis = "、".join(signal.basis)
            lines.append(
                f"- **{signal.label}**：{signal.context}；依据：{basis}"
                f"{_pages(signal.source_pages)}"
            )
    else:
        lines.append("- 暂无。")

    lines.extend(["", "### 原文明示的文档关系", ""])
    if landscape.explicit_relations:
        lines.extend(
            f"- **{relation.source_area} → {relation.target_area}**："
            f"{relation.observation}{_pages(relation.source_pages)}"
            for relation in landscape.explicit_relations
        )
    else:
        lines.append("- 暂无。")

    return "\n".join(lines)


def _render_review_history(history: list[ExplorationBoundaryReview]) -> str:
    blocks: list[str] = []
    for index, review in enumerate(history, start=1):
        status = (
            "可以冻结"
            if review.acceptable_as_global_exploration
            else "需要回看"
        )
        lines = [f"### 第 {index} 轮：{status}", "", review.overall_assessment]
        if review.issues:
            lines.extend(["", "问题：", ""])
            lines.extend(
                f"- [{issue.severity}] {issue.description}；"
                f"回看产物：{', '.join(issue.routes)}；"
                f"指令：{issue.revision_instruction}{_pages(issue.evidence_pages)}"
                for issue in review.issues
            )
        if review.non_blocking_notes:
            lines.extend(["", "非阻碍性说明：", ""])
            lines.extend(f"- {note}" for note in review.non_blocking_notes)
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def _pages(page_numbers: list[int]) -> str:
    if not page_numbers:
        return ""
    return f"〔第 {', '.join(str(page) for page in page_numbers)} 页〕"
