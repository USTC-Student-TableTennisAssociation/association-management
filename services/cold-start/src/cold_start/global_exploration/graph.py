"""用 LangGraph 编排两条相互独立的全局勘探线路。"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import TypedDict

from langgraph.graph import END, START, StateGraph

from cold_start.config import ExplorationSettings
from cold_start.document.models import ParsedDocument
from cold_start.global_exploration.json_output import complete_json
from cold_start.global_exploration.models import (
    GlobalExplorationSnapshot,
    MacroSection,
    MacroSectionPlan,
    RouteStatistics,
    SourceMetadata,
)
from cold_start.global_exploration.prompts import (
    DOCUMENT_CONTEXT_SYSTEM_PROMPT,
    MACRO_SECTIONS_SYSTEM_PROMPT,
    document_context_prompt,
    macro_sections_prompt,
    macro_sections_repair_prompt,
)
from cold_start.global_exploration.units import (
    ReadingUnit,
    build_full_document_unit,
    build_reading_units,
)
from cold_start.llm.base import ChatModel
from cold_start.progress import NullProgressReporter, ProgressReporter


class ExplorationState(TypedDict, total=False):
    document: ParsedDocument
    context_units: tuple[ReadingUnit, ...]
    macro_sections_unit: ReadingUnit
    document_context_markdown: str
    macro_sections: list[MacroSection]
    macro_section_calls: int


class GlobalExplorationRunner:
    """并行形成简短文档背景和可执行宏观切分。"""

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
            document_context_markdown=state["document_context_markdown"],
            macro_sections=state["macro_sections"],
            route_statistics=RouteStatistics(
                context_units=len(state["context_units"]),
                macro_section_calls=state["macro_section_calls"],
            ),
        )

    def _build_graph(self):
        builder = StateGraph(ExplorationState)
        builder.add_node("prepare_parallel_routes", self._prepare_parallel_routes)
        builder.add_node("build_document_context", self._build_document_context)
        builder.add_node("plan_macro_sections", self._plan_macro_sections)
        builder.add_node("assemble_global_exploration", self._assemble)

        builder.add_edge(START, "prepare_parallel_routes")
        builder.add_edge("prepare_parallel_routes", "build_document_context")
        builder.add_edge("prepare_parallel_routes", "plan_macro_sections")
        builder.add_edge(
            [
                "build_document_context",
                "plan_macro_sections",
            ],
            "assemble_global_exploration",
        )
        builder.add_edge("assemble_global_exploration", END)
        return builder.compile()

    def _prepare_parallel_routes(self, state: ExplorationState) -> ExplorationState:
        document = state["document"]
        context_units = build_reading_units(
            document.pages,
            target_chars=self._settings.context_unit_chars,
        )
        self._progress.report(
            "规划",
            (
                f"两条线路已生成：文档上下文 {len(context_units)} 个顺序单元，"
                "宏观切分 1 次全文阅读"
            ),
        )
        return {
            "context_units": context_units,
            "macro_sections_unit": build_full_document_unit(document.pages),
            "document_context_markdown": "",
            "macro_sections": [],
            "macro_section_calls": 0,
        }

    async def _build_document_context(
        self,
        state: ExplorationState,
    ) -> ExplorationState:
        context = ""
        units = state["context_units"]
        for cursor, unit in enumerate(units):
            context = (
                await self._complete_text(
                    stage="文档上下文",
                    action=(
                        f"顺序阅读单元 {cursor + 1}/{len(units)}"
                        f"（{unit.page_label}）"
                    ),
                    system_prompt=DOCUMENT_CONTEXT_SYSTEM_PROMPT,
                    user_prompt=document_context_prompt(
                        title=state["document"].title,
                        unit=unit,
                        current_context=context,
                    ),
                )
            ).strip()
        return {"document_context_markdown": context}

    async def _plan_macro_sections(
        self,
        state: ExplorationState,
    ) -> ExplorationState:
        unit = state["macro_sections_unit"]
        prompt = macro_sections_prompt(
            title=state["document"].title,
            unit=unit,
        )
        self._progress.report("宏观切分", "开始阅读完整文档并划分后续阅读区域")
        started_at = time.perf_counter()
        plan = await complete_json(
            self._model,
            schema=MacroSectionPlan,
            system_prompt=MACRO_SECTIONS_SYSTEM_PROMPT,
            user_prompt=prompt,
            progress=self._progress,
            progress_stage="宏观切分",
        )
        calls = 1
        try:
            self._validate_macro_sections(plan, unit=unit)
        except ValueError as error:
            self._progress.report(
                "宏观切分",
                "页码覆盖校验失败，正在请求模型修正分区",
            )
            plan = await complete_json(
                self._model,
                schema=MacroSectionPlan,
                system_prompt=MACRO_SECTIONS_SYSTEM_PROMPT,
                user_prompt=macro_sections_repair_prompt(
                    original_prompt=prompt,
                    previous_output=plan,
                    validation_error=str(error),
                ),
                progress=self._progress,
                progress_stage="宏观切分",
            )
            calls += 1
            self._validate_macro_sections(plan, unit=unit)

        self._progress.report(
            "宏观切分",
            (
                f"完成 {len(plan.sections)} 个宏观区域，"
                f"耗时 {time.perf_counter() - started_at:.1f} 秒"
            ),
        )
        return {
            "macro_sections": plan.sections,
            "macro_section_calls": calls,
        }

    def _assemble(self, state: ExplorationState) -> ExplorationState:
        self._progress.report(
            "汇总",
            (
                "两条线路已汇合：文档上下文完成，"
                f"{len(state['macro_sections'])} 个宏观区域"
            ),
        )
        return {}

    @staticmethod
    def _validate_macro_sections(
        plan: MacroSectionPlan,
        *,
        unit: ReadingUnit,
    ) -> None:
        expected_page = unit.page_numbers[0]
        final_page = unit.page_numbers[-1]
        for section in plan.sections:
            if section.start_page != expected_page:
                raise ValueError(
                    f"期待下一个分区从第 {expected_page} 页开始，"
                    f"实际从第 {section.start_page} 页开始"
                )
            if section.end_page > final_page:
                raise ValueError(
                    f"分区“{section.label}”超出文档末页第 {final_page} 页"
                )
            expected_page = section.end_page + 1
        if expected_page != final_page + 1:
            raise ValueError(f"宏观分区未覆盖至文档末页第 {final_page} 页")

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
