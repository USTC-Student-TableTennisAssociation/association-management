"""递归区域树、单一文档检索工具和本地 BGE-M3。"""

from __future__ import annotations

import asyncio
import json
import os
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Generic, Protocol, TypeVar, cast

from pydantic import ValidationError

from cold_start.config import ExplorationSettings
from cold_start.document.blocks import render_heading_outline
from cold_start.document.models import ParsedBlock
from cold_start.llm.base import ChatModel
from cold_start.progress import NullProgressReporter, ProgressReporter
from cold_start.region_tree.models import (
    KeepDecision,
    ParentPartitionError,
    RegionChild,
    RegionDecision,
    RegionDecisionOutput,
    RegionNode,
    RegionTreeSnapshot,
    RepairDecision,
    RepairDecisionOutput,
    SplitDecision,
    StopDecision,
    TreeAudit,
    TreeAuditIssue,
)
from cold_start.region_tree.prompts import (
    REGION_REPAIR_SYSTEM_PROMPT,
    REGION_TREE_SYSTEM_PROMPT,
    TREE_AUDIT_SYSTEM_PROMPT,
    reconsider_parent_prompt,
    region_prompt,
    repair_decision_prompt,
    repair_region_prompt,
    root_region_prompt,
    tree_audit_prompt,
)

WorkGroup = tuple[str, tuple[str, ...]]
DecisionT = TypeVar("DecisionT")

