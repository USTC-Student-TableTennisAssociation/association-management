"""将全局勘探快照和可读报告落盘。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from cold_start.document.models import ParsedDocument
from cold_start.global_exploration.models import (
    ConceptSketch,
    GlobalExplorationSnapshot,
    ReconciliationReview,
)


@dataclass(frozen=True)
class ArtifactPaths:
    run_directory: Path
    snapshot_json: Path
    report_markdown: Path
    parsed_document_markdown: Path
    parsed_pages_json: Path


def write_exploration_artifacts(
    *,
    output_root: Path,
    document: ParsedDocument,
    snapshot: GlobalExplorationSnapshot,
) -> ArtifactPaths:
    """创建一次不可覆盖的运行目录，保留输入解析结果与勘探快照。"""

    run_id = f"{snapshot.created_at:%Y%m%dT%H%M%SZ}-{document.file_sha256[:10]}"
    run_directory = output_root.expanduser().resolve() / run_id
    run_directory.mkdir(parents=True, exist_ok=False)

    snapshot_json = run_directory / "global-exploration.json"
    report_markdown = run_directory / "global-exploration.md"
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
        parsed_document_markdown=parsed_document_markdown,
        parsed_pages_json=parsed_pages_json,
    )


def _render_report(snapshot: GlobalExplorationSnapshot) -> str:
    unresolved_label = "是" if snapshot.frozen_with_unresolved_issues else "否"
    return f"""# 全局勘探初步快照

> 权威级别：低权威初步印象  
> 输入：{snapshot.source.title}（{snapshot.source.page_count} 页）  
> SHA-256：`{snapshot.source.sha256}`  
> 带未解决问题冻结：{unresolved_label}

## 全局总结

{snapshot.global_summary_markdown}

## 文档结构说明

{snapshot.document_structure_markdown}

## 全局信号与候选概念

{_render_concept_sketch(snapshot.concept_sketch)}

## 交叉校验

{_render_review_history(snapshot.review_history)}
"""


def _render_concept_sketch(sketch: ConceptSketch) -> str:
    lines = [sketch.document_level_observation or "暂无文档级观察。"]
    lines.extend(["", "### 全局信号", ""])
    if sketch.global_signals:
        for signal in sketch.global_signals:
            pages = _pages(signal.source_pages)
            lines.append(
                f"- **{signal.label}**（{signal.importance}，出现 {signal.occurrence_count} 次）："
                f"{signal.observation}；重要性理由：{signal.importance_reason}{pages}"
            )
    else:
        lines.append("- 暂无。")

    lines.extend(["", "### 候选概念", ""])
    if sketch.candidate_concepts:
        for concept in sketch.candidate_concepts:
            pages = _pages(concept.source_pages)
            aliases = f"；别名：{'、'.join(concept.aliases)}" if concept.aliases else ""
            lines.append(
                f"- **{concept.label}**（{concept.importance}）："
                f"{concept.initial_understanding}；重要性理由：{concept.importance_reason}"
                f"{aliases}{pages}"
            )
    else:
        lines.append("- 暂无。")

    lines.extend(["", "### 粗关系", ""])
    if sketch.coarse_relations:
        for relation in sketch.coarse_relations:
            lines.append(
                f"- **{relation.source} → {relation.target}**：{relation.relation}；"
                f"{relation.rationale}{_pages(relation.source_pages)}"
            )
    else:
        lines.append("- 暂无。")

    lines.extend(["", "### 开放问题", ""])
    lines.extend(f"- {question}" for question in sketch.open_questions)
    if not sketch.open_questions:
        lines.append("- 暂无。")
    return "\n".join(lines)


def _render_review_history(history: list[ReconciliationReview]) -> str:
    blocks: list[str] = []
    for index, review in enumerate(history, start=1):
        status = "可作为初步印象冻结" if review.accepted_as_initial_impression else "需要回看"
        lines = [f"### 第 {index} 轮：{status}", "", review.overall_assessment]
        if review.issues:
            lines.extend(["", "问题：", ""])
            lines.extend(
                f"- [{issue.severity}] {issue.description}；"
                f"回看路径：{', '.join(issue.routes)}；"
                f"指令：{issue.revision_instruction}{_pages(issue.evidence_pages)}"
                for issue in review.issues
            )
        if review.unresolved_uncertainties:
            lines.extend(["", "保留的不确定性：", ""])
            lines.extend(
                f"- {uncertainty}" for uncertainty in review.unresolved_uncertainties
            )
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def _pages(page_numbers: list[int]) -> str:
    if not page_numbers:
        return ""
    return f"〔第 {', '.join(str(page) for page in page_numbers)} 页〕"
