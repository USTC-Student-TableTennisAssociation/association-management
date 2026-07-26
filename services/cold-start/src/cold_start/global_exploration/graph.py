"""用 LangGraph 编排文档级全局勘探。"""

from __future__ import annotations

import asyncio
import json
import time
from datetime import UTC, datetime
from typing import TypedDict

from langgraph.graph import END, START, StateGraph

from cold_start.config import ExplorationSettings
from cold_start.document.models import ParsedDocument
from cold_start.global_exploration.json_output import complete_json
from cold_start.global_exploration.models import (
    DocumentMemoryLandscape,
    ExplorationBoundaryReview,
    GlobalExplorationSnapshot,
    LandscapeObservationBatch,
    RouteName,
    RouteStatistics,
    SourceMetadata,
)
from cold_start.global_exploration.prompts import (
    BASE_SYSTEM_PROMPT,
    landscape_merge_prompt,
    landscape_observation_prompt,
    profile_prompt,
    reconciliation_prompt,
    revision_prompt,
    structure_prompt,
)
from cold_start.global_exploration.units import (
    ReadingUnit,
    build_reading_units,
    build_structure_scan_unit,
)
from cold_start.llm.base import ChatModel
from cold_start.progress import NullProgressReporter, ProgressReporter


class ExplorationState(TypedDict, total=False):
    document: ParsedDocument
    profile_units: tuple[ReadingUnit, ...]
    structure_scan_unit: ReadingUnit
    landscape_units: tuple[ReadingUnit, ...]
    profile_markdown: str
    structure_markdown: str
    landscape_observations: tuple[LandscapeObservationBatch, ...]
    memory_landscape: DocumentMemoryLandscape
    review_history: list[ExplorationBoundaryReview]
    review_rounds: int
    frozen_with_boundary_issues: bool