SEARCH_TOOL: tuple[dict[str, object], ...] = (
    {
        "type": "function",
        "function": {
            "name": "search_document",
            "description": "在当前区域之外检索需要核对的原文。",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
)


@dataclass(frozen=True)
class DecisionResult(Generic[DecisionT]):
    decision: DecisionT
    model_calls: int
    tool_calls: int


class DecisionFailure(RuntimeError):
    def __init__(
        self,
        label: str,
        *,
        model_calls: int,
        tool_calls: int,
        cause: Exception,
    ) -> None:
        super().__init__(f"{label}判断失败：{cause}")
        self.model_calls = model_calls
        self.tool_calls = tool_calls


class TextEmbedder(Protocol):
    async def encode(self, texts: Sequence[str]) -> list[list[float]]: ...


class BlockIndex:
    def __init__(self, blocks: tuple[ParsedBlock, ...]) -> None:
        if not blocks:
            raise ValueError("区域树至少需要一个来源块")
        self.blocks = blocks
        self.positions = {block.block_id: index for index, block in enumerate(blocks)}

    def position(self, block_id: str) -> int:
        if block_id not in self.positions:
            raise ValueError(f"不存在来源块 {block_id}")
        return self.positions[block_id]

    def slice(self, start: str, end: str) -> tuple[ParsedBlock, ...]:
        left, right = self.position(start), self.position(end)
        if right < left:
            raise ValueError(f"块范围倒置：{start} → {end}")
        return self.blocks[left : right + 1]

    def pages(self, start: str, end: str) -> list[int]:
        return sorted({page for block in self.slice(start, end) for page in block.source_pages})

    def validate_children(
        self,
        start: str,
        end: str,
        children: list[RegionChild],
    ) -> None:
        expected, final = self.position(start), self.position(end)
        labels: set[str] = set()
        for child in children:
            left, right = self.position(child.start_block_id), self.position(
                child.end_block_id
            )
            if left != expected:
                raise ValueError(
                    f"子区域“{child.label}”应从 {self.blocks[expected].block_id} 开始"
                )
            if right < left or right > final:
                raise ValueError(f"子区域“{child.label}”范围非法")
            label = "".join(child.label.split()).casefold()
            if label in labels:
                raise ValueError(f"同一父节点下标签重复：{child.label}")
            labels.add(label)
            expected = right + 1
        if expected != final + 1:
            raise ValueError("子区域没有完整覆盖父区域")


class RegionTree:
    """只保留当前有效树；父节点重切时删除被替代的子树。"""

    def __init__(self, index: BlockIndex, *, max_depth: int) -> None:
        self.index = index
        self.max_depth = max_depth
        self.nodes: dict[str, RegionNode] = {}
        self.root_node_id = ""
        self.issues: list[str] = []
        self.model_calls = 0
        self.tool_calls = 0
        self.next_id = 1

    def initialize(
        self,
        *,
        title: str,
        decision: StopDecision | SplitDecision,
    ) -> list[WorkGroup]:
        root = self._create(
            parent_id=None,
            depth=0,
            label=title,
            introduction=decision.introduction,
            start=self.index.blocks[0].block_id,
            end=self.index.blocks[-1].block_id,
        )
        self.root_node_id = root.node_id
        return self.apply(root.node_id, decision)

    def apply(
        self,
        node_id: str,
        decision: StopDecision | SplitDecision,
    ) -> list[WorkGroup]:
        node = self.nodes[node_id]
        if isinstance(decision, StopDecision):
            self.nodes[node_id] = node.model_copy(
                update={
                    "introduction": decision.introduction,
                    "leaf_role": decision.leaf_role,
                    "decision_reason": decision.reason,
                    "status": "leaf",
                    "child_ids": [],
                }
            )
            return []
        if node.depth >= self.max_depth:
            self.review(node_id, f"{node_id} 达到最大深度后仍要求切分")
            return []

        self.index.validate_children(
            node.start_block_id, node.end_block_id, decision.children
        )
        children = [
            self._create(
                parent_id=node_id,
                depth=node.depth + 1,
                label=child.label,
                introduction=child.introduction,
                start=child.start_block_id,
                end=child.end_block_id,
            )
            for child in decision.children
        ]
        child_ids = [child.node_id for child in children]
        self.nodes[node_id] = node.model_copy(
            update={
                "introduction": decision.introduction,
                "leaf_role": None,
                "decision_reason": decision.reason,
                "status": "branch",
                "child_ids": child_ids,
            }
        )
        return [(node_id, tuple(child_ids))]

    def check_parent_error(
        self,
        current_id: str,
        decision: ParentPartitionError,
    ) -> str:
        current = self.nodes[current_id]
        if current.parent_id is None or current_id not in decision.related_node_ids:
            raise ValueError("父分割错误必须包含当前节点，且当前节点不能是根节点")
        parent = self.nodes[current.parent_id]
        positions: list[int] = []
        for node_id in decision.related_node_ids:
            node = self.nodes.get(node_id)
            if node is None or node.parent_id != parent.node_id:
                raise ValueError("父分割错误只能引用同一父节点下的兄弟")
            positions.append(parent.child_ids.index(node_id))
        positions.sort()
        if positions != list(range(positions[0], positions[-1] + 1)):
            raise ValueError("父分割错误引用的兄弟必须连续")
        return parent.node_id

    def reopen(
        self,
        parent_id: str,
        decision: StopDecision | SplitDecision,
    ) -> list[WorkGroup]:
        parent = self.nodes[parent_id]
        if parent.revised:
            self.review(parent_id, f"{parent_id} 已自动重切一次，仍出现分割错误")
            return []
        for child_id in parent.child_ids:
            self._drop(child_id)
        self.nodes[parent_id] = parent.model_copy(
            update={"status": "pending", "child_ids": [], "revised": True}
        )
        return self.apply(parent_id, decision)

    def calibrate(
        self,
        node_id: str,
        decision: KeepDecision | StopDecision | SplitDecision,
    ) -> list[WorkGroup]:
        node = self.nodes[node_id]
        if isinstance(decision, KeepDecision):
            self.nodes[node_id] = node.model_copy(
                update={"decision_reason": decision.reason}
            )
            return []
        for child_id in node.child_ids:
            self._drop(child_id)
        self.nodes[node_id] = node.model_copy(
            update={
                "status": "pending",
                "leaf_role": None,
                "child_ids": [],
                "revised": True,
            }
        )
        return self.apply(node_id, decision)

    def review(self, node_id: str, issue: str) -> None:
        self._mark(node_id, "needs_review", issue)

    def fail(self, node_id: str, issue: str) -> None:
        self._mark(node_id, "failed", issue)

    def lineage(self, node_id: str) -> list[RegionNode]:
        result: list[RegionNode] = []
        node = self.nodes[node_id]
        while node.parent_id:
            node = self.nodes[node.parent_id]
            result.append(node)
        return result[::-1]

    def siblings(self, node_id: str) -> list[RegionNode]:
        node = self.nodes[node_id]
        if node.parent_id is None:
            return [node]
        return [self.nodes[item] for item in self.nodes[node.parent_id].child_ids]

    def snapshot(self) -> RegionTreeSnapshot:
        unfinished = {"pending", "failed", "needs_review"}
        status = (
            "needs_review"
            if self.issues or any(node.status in unfinished for node in self.nodes.values())
            else "frozen"
        )
        leaves = sorted(
            (node for node in self.nodes.values() if node.status == "leaf"),
            key=lambda node: self.index.position(node.start_block_id),
        )
        if status == "frozen":
            expected = 0
            for leaf in leaves:
                if self.index.position(leaf.start_block_id) != expected:
                    raise ValueError("最终叶子存在遗漏或重叠")
                expected = self.index.position(leaf.end_block_id) + 1
            if expected != len(self.index.blocks):
                raise ValueError("最终叶子没有覆盖完整文档")
            if any(node.leaf_role is None for node in leaves):
                raise ValueError("最终叶子缺少结构作用")
        content_leaves = [
            node.node_id for node in leaves if node.leaf_role == "content_source"
        ]
        structural_leaves = [
            node.node_id
            for node in leaves
            if node.leaf_role == "structural_context"
        ]
        return RegionTreeSnapshot(
            status=status,
            root_node_id=self.root_node_id,
            nodes=sorted(self.nodes.values(), key=lambda node: node.node_id),
            leaf_node_ids=[node.node_id for node in leaves],
            content_leaf_ids=content_leaves,
            structural_context_leaf_ids=structural_leaves,
            issues=self.issues.copy(),
            model_calls=self.model_calls,
            tool_calls=self.tool_calls,
        )

    def _create(
        self,
        *,
        parent_id: str | None,
        depth: int,
        label: str,
        introduction: str,
        start: str,
        end: str,
    ) -> RegionNode:
        node = RegionNode(
            node_id=f"region-{self.next_id:04d}",
            parent_id=parent_id,
            depth=depth,
            label=label,
            introduction=introduction,
            start_block_id=start,
            end_block_id=end,
            source_pages=self.index.pages(start, end),
            status="pending",
        )
        self.next_id += 1
        self.nodes[node.node_id] = node
        return node

    def _drop(self, node_id: str) -> None:
        for child_id in self.nodes[node_id].child_ids:
            self._drop(child_id)
        self.nodes.pop(node_id)

    def _mark(self, node_id: str, status: str, issue: str) -> None:
        self.nodes[node_id] = self.nodes[node_id].model_copy(update={"status": status})
        self.issues.append(issue)


class BgeM3Embedder:
    """首次检索时才加载本地或 Hugging Face BGE-M3。"""

    def __init__(self, model_name: str, progress: ProgressReporter) -> None:
        self.model_name = model_name
        self.progress = progress
        self.tokenizer: object | None = None
        self.model: object | None = None
        self.device = ""
        self.lock = asyncio.Lock()

    async def encode(self, texts: Sequence[str]) -> list[list[float]]:
        async with self.lock:
            started = time.perf_counter()
            self.progress.report("检索", f"开始 BGE-M3 编码 {len(texts)} 个文本")
            vectors = await asyncio.to_thread(self._encode, list(texts))
            self.progress.report(
                "检索",
                f"BGE-M3 编码完成，耗时 {time.perf_counter() - started:.1f} 秒",
            )
            return vectors

    def _encode(self, texts: list[str]) -> list[list[float]]:
        import torch
        import torch.nn.functional as functional
        from transformers import AutoModel, AutoTokenizer

        if self.model is None:
            mps = getattr(torch.backends, "mps", None)
            self.device = (
                os.getenv("COLD_START_EMBEDDING_DEVICE")
                or ("cuda" if torch.cuda.is_available() else "")
                or ("mps" if mps and mps.is_available() else "cpu")
            )
            self.tokenizer = AutoTokenizer.from_pretrained(self.model_name)
            self.model = AutoModel.from_pretrained(self.model_name).to(self.device).eval()
        vectors: list[list[float]] = []
        batch_size = int(os.getenv("COLD_START_EMBEDDING_BATCH_SIZE", "8"))
        for start in range(0, len(texts), batch_size):
            inputs = self.tokenizer(
                texts[start : start + batch_size],
                padding=True,
                truncation=True,
                max_length=2048,
                return_tensors="pt",
            )
            inputs = {key: value.to(self.device) for key, value in inputs.items()}
            with torch.no_grad():
                output = self.model(**inputs).last_hidden_state[:, 0]
                output = functional.normalize(output, p=2, dim=1)
            vectors.extend(output.cpu().float().tolist())
        return vectors


@dataclass(frozen=True)
class _SearchUnit:
    blocks: tuple[ParsedBlock, ...]
    contextual_text: str


class DocumentSearch:
    def __init__(
        self,
        index: BlockIndex,
        *,
        target_chars: int,
        embedder: TextEmbedder,
    ) -> None:
        self.index = index
        self.embedder = embedder
        self.units = _search_units(index.blocks, target_chars)
        self.vectors: list[list[float]] | None = None
        self.lock = asyncio.Lock()

    async def search(self, query: str, current: RegionNode, top_k: int) -> str:
        current_left = self.index.position(current.start_block_id)
        current_right = self.index.position(current.end_block_id)
        candidates = [
            index
            for index, unit in enumerate(self.units)
            if self.index.position(unit.blocks[-1].block_id) < current_left
            or self.index.position(unit.blocks[0].block_id) > current_right
        ]
        if not candidates:
            return "当前区域之外没有可检索原文。"
        if self.vectors is None:
            async with self.lock:
                if self.vectors is None:
                    self.vectors = await self.embedder.encode(
                        [unit.contextual_text for unit in self.units]
                    )
        query_vector = (await self.embedder.encode([query]))[0]
        scores = [
            sum(a * b for a, b in zip(vector, query_vector, strict=True))
            for vector in cast(list[list[float]], self.vectors)
        ]
        hits = sorted(candidates, key=scores.__getitem__, reverse=True)[:top_k]
        return "\n\n".join(
            _format_hit(rank, self.units[index]) for rank, index in enumerate(hits, 1)
        )


class RegionRuntime:
    def __init__(
        self,
        *,
        model: ChatModel,
        blocks: tuple[ParsedBlock, ...],
        context: str,
        settings: ExplorationSettings,
        progress: ProgressReporter | None = None,
        embedder: TextEmbedder | None = None,
        checkpoint: Callable[[RegionTree, list[WorkGroup]], None] | None = None,
    ) -> None:
        self.model = model
        self.context = context
        self.settings = settings
        self.progress = progress or NullProgressReporter()
        self.index = BlockIndex(blocks)
        self.tree = RegionTree(self.index, max_depth=settings.max_tree_depth)
        self.search = DocumentSearch(
            self.index,
            target_chars=settings.retrieval_unit_chars,
            embedder=embedder or BgeM3Embedder(settings.embedding_model, self.progress),
        )
        self.checkpoint = checkpoint

    async def run(
        self,
        *,
        title: str,
        root_decision: StopDecision | SplitDecision,
        root_model_calls: int,
    ) -> RegionTreeSnapshot:
        groups = self.tree.initialize(title=title, decision=root_decision)
        self.tree.model_calls = root_model_calls
        self._save(groups)
        await self._process_groups(groups)
        return self.tree.snapshot()

    async def audit(self) -> TreeAudit | None:
        if self.tree.snapshot().status != "frozen":
            return None
        try:
            result = await _ask(
                model=self.model,
                system_prompt=TREE_AUDIT_SYSTEM_PROMPT,
                prompt=tree_audit_prompt(
                    document_context=self.context,
                    tree_outline=self._outline(self.tree.root_node_id),
                ),
                label="区域树·全树校准",
                max_tool_calls=0,
                search=None,
                parser=_parse_audit,
                validator=self._validate_audit,
                describe=lambda audit: (
                    f"{len(audit.issues)} 个问题" if audit.issues else "通过"
                ),
                progress=self.progress,
            )
            self.tree.model_calls += result.model_calls
            return result.decision
        except DecisionFailure as error:
            self.tree.model_calls += error.model_calls
            self.tree.review(self.tree.root_node_id, f"全树校准失败：{error}")
            return None

    async def repair(self, audit: TreeAudit) -> None:
        targets = self._repair_targets(audit)
        if not targets:
            return
        self.progress.report("区域树·定点修复", f"开始复核 {len(targets)} 个子树")
        semaphore = asyncio.Semaphore(self.settings.max_parallel_regions)

        async def evaluate(
            target: tuple[str, list[TreeAuditIssue]],
        ) -> DecisionResult[RepairDecision]:
            async with semaphore:
                return await self._evaluate_repair(*target)

        raw = await asyncio.gather(
            *(evaluate(target) for target in targets),
            return_exceptions=True,
        )
        groups: list[WorkGroup] = []
        for (node_id, _), result in zip(targets, raw, strict=True):
            if isinstance(result, (DecisionResult, DecisionFailure)):
                self.tree.model_calls += result.model_calls
                self.tree.tool_calls += result.tool_calls
            if isinstance(result, BaseException):
                self.tree.review(node_id, f"{node_id} 定点修复失败：{result}")
                continue
            try:
                groups.extend(self.tree.calibrate(node_id, result.decision))
            except Exception as error:
                self.tree.review(node_id, f"{node_id} 应用定点修复失败：{error}")
        self._save(groups)
        await self._process_groups(groups)

    async def _process_groups(self, groups: list[WorkGroup]) -> None:
        semaphore = asyncio.Semaphore(self.settings.max_parallel_regions)
        while groups:
            node_ids = [node_id for _, siblings in groups for node_id in siblings]
            self.progress.report("区域树", f"开始判断 {len(node_ids)} 个区域")

            async def evaluate(node_id: str) -> DecisionResult[RegionDecision]:
                async with semaphore:
                    return await self._evaluate(node_id)

            raw = await asyncio.gather(
                *(evaluate(node_id) for node_id in node_ids),
                return_exceptions=True,
            )
            results = dict(zip(node_ids, raw, strict=True))
            for result in raw:
                if isinstance(result, (DecisionResult, DecisionFailure)):
                    self.tree.model_calls += result.model_calls
                    self.tree.tool_calls += result.tool_calls

            next_groups: list[WorkGroup] = []
            for offset, (parent_id, siblings) in enumerate(groups):
                reports = [
                    (node_id, result.decision)
                    for node_id in siblings
                    if isinstance((result := results[node_id]), DecisionResult)
                    and isinstance(result.decision, ParentPartitionError)
                ]
                if reports:
                    next_groups.extend(await self._handle_parent_error(parent_id, reports))
                else:
                    for node_id in siblings:
                        result = results[node_id]
                        if isinstance(result, BaseException):
                            self.tree.fail(node_id, f"{node_id} 技术失败：{result}")
                            continue
                        try:
                            next_groups.extend(
                                self.tree.apply(
                                    node_id,
                                    _tree_decision(cast(DecisionResult, result).decision),
                                )
                            )
                        except Exception as error:
                            self.tree.fail(node_id, f"{node_id} 应用判断失败：{error}")
                self._save(groups[offset + 1 :] + next_groups)
            groups = next_groups

    async def _evaluate(self, node_id: str) -> DecisionResult[RegionDecision]:
        node = self.tree.nodes[node_id]
        left = self.index.position(node.start_block_id)
        right = self.index.position(node.end_block_id)
        boundary = self.settings.boundary_context_blocks
        return await _ask(
            model=self.model,
            prompt=region_prompt(
                document_context=self.context,
                node=node,
                lineage=self.tree.lineage(node_id),
                siblings=self.tree.siblings(node_id),
                current_blocks=self.index.blocks[left : right + 1],
                before_blocks=self.index.blocks[max(0, left - boundary) : left],
                after_blocks=self.index.blocks[right + 1 : right + 1 + boundary],
            ),
            label=f"区域树·{node_id}",
            max_tool_calls=self.settings.max_tool_calls_per_region,
            search=lambda query: self.search.search(
                query, node, self.settings.retrieval_top_k
            ),
            parser=_parse_region,
            validator=lambda decision: self._validate(node, decision),
            describe=lambda decision: decision.action,
            system_prompt=REGION_TREE_SYSTEM_PROMPT,
            progress=self.progress,
        )

    async def _evaluate_repair(
        self,
        node_id: str,
        issues: list[TreeAuditIssue],
    ) -> DecisionResult[RepairDecision]:
        node = self.tree.nodes[node_id]
        left = self.index.position(node.start_block_id)
        right = self.index.position(node.end_block_id)
        boundary = self.settings.boundary_context_blocks
        return await _ask(
            model=self.model,
            system_prompt=REGION_REPAIR_SYSTEM_PROMPT,
            prompt=repair_region_prompt(
                document_context=self.context,
                node=node,
                lineage=self.tree.lineage(node_id),
                siblings=self.tree.siblings(node_id),
                current_subtree=self._outline(node_id),
                current_blocks=self.index.blocks[left : right + 1],
                before_blocks=self.index.blocks[max(0, left - boundary) : left],
                after_blocks=self.index.blocks[right + 1 : right + 1 + boundary],
                issues=issues,
            ),
            label=f"区域树·修复-{node_id}",
            max_tool_calls=self.settings.max_tool_calls_per_region,
            search=lambda query: self.search.search(
                query, node, self.settings.retrieval_top_k
            ),
            parser=_parse_repair,
            validator=lambda decision: self._validate_repair(node, decision),
            describe=lambda decision: decision.action,
            progress=self.progress,
        )

    async def _handle_parent_error(
        self,
        parent_id: str,
        reports: list[tuple[str, ParentPartitionError]],
    ) -> list[WorkGroup]:
        try:
            for node_id, report in reports:
                self.tree.check_parent_error(node_id, report)
            if self.tree.nodes[parent_id].revised:
                self.tree.review(parent_id, f"{parent_id} 重切后仍有边界错误")
                return []
            parent = self.tree.nodes[parent_id]
            result = await _ask(
                model=self.model,
                system_prompt=REGION_TREE_SYSTEM_PROMPT,
                prompt=reconsider_parent_prompt(
                    document_context=self.context,
                    parent=parent,
                    lineage=self.tree.lineage(parent_id),
                    old_children=[self.tree.nodes[item] for item in parent.child_ids],
                    parent_blocks=self.index.slice(
                        parent.start_block_id, parent.end_block_id
                    ),
                    reported_errors=reports,
                ),
                label=f"区域树·重切-{parent_id}",
                max_tool_calls=self.settings.max_tool_calls_per_region,
                search=lambda query: self.search.search(
                    query, parent, self.settings.retrieval_top_k
                ),
                parser=_parse_region,
                validator=lambda decision: self._validate(
                    parent, decision, reconsidering=True
                ),
                describe=lambda decision: decision.action,
                progress=self.progress,
            )
            self.tree.model_calls += result.model_calls
            self.tree.tool_calls += result.tool_calls
            return self.tree.reopen(parent_id, _tree_decision(result.decision))
        except DecisionFailure as error:
            self.tree.model_calls += error.model_calls
            self.tree.tool_calls += error.tool_calls
            self.tree.review(parent_id, f"父节点重切失败：{error}")
        except Exception as error:
            self.tree.review(parent_id, f"父节点重切失败：{error}")
        return []

    def _validate(
        self,
        node: RegionNode,
        decision: RegionDecision,
        *,
        reconsidering: bool = False,
    ) -> None:
        if isinstance(decision, SplitDecision):
            self.index.validate_children(
                node.start_block_id, node.end_block_id, decision.children
            )
        elif isinstance(decision, ParentPartitionError):
            if reconsidering:
                raise ValueError("重切父节点时不能再次报告父分割错误")
            self.tree.check_parent_error(node.node_id, decision)

    def _validate_repair(
        self,
        node: RegionNode,
        decision: RepairDecision,
    ) -> None:
        if isinstance(decision, SplitDecision):
            self.index.validate_children(
                node.start_block_id, node.end_block_id, decision.children
            )

    def _validate_audit(self, audit: TreeAudit) -> None:
        for issue in audit.issues:
            if issue.target_node_id not in self.tree.nodes:
                raise ValueError(f"校准引用不存在的目标 {issue.target_node_id}")

    def _repair_targets(
        self,
        audit: TreeAudit,
    ) -> list[tuple[str, list[TreeAuditIssue]]]:
        ordered = sorted(
            audit.issues,
            key=lambda issue: (
                self.tree.nodes[issue.target_node_id].depth,
                self.index.position(
                    self.tree.nodes[issue.target_node_id].start_block_id
                ),
            ),
        )
        targets: list[tuple[str, list[TreeAuditIssue]]] = []
        for issue in ordered:
            ancestors = {
                issue.target_node_id,
                *(node.node_id for node in self.tree.lineage(issue.target_node_id)),
            }
            existing = next((item for item in targets if item[0] in ancestors), None)
            if existing:
                existing[1].append(issue)
            else:
                targets.append((issue.target_node_id, [issue]))
        return targets

    def _outline(self, root_id: str) -> str:
        lines: list[str] = []

        def visit(node_id: str, relative_depth: int) -> None:
            node = self.tree.nodes[node_id]
            blocks = self.index.slice(node.start_block_id, node.end_block_id)
            role = f"，角色={node.leaf_role}" if node.leaf_role else ""
            lines.append(
                f"{'  ' * relative_depth}- {node.node_id}｜深度={node.depth}｜"
                f"{node.status}{role}｜第 {'、'.join(map(str, node.source_pages))} 页｜"
                f"{len(blocks)} 块｜{sum(len(block.markdown) for block in blocks)} 字符｜"
                f"{node.start_block_id}～{node.end_block_id}｜{node.label}"
            )
            lines.append(f"{'  ' * relative_depth}  介绍：{node.introduction}")
            if node.decision_reason:
                lines.append(
                    f"{'  ' * relative_depth}  判断理由：{node.decision_reason}"
                )
            if node.status == "leaf":
                headings = render_heading_outline(blocks)
                lines.append(
                    f"{'  ' * relative_depth}  内部标题：{headings or '（无）'}"
                )
            for child_id in node.child_ids:
                visit(child_id, relative_depth + 1)

        visit(root_id, 0)
        return "\n".join(lines)

    def _save(self, groups: list[WorkGroup]) -> None:
        if self.checkpoint:
            self.checkpoint(self.tree, groups)


async def decide_root(
    *,
    model: ChatModel,
    title: str,
    blocks: tuple[ParsedBlock, ...],
    progress: ProgressReporter,
) -> DecisionResult[RegionDecision]:
    index = BlockIndex(blocks)

    def validate(decision: RegionDecision) -> None:
        if isinstance(decision, ParentPartitionError):
            raise ValueError("根节点不能报告父分割错误")
        if isinstance(decision, SplitDecision):
            index.validate_children(
                blocks[0].block_id, blocks[-1].block_id, decision.children
            )

    return await _ask(
        model=model,
        system_prompt=REGION_TREE_SYSTEM_PROMPT,
        prompt=root_region_prompt(
            title=title,
            blocks=blocks,
        ),
        label="区域树·根节点",
        max_tool_calls=0,
        search=None,
        parser=_parse_region,
        validator=validate,
        describe=lambda decision: decision.action,
        progress=progress,
    )


async def _ask(
    *,
    model: ChatModel,
    system_prompt: str,
    prompt: str,
    label: str,
    max_tool_calls: int,
    search: Callable[[str], Awaitable[str]] | None,
    parser: Callable[[str], DecisionT],
    validator: Callable[[DecisionT], None],
    describe: Callable[[DecisionT], str],
    progress: ProgressReporter,
) -> DecisionResult[DecisionT]:
    messages: list[Mapping[str, Any]] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": prompt},
    ]
    model_calls = tool_calls = 0
    progress.report(label, "开始判断")
    try:
        while True:
            can_search = search is not None and tool_calls < max_tool_calls
            model_calls += 1
            turn = await model.complete_turn(
                messages=messages,
                tools=SEARCH_TOOL if can_search else (),
                tool_choice="auto" if can_search else None,
                request_label=label,
                thinking="enabled",
            )
            if not turn.tool_calls:
                break
            messages.append(turn.as_assistant_message())
            for call in turn.tool_calls:
                if call.name != "search_document":
                    result = f"未知工具：{call.name}"
                elif not can_search or search is None:
                    result = "工具预算已用完，请直接给出最终 JSON。"
                else:
                    try:
                        arguments = json.loads(call.arguments)
                        query = arguments.get("query") if isinstance(arguments, dict) else None
                        if not isinstance(query, str) or not query.strip():
                            raise ValueError("query 必须是非空字符串")
                        result = (
                            "以下原文只用于核对边界或关联，不能并入当前区域：\n\n"
                            + await search(query)
                        )
                    except Exception as error:
                        result = f"工具调用失败：{error}"
                    tool_calls += 1
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.id,
                        "content": result[:6000],
                    }
                )

        try:
            if not turn.content:
                raise ValueError("模型正常结束但没有正式 JSON")
            decision = parser(turn.content)
            validator(decision)
        except (ValidationError, ValueError, json.JSONDecodeError) as error:
            model_calls += 1
            repair = await model.complete_turn(
                messages=[
                    *messages,
                    turn.as_assistant_message(),
                    {
                        "role": "user",
                        "content": repair_decision_prompt(
                            invalid_output=turn.content or "（没有正式正文）",
                            error=str(error),
                        ),
                    },
                ],
                request_label=f"{label}·修复",
                thinking="disabled",
            )
            if not repair.content:
                raise ValueError("修复请求仍未返回正式正文") from error
            decision = parser(repair.content)
            validator(decision)
        progress.report(label, f"完成判断：{describe(decision)}")
        return DecisionResult(decision, model_calls, tool_calls)
    except Exception as error:
        raise DecisionFailure(
            label,
            model_calls=model_calls,
            tool_calls=tool_calls,
            cause=error,
        ) from error


