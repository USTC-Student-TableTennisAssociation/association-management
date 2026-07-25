"""用 LangGraph 编排三条独立阅读路径与有界校验回路。"""

from __future__ import annotations

import asyncio
import json
import time
from datetime import UTC, datetime
from typing import Literal, TypedDict

from langgraph.graph import END, START, StateGraph

from cold_start.config import ExplorationSettings
from cold_start.document.models import ParsedDocument
from cold_start.global_exploration.json_output import complete_json
from cold_start.global_exploration.models import (
    ConceptSketch,
    GlobalExplorationSnapshot,
    ReconciliationReview,
    RouteStatistics,
    SourceMetadata,
)
from cold_start.global_exploration.prompts import (
    BASE_SYSTEM_PROMPT,
    concept_prompt,
    reconciliation_prompt,
    revision_prompt,
    structure_prompt,
    summary_prompt,
)
from cold_start.global_exploration.units import ReadingUnit, build_reading_units
from cold_start.llm.base import ChatModel
from cold_start.progress import NullProgressReporter, ProgressReporter

RouteName = Literal["summary", "structure", "concept"]


class ExplorationState(TypedDict, total=False):
    document: ParsedDocument
    summary_units: tuple[ReadingUnit, ...]
    structure_units: tuple[ReadingUnit, ...]
    concept_units: tuple[ReadingUnit, ...]
    summary_cursor: int
    structure_cursor: int
    concept_cursor: int
    summary_markdown: str
    structure_markdown: str
    concept_sketch: ConceptSketch
    summary_finished: bool
    structure_finished: bool
    concept_finished: bool
    review_history: list[ReconciliationReview]
    review_rounds: int
    frozen_with_unresolved_issues: bool