class GlobalExplorationRunner:
    """运行全局勘探并冻结低权威文档级阅读地图。"""

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
        return GlobalExplorationSnapshot(
            created_at=datetime.now(UTC),
            source=SourceMetadata(
                path=str(document.source_path),
                title=document.title,
                sha256=document.file_sha256,
                parser=document.parser_name,
                page_count=document.page_count,
            ),
            document_profile_markdown=state["profile_markdown"],
            document_structure_markdown=state["structure_markdown"],
            document_memory_landscape=state["memory_landscape"],
            review_history=state["review_history"],
            frozen_with_boundary_issues=state["frozen_with_boundary_issues"],
            route_statistics=RouteStatistics(
                profile_units=len(state["profile_units"]),
                structure_scans=1,
                landscape_units=len(state["landscape_units"]),
                landscape_merge_calls=1,
                review_rounds=state["review_rounds"],
            ),
            landscape_observations=state["landscape_observations"],
        )

    def _build_graph(self):
        builder = StateGraph(ExplorationState)
        builder.add_node("plan_exploration", self._plan_exploration)
        builder.add_node("scan_document_structure", self._scan_document_structure)
        builder.add_node("build_document_profile", self._build_document_profile)
        builder.add_node("build_memory_landscape", self._build_memory_landscape)
        builder.add_node("review_exploration_boundary", self._review_boundary)
        builder.add_node("targeted_reread", self._targeted_reread)
        builder.add_node("freeze_exploration_snapshot", self._freeze)

        builder.add_edge(START, "plan_exploration")
        builder.add_edge("plan_exploration", "scan_document_structure")
        builder.add_edge("scan_document_structure", "build_document_profile")
        builder.add_edge("scan_document_structure", "build_memory_landscape")
        builder.add_edge(
            ["build_document_profile", "build_memory_landscape"],
            "review_exploration_boundary",
        )
        builder.add_conditional_edges(
            "review_exploration_boundary",
            self._review_route,
            {"revise": "targeted_reread", "freeze": "freeze_exploration_snapshot"},
        )
        builder.add_edge("targeted_reread", "review_exploration_boundary")
        builder.add_edge("freeze_exploration_snapshot", END)
        return builder.compile()

    def _plan_exploration(self, state: ExplorationState) -> ExplorationState:
        document = state["document"]
        profile_units = build_reading_units(
            document.pages,
            target_chars=self._settings.profile_unit_chars,
        )
        structure_scan_unit = build_structure_scan_unit(
            document.pages,
            preview_chars_per_page=self._settings.structure_preview_chars_per_page,
        )
        landscape_units = build_reading_units(
            document.pages,
            target_chars=self._settings.landscape_unit_chars,
            overlap_pages=self._settings.landscape_overlap_pages,
        )
        self._progress.report(
            "规划",
            (
                f"勘探路径已生成：画像 {len(profile_units)} 个单元，"
                "结构 1 次快速扫描，"
                f"地形观察 {len(landscape_units)} 个单元，"
                f"最多并发 {self._settings.landscape_parallelism} 个"
            ),
        )
        return {
            "profile_units": profile_units,
            "structure_scan_unit": structure_scan_unit,
            "landscape_units": landscape_units,
            "profile_markdown": "",
            "structure_markdown": "",
            "landscape_observations": (),
            "review_history": [],
            "review_rounds": 0,
            "frozen_with_boundary_issues": False,
        }

    async def _scan_document_structure(
        self,
        state: ExplorationState,
    ) -> ExplorationState:
        output = await self._complete_text(
            stage="结构",
            action="快速扫描目录、标题与逐页短预览",
            system_prompt=BASE_SYSTEM_PROMPT,
            user_prompt=structure_prompt(
                title=state["document"].title,
                unit=state["structure_scan_unit"],
            ),
        )
        return {"structure_markdown": output.strip()}

    async def _build_document_profile(
        self,
        state: ExplorationState,
    ) -> ExplorationState:
        draft = ""
        units = state["profile_units"]
        for cursor, unit in enumerate(units):
            draft = (
                await self._complete_text(
                    stage="画像",
                    action=(
                        f"浏览单元 {cursor + 1}/{len(units)}"
                        f"（{unit.page_label}）"
                    ),
                    system_prompt=BASE_SYSTEM_PROMPT,
                    user_prompt=profile_prompt(
                        title=state["document"].title,
                        unit=unit,
                        current_draft=draft,
                        structure_markdown=state["structure_markdown"],
                    ),
                )
            ).strip()
        return {"profile_markdown": draft}

    async def _build_memory_landscape(
        self,
        state: ExplorationState,
    ) -> ExplorationState:
        units = state["landscape_units"]
        semaphore = asyncio.Semaphore(self._settings.landscape_parallelism)

        async def observe(
            cursor: int,
            unit: ReadingUnit,
        ) -> LandscapeObservationBatch:
            async with semaphore:
                return await self._observe_landscape_unit(
                    title=state["document"].title,
                    structure_markdown=state["structure_markdown"],
                    unit=unit,
                    cursor=cursor,
                    total=len(units),
                )

        observations = tuple(
            await asyncio.gather(
                *(observe(cursor, unit) for cursor, unit in enumerate(units))
            )
        )
        self._progress.report(
            "地形合并",
            f"开始合并 {len(observations)} 份区域观察并执行去重压缩",
        )
        started_at = time.perf_counter()
        memory_landscape = await complete_json(
            self._model,
            schema=DocumentMemoryLandscape,
            system_prompt=BASE_SYSTEM_PROMPT,
            user_prompt=landscape_merge_prompt(
                title=state["document"].title,
                observations=observations,
                structure_markdown=state["structure_markdown"],
            ),
            progress=self._progress,
            progress_stage="地形合并",
        )
        self._progress.report(
            "地形合并",
            (
                f"完成文档记忆地形，耗时 "
                f"{time.perf_counter() - started_at:.1f} 秒"
            ),
        )
        return {
            "landscape_observations": observations,
            "memory_landscape": memory_landscape,
        }

    async def _observe_landscape_unit(
        self,
        *,
        title: str,
        structure_markdown: str,
        unit: ReadingUnit,
        cursor: int,
        total: int,
    ) -> LandscapeObservationBatch:
        stage = f"地形勘探·{cursor + 1}/{total}"
        self._progress.report(stage, f"开始浏览{unit.page_label}")
        started_at = time.perf_counter()
        observation = await complete_json(
            self._model,
            schema=LandscapeObservationBatch,
            system_prompt=BASE_SYSTEM_PROMPT,
            user_prompt=landscape_observation_prompt(
                title=title,
                unit=unit,
                structure_markdown=structure_markdown,
            ),
            progress=self._progress,
            progress_stage=stage,
        )
        observation = observation.model_copy(
            update={"unit_pages": list(unit.page_numbers)}
        )
        self._progress.report(
            stage,
            f"完成区域观察，耗时 {time.perf_counter() - started_at:.1f} 秒",
        )
        return observation

    async def _review_boundary(
        self,
        state: ExplorationState,
    ) -> ExplorationState:
        review_round = state["review_rounds"] + 1
        action = f"第 {review_round}/{self._settings.max_review_rounds} 轮边界校验"
        self._progress.report("校验", f"开始{action}")
        started_at = time.perf_counter()
        review = await complete_json(
            self._model,
            schema=ExplorationBoundaryReview,
            system_prompt=BASE_SYSTEM_PROMPT,
            user_prompt=reconciliation_prompt(
                title=state["document"].title,
                profile_markdown=state["profile_markdown"],
                structure_markdown=state["structure_markdown"],
                memory_landscape=state["memory_landscape"],
                source_evidence=self._source_evidence(state["document"]),
            ),
            progress=self._progress,
            progress_stage="校验",
        )
        status = (
            "可以冻结为全局阅读地图"
            if review.acceptable_as_global_exploration
            else f"发现 {len(review.issues)} 个需要回看的问题"
        )
        self._progress.report(
            "校验",
            f"完成{action}：{status}，耗时 {time.perf_counter() - started_at:.1f} 秒",
        )
        return {
            "review_history": [*state["review_history"], review],
            "review_rounds": review_round,
        }

    def _review_route(self, state: ExplorationState) -> str:
        latest_review = state["review_history"][-1]
        if latest_review.acceptable_as_global_exploration:
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
            else "未指定，使用完整证据范围"
        )
        self._progress.report(
            "回看",
            (
                f"准备修订产物：{self._route_labels(requested_routes)}；"
                f"证据页：{pages_label}"
            ),
        )
        revisions = await asyncio.gather(
            *(
                self._revise_route(route, state, latest_review)
                for route in ("profile", "structure", "landscape")
                if route in requested_routes
            )
        )
        update: ExplorationState = {}
        for route, value in revisions:
            if route == "profile":
                update["profile_markdown"] = value
            elif route == "structure":
                update["structure_markdown"] = value
            else:
                update["memory_landscape"] = value
        return update

    async def _revise_route(
        self,
        route: RouteName,
        state: ExplorationState,
        review: ExplorationBoundaryReview,
    ) -> tuple[RouteName, str | DocumentMemoryLandscape]:
        relevant_issues = [issue for issue in review.issues if route in issue.routes]
        instructions = "\n".join(
            f"- {issue.description}；指令：{issue.revision_instruction}"
            for issue in relevant_issues
        )
        evidence_pages = sorted(
            {page for issue in relevant_issues for page in issue.evidence_pages}
        )
        source_excerpt = self._source_excerpt(state["document"], evidence_pages)

        if route in {"profile", "structure"}:
            current = (
                state["profile_markdown"]
                if route == "profile"
                else state["structure_markdown"]
            )
            label = "画像" if route == "profile" else "结构"
            output = await self._complete_text(
                stage=f"回看·{label}",
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

        schema = json.dumps(
            DocumentMemoryLandscape.model_json_schema(),
            ensure_ascii=False,
        )
        action = f"根据 {self._issue_pages_label(relevant_issues)} 修订"
        self._progress.report("回看·地形", f"开始{action}")
        started_at = time.perf_counter()
        output = await complete_json(
            self._model,
            schema=DocumentMemoryLandscape,
            system_prompt=BASE_SYSTEM_PROMPT,
            user_prompt=revision_prompt(
                route=route,
                title=state["document"].title,
                current_output=state["memory_landscape"].model_dump_json(indent=2),
                issue_instructions=instructions,
                source_excerpt=source_excerpt,
                landscape_schema=schema,
            ),
            progress=self._progress,
            progress_stage="回看·地形",
        )
        self._progress.report(
            "回看·地形",
            f"完成{action}，耗时 {time.perf_counter() - started_at:.1f} 秒",
        )
        return route, output

    def _freeze(self, state: ExplorationState) -> ExplorationState:
        latest_review = state["review_history"][-1]
        blocking = not latest_review.acceptable_as_global_exploration
        if blocking:
            self._progress.report("冻结", "达到校验上限，阅读地图仍带边界问题")
        else:
            self._progress.report("冻结", "全局勘探边界通过，正在冻结阅读地图")
        return {"frozen_with_boundary_issues": blocking}

    def _source_evidence(self, document: ParsedDocument) -> str:
        body = "\n\n".join(
            f"〔第 {page.page_number} 页〕\n{page.markdown}"
            for page in document.pages
        )
        return self._bounded_source(
            body,
            max_chars=self._settings.review_source_chars,
        )

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
        return self._bounded_source(
            body,
            max_chars=self._settings.revision_source_chars,
        )

    @staticmethod
    def _bounded_source(body: str, *, max_chars: int) -> str:
        if len(body) <= max_chars:
            return body
        marker = "\n\n〔证据包因长度上限被截断，不得据此宣称未覆盖部分不存在〕"
        return body[: max_chars - len(marker)] + marker

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
        labels = {"profile": "画像", "structure": "结构", "landscape": "地形"}
        return "、".join(labels[route] for route in sorted(routes))

    @staticmethod
    def _issue_pages_label(issues: list) -> str:
        pages = sorted({page for issue in issues for page in issue.evidence_pages})
        if not pages:
            return "完整证据范围"
        return f"第 {'、'.join(str(page) for page in pages)} 页"