def _json_object(raw: str) -> str:
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end < start:
        raise ValueError("模型输出中不存在 JSON 对象")
    return raw[start : end + 1]


def _parse_region(raw: str) -> RegionDecision:
    return RegionDecisionOutput.model_validate_json(_json_object(raw)).root


def _parse_repair(raw: str) -> RepairDecision:
    return RepairDecisionOutput.model_validate_json(_json_object(raw)).root


def _parse_audit(raw: str) -> TreeAudit:
    return TreeAudit.model_validate_json(_json_object(raw))


def _tree_decision(decision: RegionDecision) -> StopDecision | SplitDecision:
    if isinstance(decision, ParentPartitionError):
        raise ValueError("这里必须得到 stop 或 split")
    return decision


def _search_units(
    blocks: tuple[ParsedBlock, ...],
    target_chars: int,
) -> list[_SearchUnit]:
    groups: list[list[ParsedBlock]] = []
    current: list[ParsedBlock] = []
    size = 0
    for block in blocks:
        if current and (
            block.block_type == "heading" or size + len(block.markdown) > target_chars
        ):
            groups.append(current)
            current, size = [], 0
        current.append(block)
        size += len(block.markdown)
    if current:
        groups.append(current)
    return [
        _SearchUnit(
            blocks=tuple(group),
            contextual_text=(
                f"章节：{' > '.join(group[0].heading_path)}\n"
                + "\n\n".join(block.markdown for block in group)
            ),
        )
        for group in groups
    ]


def _format_hit(rank: int, unit: _SearchUnit) -> str:
    pages = sorted({page for block in unit.blocks for page in block.source_pages})
    content = "\n\n".join(
        f"[{block.block_id}] {block.markdown}" for block in unit.blocks
    )
    return (
        f"命中 {rank}｜第 {'、'.join(map(str, pages))} 页｜"
        f"{unit.blocks[0].block_id}～{unit.blocks[-1].block_id}\n{content}"
    )