class GlobalExplorationRunner:
    """运行全局勘探并冻结可审计快照。"""

    def __init__(
        self,
        *,
        model: ChatModel,
        settings: ExplorationSettings | None = None,
        progress: ProgressReporter | None = None,
    ) -> None:
        self._model = model
        self._settings = settings or ExplorationSettings()
        self._progress = progress or NullProgressReporter()
        self._graph = self._build_graph()

    async def run(self, document: ParsedDocument) -> GlobalExplorationSnapshot:
        state = await self._graph.ainvoke({"document": document})
        review_history = state["review_history"]
        return GlobalExplorationSnapshot(
            created_at=datetime.now(UTC),
            source=SourceMetadata(
                path=str(document.source_path),
                title=document.title,
                sha256=document.file_sha256,
                parser=document.parser_name,
                page_count=document.page_count,
            ),
            global_summary_markdown=state["summary_markdown"],
            document_structure_markdown=state["structure_markdown"],
            concept_sketch=state["concept_sketch"],
            review_history=review_history,
            frozen_with_unresolved_issues=state["frozen_with_unresolved_issues"],
            route_statistics=RouteStatistics(
                summary_units=len(state["summary_units"]),
                structure_units=len(state["structure_units"]),
                concept_units=len(state["concept_units"]),
                review_rounds=state["review_rounds"],
            ),
        )

    def _build_graph(self):
        builder = StateGraph(ExplorationState)
        builder.add_node("plan_reading_routes", self._plan_reading_routes)
        builder.add_node("summary_read_next", self._summary_read_next)
        builder.add_node("structure_read_next", self._structure_read_next)
        builder.add_node("concept_read_next", self._concept_read_next)
        builder.add_node("summary_complete", self._summary_complete)
        builder.add_node("structure_complete", self._structure_complete)
        builder.add_node("concept_complete", self._concept_complete)
        builder.add_node("reconcile_initial_impression", self._reconcile)
        builder.add_node("targeted_reread", self._targeted_reread)
        builder.add_node("freeze_initial_snapshot", self._freeze)

        builder.add_edge(START, "plan_reading_routes")
        builder.add_edge("plan_reading_routes", "summary_read_next")
        builder.add_edge("plan_reading_routes", "structure_read_next")
        builder.add_edge("plan_reading_routes", "concept_read_next")

        builder.add_conditional_edges(
            "summary_read_next",
            self._summary_route,
            {"continue": "summary_read_next", "complete": "summary_complete"},
        )
        builder.add_conditional_edges(
            "structure_read_next",
            self._structure_route,
            {"continue": "structure_read_next", "complete": "structure_complete"},
        )
        builder.add_conditional_edges(
            "concept_read_next",
            self._concept_route,
            {"continue": "concept_read_next", "complete": "concept_complete"},
        )
        builder.add_edge(
            ["summary_complete", "structure_complete", "concept_complete"],
            "reconcile_initial_impression",
        )
        builder.add_conditional_edges(
            "reconcile_initial_impression",
            self._review_route,
            {"revise": "targeted_reread", "freeze": "freeze_initial_snapshot"},
        )
        builder.add_edge("targeted_reread", "reconcile_initial_impression")
        builder.add_edge("freeze_initial_snapshot", END)
        return builder.compile()

    def _plan_reading_routes(self, state: ExplorationState) -> ExplorationState:
        document = state["document"]
        summary_units = build_reading_units(
            document.pages,
            target_chars=self._settings.summary_unit_chars,
        )
        structure_units = build_reading_units(
            document.pages,
            target_chars=self._settings.structure_unit_chars,
            overlap_pages=self._settings.structure_overlap_pages,
        )
        concept_units = build_reading_units(
            document.pages,
            target_chars=self._settings.concept_unit_chars,
            overlap_pages=self._settings.concept_overlap_pages,
        )
        self._progress.report(
            "规划",
            (
                f"阅读路径已生成：总结 {len(summary_units)} 个单元，"
                f"结构 {len(structure_units)} 个单元，"
                f"概念 {len(concept_units)} 个单元"
            ),
        )
        return {
            "summary_units": summary_units,
            "structure_units": structure_units,
            "concept_units": concept_units,
            "summary_cursor": 0,
            "structure_cursor": 0,
            "concept_cursor": 0,
            "summary_markdown": "",
            "structure_markdown": "",
            "concept_sketch": ConceptSketch(),
            "review_history": [],
            "review_rounds": 0,
            "frozen_with_unresolved_issues": False,
        }

    async def _summary_read_next(self, state: ExplorationState) -> ExplorationState:
        cursor = state["summary_cursor"]
        unit = state["summary_units"][cursor]
        total = len(state["summary_units"])
        output = await self._complete_text(
            stage="总结",
            action=f"阅读单元 {cursor + 1}/{total}（{unit.page_label}）",
            system_prompt=BASE_SYSTEM_PROMPT,
            user_prompt=summary_prompt(
                title=state["document"].title,
                unit=unit,
                current_draft=state["summary_markdown"],
            ),
        )
        return {"summary_markdown": output.strip(), "summary_cursor": cursor + 1}

    async def _structure_read_next(self, state: ExplorationState) -> ExplorationState:
        cursor = state["structure_cursor"]
        unit = state["structure_units"][cursor]
        total = len(state["structure_units"])
        output = await self._complete_text(
            stage="结构",
            action=f"阅读单元 {cursor + 1}/{total}（{unit.page_label}）",
            system_prompt=BASE_SYSTEM_PROMPT,
            user_prompt=structure_prompt(
                title=state["document"].title,
                unit=unit,
                current_draft=state["structure_markdown"],
            ),
        )
        return {"structure_markdown": output.strip(), "structure_cursor": cursor + 1}

    async def _concept_read_next(self, state: ExplorationState) -> ExplorationState:
        cursor = state["concept_cursor"]
        unit = state["concept_units"][cursor]
        total = len(state["concept_units"])
        action = f"阅读单元 {cursor + 1}/{total}（{unit.page_label}）"
        self._progress.report("概念", f"开始{action}")
        started_at = time.perf_counter()
        output = await complete_json(
            self._model,
            schema=ConceptSketch,
            system_prompt=BASE_SYSTEM_PROMPT,
            user_prompt=concept_prompt(
                title=state["document"].title,
                unit=unit,
                current=state["concept_sketch"],
            ),
            progress=self._progress,
            progress_stage="概念",
        )
        self._progress.report(
            "概念",
            f"完成{action}，耗时 {time.perf_counter() - started_at:.1f} 秒",
        )
        return {"concept_sketch": output, "concept_cursor": cursor + 1}

    @staticmethod
    def _summary_route(state: ExplorationState) -> Literal["continue", "complete"]:
        if state["summary_cursor"] < len(state["summary_units"]):
            return "continue"
        return "complete"

    @staticmethod
    def _structure_route(state: ExplorationState) -> Literal["continue", "complete"]:
        if state["structure_cursor"] < len(state["structure_units"]):
            return "continue"
        return "complete"

    @staticmethod
    def _concept_route(state: ExplorationState) -> Literal["continue", "complete"]:
        if state["concept_cursor"] < len(state["concept_units"]):
            return "continue"
        return "complete"

    @staticmethod
    def _summary_complete(_: ExplorationState) -> ExplorationState:
        return {"summary_finished": True}

    @staticmethod
    def _structure_complete(_: ExplorationState) -> ExplorationState:
        return {"structure_finished": True}

    @staticmethod
    def _concept_complete(_: ExplorationState) -> ExplorationState:
        return {"concept_finished": True}

    async def _reconcile(self, state: ExplorationState) -> ExplorationState:
        review_round = state["review_rounds"] + 1
        action = f"第 {review_round}/{self._settings.max_review_rounds} 轮交叉校验"
        self._progress.report("校验", f"开始{action}")
        started_at = time.perf_counter()
        review = await complete_json(
            self._model,
            schema=ReconciliationReview,
            system_prompt=BASE_SYSTEM_PROMPT,
            user_prompt=reconciliation_prompt(
                title=state["document"].title,
                summary_markdown=state["summary_markdown"],
                structure_markdown=state["structure_markdown"],
                concept_sketch=state["concept_sketch"],
                source_index=self._source_index(state["document"]),
            ),
            progress=self._progress,
            progress_stage="校验",
        )
        status = (
            "接受为低权威初步印象"
            if review.accepted_as_initial_impression
            else f"发现 {len(review.issues)} 个待处理问题"
        )
        self._progress.report(
            "校验",
            f"完成{action}：{status}，耗时 {time.perf_counter() - started_at:.1f} 秒",
        )
        return {
            "review_history": [*state["review_history"], review],
            "review_rounds": review_round,
        }

    def _review_route(self, state: ExplorationState) -> Literal["revise", "freeze"]:
        latest_review = state["review_history"][-1]
        if latest_review.accepted_as_initial_impression:
            return "freeze"
        if state["review_rounds"] >= self._settings.max_review_rounds:
            return "freeze"
        if not latest_review.issues:
            return "freeze"
        return "revise"

    async def _targeted_reread(self, state: ExplorationState) -> ExplorationState:
        latest_review = state["review_history"][-1]
        requested_routes = {
            route for issue in latest_review.issues for route in issue.routes
        }
        evidence_pages = sorted(
            {page for issue in latest_review.issues for page in issue.evidence_pages}
        )
        pages_label = (
            "、".join(str(page) for page in evidence_pages)
            if evidence_pages
            else "未指定，使用文档索引"
        )
        self._progress.report(
            "回看",
            (
                f"准备修订路径：{self._route_labels(requested_routes)}；"
                f"证据页：{pages_label}"
            ),
        )
        tasks = [
            self._revise_route(route, state, latest_review)
            for route in ("summary", "structure", "concept")
            if route in requested_routes
        ]
        revisions = await asyncio.gather(*tasks)
        update: ExplorationState = {}
        for route, value in revisions:
            if route == "summary":
                update["summary_markdown"] = value
            elif route == "structure":
                update["structure_markdown"] = value
            else:
                update["concept_sketch"] = value
        return update

    async def _revise_route(
        self,
        route: RouteName,
        state: ExplorationState,
        review: ReconciliationReview,
    ) -> tuple[RouteName, str | ConceptSketch]:
        relevant_issues = [issue for issue in review.issues if route in issue.routes]
        instructions = "\n".join(
            f"- {issue.description}；指令：{issue.revision_instruction}"
            for issue in relevant_issues
        )
        evidence_pages = sorted(
            {page for issue in relevant_issues for page in issue.evidence_pages}
        )
        source_excerpt = self._source_excerpt(state["document"], evidence_pages)

        if route == "summary":
            current = state["summary_markdown"]
            output = await self._complete_text(
                stage="回看·总结",
                action=f"根据 {self._issue_pages_label(relevant_issues)} 修订",
                system_prompt=BASE_SYSTEM_PROMPT,
                user_prompt=revision_prompt(
                    route=route,
                    title=state["document"].title,
                    current_output=current,
                    issue_instructions=instructions,
                    source_excerpt=source_excerpt,
                ),
            )
            return route, output.strip()

        if route == "structure":
            current = state["structure_markdown"]
            output = await self._complete_text(
                stage="回看·结构",
                action=f"根据 {self._issue_pages_label(relevant_issues)} 修订",
                system_prompt=BASE_SYSTEM_PROMPT,
                user_prompt=revision_prompt(
                    route=route,
                    title=state["document"].title,
                    current_output=current,
                    issue_instructions=instructions,
                    source_excerpt=source_excerpt,
                ),
            )
            return route, output.strip()

        schema = json.dumps(ConceptSketch.model_json_schema(), ensure_ascii=False)
        action = f"根据 {self._issue_pages_label(relevant_issues)} 修订"
        self._progress.report("回看·概念", f"开始{action}")
        started_at = time.perf_counter()
        output = await complete_json(
            self._model,
            schema=ConceptSketch,
            system_prompt=BASE_SYSTEM_PROMPT,
            user_prompt=revision_prompt(
                route=route,
                title=state["document"].title,
                current_output=state["concept_sketch"].model_dump_json(indent=2),
                issue_instructions=instructions,
                source_excerpt=source_excerpt,
                concept_schema=schema,
            ),
            progress=self._progress,
            progress_stage="回看·概念",
        )
        self._progress.report(
            "回看·概念",
            f"完成{action}，耗时 {time.perf_counter() - started_at:.1f} 秒",
        )
        return route, output

    def _freeze(self, state: ExplorationState) -> ExplorationState:
        latest_review = state["review_history"][-1]
        unresolved = not latest_review.accepted_as_initial_impression
        if unresolved:
            self._progress.report("冻结", "达到校验上限，快照将保留未解决问题")
        else:
            self._progress.report("冻结", "初步印象已通过校验，正在冻结快照")
        return {"frozen_with_unresolved_issues": unresolved}

    @staticmethod
    def _source_index(document: ParsedDocument, max_chars: int = 18_000) -> str:
        per_page = max(120, min(500, max_chars // max(document.page_count, 1)))
        return "\n\n".join(
            f"〔第 {page.page_number} 页〕\n{page.markdown[:per_page]}"
            for page in document.pages
        )[:max_chars]

    def _source_excerpt(
        self,
        document: ParsedDocument,
        page_numbers: list[int],
    ) -> str:
        selected = (
            [page for page in document.pages if page.page_number in page_numbers]
            if page_numbers
            else list(document.pages)
        )
        body = "\n\n".join(
            f"〔第 {page.page_number} 页〕\n{page.markdown}" for page in selected
        )
        return body[: self._settings.revision_source_chars]

    async def _complete_text(
        self,
        *,
        stage: str,
        action: str,
        system_prompt: str,
        user_prompt: str,
    ) -> str:
        self._progress.report(stage, f"开始{action}")
        started_at = time.perf_counter()
        output = await self._model.complete(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            request_label=stage,
        )
        self._progress.report(
            stage,
            f"完成{action}，耗时 {time.perf_counter() - started_at:.1f} 秒",
        )
        return output

    @staticmethod
    def _route_labels(routes: set[str]) -> str:
        labels = {"summary": "总结", "structure": "结构", "concept": "概念"}
        return "、".join(labels[route] for route in sorted(routes))

    @staticmethod
    def _issue_pages_label(issues: list) -> str:
        pages = sorted({page for issue in issues for page in issue.evidence_pages})
        if not pages:
            return "文档索引"
        return f"第 {'、'.join(str(page) for page in pages)} 页"
