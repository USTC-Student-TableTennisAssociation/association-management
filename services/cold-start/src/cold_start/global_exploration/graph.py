"""用 LangGraph 并行形成文档背景，再构建递归区域树。"""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import TypedDict

from langgraph.graph import END, START, StateGraph

from cold_start.config import ExplorationSettings
from cold_start.document.blocks import build_document_blocks
from cold_start.document.models import ParsedDocument
from cold_start.global_exploration.models import (
    GlobalExplorationSnapshot,
    SourceMetadata,
)
from cold_start.global_exploration.prompts import (
    DOCUMENT_CONTEXT_SYSTEM_PROMPT,
    document_context_prompt,
)
from cold_start.global_exploration.units import ReadingUnit, build_reading_units
from cold_start.llm.base import ChatModel
from cold_start.progress import NullProgressReporter, ProgressReporter
from cold_start.region_tree.models import (
    ParentPartitionError,
    SplitDecision,
    StopDecision,
)
from cold_start.region_tree.runtime import (
    DecisionResult,
    RegionRuntime,
    RegionTree,
    TextEmbedder,
    WorkGroup,
    decide_root,
)


class State(TypedDict, total=False):
    document: ParsedDocument
    context_units: tuple[ReadingUnit, ...]
    document_context: str
    context_calls: int
    root_result: DecisionResult
    region_runtime: RegionRuntime
    snapshot: GlobalExplorationSnapshot


class GlobalExplorationRunner:
    def __init__(
        self,
        *,
        model: ChatModel,
        settings: ExplorationSettings | None = None,
        progress: ProgressReporter | None = None,
        run_directory: Path | None = None,
        embedder: TextEmbedder | None = None,
    ) -> None:
        self.model = model
        self.settings = settings or ExplorationSettings()
        self.progress = progress or NullProgressReporter()
        self.run_directory = run_directory
        self.embedder = embedder
        self.graph = self._graph()

    async def run(self, document: ParsedDocument) -> GlobalExplorationSnapshot:
        return (await self.graph.ainvoke({"document": document}))["snapshot"]

    def _graph(self):
        graph = StateGraph(State)
        graph.add_node("prepare", self._prepare)
        graph.add_node("document_context", self._document_context)
        graph.add_node("root_partition", self._root_partition)
        graph.add_node("build_region_tree", self._build_region_tree)
        graph.add_node("calibrate_region_tree", self._calibrate_region_tree)
        graph.add_node("finalize_exploration", self._finalize_exploration)
        graph.add_edge(START, "prepare")
        graph.add_edge("prepare", "document_context")
        graph.add_edge("prepare", "root_partition")
        graph.add_edge(["document_context", "root_partition"], "build_region_tree")
        graph.add_edge("build_region_tree", "calibrate_region_tree")
        graph.add_edge("calibrate_region_tree", "finalize_exploration")
        graph.add_edge("finalize_exploration", END)
        return graph.compile()

    def _prepare(self, state: State) -> State:
        document = state["document"]
        if not document.blocks:
            document = document.model_copy(
                update={"blocks": build_document_blocks(document.pages)}
            )
        units = build_reading_units(
            document.pages,
            target_chars=self.settings.context_unit_chars,
        )
        self.progress.report(
            "规划",
            f"文档背景 {len(units)} 个阅读单元；区域树 {len(document.blocks)} 个原文块",
        )
        return {"document": document, "context_units": units}

    async def _document_context(self, state: State) -> State:
        context = ""
        units = state["context_units"]
        for index, unit in enumerate(units, start=1):
            started = time.perf_counter()
            self.progress.report(
                "文档上下文",
                f"开始 {index}/{len(units)}（{unit.page_label}）",
            )
            context = (
                await self.model.complete(
                    system_prompt=DOCUMENT_CONTEXT_SYSTEM_PROMPT,
                    user_prompt=document_context_prompt(
                        title=state["document"].title,
                        unit=unit,
                        current_context=context,
                    ),
                    request_label="文档上下文",
                )
            ).strip()
            self.progress.report(
                "文档上下文",
                f"完成 {index}/{len(units)}，耗时 {time.perf_counter() - started:.1f} 秒",
            )
        return {"document_context": context, "context_calls": len(units)}

    async def _root_partition(self, state: State) -> State:
        document = state["document"]
        return {
            "root_result": await decide_root(
                model=self.model,
                title=document.title,
                blocks=document.blocks,
                progress=self.progress,
            )
        }

    async def _build_region_tree(self, state: State) -> State:
        document = state["document"]
        root = state["root_result"]
        runtime = RegionRuntime(
            model=self.model,
            blocks=document.blocks,
            context=state["document_context"],
            settings=self.settings,
            progress=self.progress,
            embedder=self.embedder,
            checkpoint=self._checkpoint,
        )
        await runtime.run(
            title=document.title,
            root_decision=_tree_decision(root),
            root_model_calls=root.model_calls,
        )
        return {"region_runtime": runtime}

    async def _calibrate_region_tree(self, state: State) -> State:
        await state["region_runtime"].calibrate_structure()
        return {}

    def _finalize_exploration(self, state: State) -> State:
        document = state["document"]
        tree = state["region_runtime"].tree.snapshot()
        snapshot = GlobalExplorationSnapshot(
            created_at=datetime.now(UTC),
            source=SourceMetadata(
                path=str(document.source_path),
                title=document.title,
                sha256=document.file_sha256,
                parser=document.parser_name,
                page_count=document.page_count,
                block_count=len(document.blocks),
            ),
            document_context_markdown=state["document_context"],
            context_model_calls=state["context_calls"],
            region_tree=tree,
        )
        self.progress.report(
            "汇总",
            (
                f"区域树状态 {tree.status}，内容节点 {len(tree.content_node_ids)} 个，"
                f"纯结构节点 {len(tree.structural_context_node_ids)} 个，"
                f"来源解析警告 {len(tree.source_issues)} 个"
            ),
        )
        return {"snapshot": snapshot}

    def _checkpoint(
        self,
        tree: RegionTree,
        groups: list[WorkGroup],
    ) -> None:
        if self.run_directory is None:
            return
        payload = {
            "root_node_id": tree.root_node_id,
            "nodes": [node.model_dump() for node in tree.nodes.values()],
            "pending_groups": groups,
            "issues": tree.issues,
            "source_issues": [issue.model_dump() for issue in tree.source_issues],
            "model_calls": tree.model_calls,
            "tool_calls": tree.tool_calls,
        }
        (self.run_directory / "region-tree-working.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


def _tree_decision(result: DecisionResult) -> StopDecision | SplitDecision:
    if isinstance(result.decision, ParentPartitionError):
        raise ValueError("根节点不能返回父分割错误")
    return result.decision
