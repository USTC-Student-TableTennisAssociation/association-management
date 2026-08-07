"""递归区域树、单一文档检索工具和本地 BGE-M3。"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Generic, Protocol, TypeVar, cast

from pydantic import ValidationError

from cold_start.config import ExplorationSettings
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
    SourceIssue,
    SourceRole,
    SourceSegment,
    SplitDecision,
    StopDecision,
    StructureCheckReport,
    StructureIssue,
)
from cold_start.region_tree.prompts import (
    REGION_TREE_SYSTEM_PROMPT,
    STRUCTURE_REPAIR_SYSTEM_PROMPT,
    reconsider_parent_prompt,
    region_prompt,
    repair_decision_prompt,
    root_region_prompt,
    structure_repair_prompt,
)

WorkGroup = tuple[str, tuple[str, ...]]
DecisionT = TypeVar("DecisionT")
HEADING_NUMBER_PATTERN = re.compile(
    r"^\s*#{1,6}\s+(\d+(?:\.\d+)*)\.?(?=\s|[^\d.]|$)"
)

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

    def partition(
        self,
        start: str,
        end: str,
        children: list[RegionChild],
    ) -> list[SourceSegment]:
        parent_left, parent_right = self.position(start), self.position(end)
        cursor = parent_left
        labels: set[str] = set()
        owned: list[SourceSegment] = []
        for child in children:
            left, right = self.position(child.start_block_id), self.position(
                child.end_block_id
            )
            if left < parent_left or right < left or right > parent_right:
                raise ValueError(f"子区域“{child.label}”范围非法")
            if left < cursor:
                raise ValueError(f"子区域“{child.label}”与前一个孩子重叠或乱序")
            if cursor < left:
                owned.append(self._segment(cursor, left - 1))
            label = "".join(child.label.split()).casefold()
            if label in labels:
                raise ValueError(f"同一父节点下标签重复：{child.label}")
            labels.add(label)
            cursor = right + 1
        if cursor <= parent_right:
            owned.append(self._segment(cursor, parent_right))
        if (
            len(children) == 1
            and not owned
            and children[0].start_block_id == start
            and children[0].end_block_id == end
        ):
            raise ValueError("单个孩子不能完整复制父区域")
        return owned

    def validate_owned_role(
        self,
        segments: list[SourceSegment],
        role: SourceRole | None,
    ) -> None:
        if bool(segments) != bool(role):
            raise ValueError(
                "存在自有原文时必须填写 owned_source_role，"
                "没有自有原文时必须填写 null"
            )

    def resolve_ownership(
        self,
        start: str,
        end: str,
        decision: StopDecision | SplitDecision,
    ) -> list[SourceSegment]:
        owned = (
            self.partition(start, end, decision.children)
            if isinstance(decision, SplitDecision)
            else [SourceSegment(start_block_id=start, end_block_id=end)]
        )
        self.validate_owned_role(owned, decision.owned_source_role)
        return owned

    def _segment(self, left: int, right: int) -> SourceSegment:
        return SourceSegment(
            start_block_id=self.blocks[left].block_id,
            end_block_id=self.blocks[right].block_id,
        )


class RegionTree:
    """只保留当前有效树；父节点重切时删除被替代的子树。"""

    def __init__(self, index: BlockIndex, *, max_depth: int) -> None:
        self.index = index
        self.max_depth = max_depth
        self.nodes: dict[str, RegionNode] = {}
        self.root_node_id = ""
        self.issues: list[str] = []
        self.source_issues: list[SourceIssue] = []
        self.structure_check = StructureCheckReport()
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
        self._record_source_issues(decision.source_issues)
        if isinstance(decision, StopDecision):
            owned = self.index.resolve_ownership(
                node.start_block_id, node.end_block_id, decision
            )
            self.nodes[node_id] = node.model_copy(
                update={
                    "introduction": decision.introduction,
                    "owned_segments": owned,
                    "owned_source_role": decision.owned_source_role,
                    "decision_reason": decision.reason,
                    "status": "leaf",
                    "child_ids": [],
                }
            )
            return []
        if node.depth >= self.max_depth:
            self.review(node_id, f"{node_id} 达到最大深度后仍要求切分")
            return []

        owned = self.index.resolve_ownership(
            node.start_block_id, node.end_block_id, decision
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
                "owned_segments": owned,
                "owned_source_role": decision.owned_source_role,
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
            update={
                "status": "pending",
                "owned_segments": [],
                "owned_source_role": None,
                "child_ids": [],
                "revised": True,
            }
        )
        return self.apply(parent_id, decision)

    def calibrate(
        self,
        node_id: str,
        decision: KeepDecision | StopDecision | SplitDecision,
    ) -> list[WorkGroup]:
        node = self.nodes[node_id]
        if isinstance(decision, KeepDecision):
            self._record_source_issues(decision.source_issues)
            self.nodes[node_id] = node.model_copy(
                update={"decision_reason": decision.reason}
            )
            return []
        for child_id in node.child_ids:
            self._drop(child_id)
        self.nodes[node_id] = node.model_copy(
            update={
                "status": "pending",
                "owned_segments": [],
                "owned_source_role": None,
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

    def detect_structure_issues(self) -> list[StructureIssue]:
        owners: dict[str, str] = {}
        for node in self.nodes.values():
            for segment in node.owned_segments:
                left = self.index.position(segment.start_block_id)
                right = self.index.position(segment.end_block_id)
                for block in self.index.blocks[left : right + 1]:
                    owners[block.block_id] = node.node_id

        headings: dict[tuple[int, ...], list[tuple[str, str]]] = {}
        for block in self.index.blocks:
            if block.block_type != "heading":
                continue
            match = HEADING_NUMBER_PATTERN.match(block.markdown)
            owner = owners.get(block.block_id)
            if not match or owner is None:
                continue
            number = tuple(int(part) for part in match.group(1).split("."))
            headings.setdefault(number, []).append((owner, block.block_id))

        problems: dict[str, list[tuple[str, str]]] = {}
        for number, children in headings.items():
            if len(number) < 2 or number[:-1] not in headings:
                continue
            parent_owners = {owner for owner, _ in headings[number[:-1]]}
            for child_owner, child_block_id in children:
                if any(
                    self._is_descendant(child_owner, parent_owner)
                    for parent_owner in parent_owners
                ):
                    continue
                target = self._lowest_common_ancestor(
                    [child_owner, *sorted(parent_owners)]
                )
                child_label = ".".join(map(str, number))
                parent_label = ".".join(map(str, number[:-1]))
                problems.setdefault(target, []).append(
                    (
                        f"标题 {child_label} 不在拥有标题 {parent_label} 的节点子树内",
                        child_block_id,
                    )
                )

        return [
            StructureIssue(
                kind="heading_hierarchy",
                target_node_id=node_id,
                block_ids=list(dict.fromkeys(block_id for _, block_id in details)),
                reason="；".join(dict.fromkeys(reason for reason, _ in details))[:500],
            )
            for node_id, details in sorted(
                problems.items(),
                key=lambda item: self.index.position(
                    self.nodes[item[0]].start_block_id
                ),
            )
        ]

    def set_structure_check(
        self,
        initial: list[StructureIssue],
        remaining: list[StructureIssue],
    ) -> None:
        self.structure_check = StructureCheckReport(
            initial_issues=initial,
            remaining_issues=remaining,
        )

    def _is_descendant(self, node_id: str, ancestor_id: str) -> bool:
        current: str | None = node_id
        while current is not None:
            if current == ancestor_id:
                return True
            current = self.nodes[current].parent_id
        return False

    def _lowest_common_ancestor(self, node_ids: list[str]) -> str:
        paths: list[list[str]] = []
        for node_id in node_ids:
            path = [node_id]
            current = self.nodes[node_id]
            while current.parent_id:
                path.append(current.parent_id)
                current = self.nodes[current.parent_id]
            paths.append(path[::-1])
        common = self.root_node_id
        for items in zip(*paths, strict=False):
            if len(set(items)) != 1:
                break
            common = items[0]
        return common

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
            ownership = sorted(
                (
                    self.index.position(segment.start_block_id),
                    self.index.position(segment.end_block_id),
                    node.node_id,
                )
                for node in self.nodes.values()
                for segment in node.owned_segments
            )
            expected = 0
            for left, right, node_id in ownership:
                if left != expected:
                    raise ValueError(f"{node_id} 的自有原文与前序节点遗漏或重叠")
                expected = right + 1
            if expected != len(self.index.blocks):
                raise ValueError("所有节点的自有原文没有完整覆盖文档")
            if any(
                bool(node.owned_segments) != bool(node.owned_source_role)
                for node in self.nodes.values()
            ):
                raise ValueError("节点自有原文与角色不一致")
        owned_nodes = sorted(
            (node for node in self.nodes.values() if node.owned_segments),
            key=lambda node: self.index.position(
                node.owned_segments[0].start_block_id
            ),
        )
        content_nodes = [
            node.node_id
            for node in owned_nodes
            if node.owned_source_role == "content_source"
        ]
        structural_nodes = [
            node.node_id
            for node in owned_nodes
            if node.owned_source_role == "structural_context"
        ]
        return RegionTreeSnapshot(
            status=status,
            root_node_id=self.root_node_id,
            nodes=sorted(self.nodes.values(), key=lambda node: node.node_id),
            leaf_node_ids=[node.node_id for node in leaves],
            content_node_ids=content_nodes,
            structural_context_node_ids=structural_nodes,
            structure_check=self.structure_check,
            source_issues=self.source_issues.copy(),
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

    def _record_source_issues(self, issues: list[SourceIssue]) -> None:
        for issue in issues:
            key = tuple(issue.block_ids)
            if all(tuple(item.block_ids) != key for item in self.source_issues):
                self.source_issues.append(issue)


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

    async def calibrate_structure(self) -> None:
        if self.tree.snapshot().status != "frozen":
            return
        initial = self.tree.detect_structure_issues()
        known_source_blocks = {
            block_id
            for issue in self.tree.source_issues
            for block_id in issue.block_ids
        }
        repairable = [
            issue
            for issue in initial
            if not set(issue.block_ids) <= known_source_blocks
        ]
        if repairable:
            self.progress.report(
                "区域树·结构检查",
                f"发现 {len(repairable)} 个待复核的显式标题层级问题",
            )
            dismissed_targets = await self._repair_structure_issues(repairable)
        else:
            dismissed_targets = set()
        if self.tree.snapshot().status == "frozen":
            known_source_blocks = {
                block_id
                for issue in self.tree.source_issues
                for block_id in issue.block_ids
            }
            remaining = [
                issue
                for issue in self.tree.detect_structure_issues()
                if issue.target_node_id not in dismissed_targets
                and not set(issue.block_ids) <= known_source_blocks
            ]
        else:
            remaining = [
                issue
                for issue in initial
                if not set(issue.block_ids) <= known_source_blocks
            ]
        self.tree.set_structure_check(initial, remaining)
        for issue in remaining:
            self.tree.review(
                issue.target_node_id,
                f"结构检查未解决：{issue.reason}",
            )

    async def _repair_structure_issues(
        self,
        issues: list[StructureIssue],
    ) -> set[str]:
        targets = self._repair_targets(issues)
        if not targets:
            return set()
        self.progress.report("区域树·定点修复", f"开始复核 {len(targets)} 个子树")
        semaphore = asyncio.Semaphore(self.settings.max_parallel_regions)

        async def evaluate(
            target: tuple[str, list[StructureIssue]],
        ) -> DecisionResult[RepairDecision]:
            async with semaphore:
                return await self._evaluate_structure_repair(*target)

        raw = await asyncio.gather(
            *(evaluate(target) for target in targets),
            return_exceptions=True,
        )
        groups: list[WorkGroup] = []
        dismissed: set[str] = set()
        for (node_id, _), result in zip(targets, raw, strict=True):
            if isinstance(result, (DecisionResult, DecisionFailure)):
                self.tree.model_calls += result.model_calls
                self.tree.tool_calls += result.tool_calls
            if isinstance(result, BaseException):
                self.tree.review(node_id, f"{node_id} 定点修复失败：{result}")
                continue
            try:
                if isinstance(result.decision, KeepDecision):
                    dismissed.add(node_id)
                groups.extend(self.tree.calibrate(node_id, result.decision))
            except Exception as error:
                self.tree.review(node_id, f"{node_id} 应用定点修复失败：{error}")
        self._save(groups)
        await self._process_groups(groups)
        return dismissed

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

    async def _evaluate_structure_repair(
        self,
        node_id: str,
        issues: list[StructureIssue],
    ) -> DecisionResult[RepairDecision]:
        node = self.tree.nodes[node_id]
        left = self.index.position(node.start_block_id)
        right = self.index.position(node.end_block_id)
        boundary = self.settings.boundary_context_blocks
        return await _ask(
            model=self.model,
            system_prompt=STRUCTURE_REPAIR_SYSTEM_PROMPT,
            prompt=structure_repair_prompt(
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
            max_tool_calls=0,
            search=None,
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
        if isinstance(decision, (StopDecision, SplitDecision)):
            self.index.resolve_ownership(
                node.start_block_id,
                node.end_block_id,
                decision,
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
        if isinstance(decision, (StopDecision, SplitDecision)):
            self.index.resolve_ownership(
                node.start_block_id,
                node.end_block_id,
                decision,
            )

    def _repair_targets(
        self,
        issues: list[StructureIssue],
    ) -> list[tuple[str, list[StructureIssue]]]:
        ordered = sorted(
            issues,
            key=lambda issue: (
                self.tree.nodes[issue.target_node_id].depth,
                self.index.position(
                    self.tree.nodes[issue.target_node_id].start_block_id
                ),
            ),
        )
        targets: list[tuple[str, list[StructureIssue]]] = []
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
            role = (
                f"，自有原文={node.owned_source_role}"
                if node.owned_source_role
                else ""
            )
            owned = "、".join(
                f"{segment.start_block_id}～{segment.end_block_id}"
                for segment in node.owned_segments
            )
            lines.append(
                f"{'  ' * relative_depth}- {node.node_id}｜深度={node.depth}｜"
                f"{node.status}{role}｜第 {'、'.join(map(str, node.source_pages))} 页｜"
                f"{len(blocks)} 块｜{sum(len(block.markdown) for block in blocks)} 字符｜"
                f"{node.start_block_id}～{node.end_block_id}｜{node.label}"
            )
            lines.append(f"{'  ' * relative_depth}  介绍：{node.introduction}")
            if owned:
                lines.append(f"{'  ' * relative_depth}  自有范围：{owned}")
            if node.decision_reason:
                lines.append(
                    f"{'  ' * relative_depth}  判断理由：{node.decision_reason}"
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
        index.resolve_ownership(
            blocks[0].block_id,
            blocks[-1].block_id,
            decision,
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
    return RegionDecisionOutput.model_validate(_decision_payload(raw)).root


def _parse_repair(raw: str) -> RepairDecision:
    return RepairDecisionOutput.model_validate(_decision_payload(raw)).root


def _decision_payload(raw: str) -> dict[str, Any]:
    """解析主判断，并把来源诊断限制为独立、非阻塞的附属记录。"""

    payload = json.loads(_json_object(raw))
    if not isinstance(payload, dict):
        raise ValueError("模型输出的 JSON 顶层必须是对象")

    if payload.get("action") == "parent_partition_error":
        payload.pop("source_issues", None)
        return payload
    if "source_issues" not in payload:
        return payload

    raw_issues = payload.get("source_issues", [])
    valid_issues: list[dict[str, Any]] = []
    if isinstance(raw_issues, list):
        for raw_issue in raw_issues:
            try:
                issue = SourceIssue.model_validate(raw_issue)
            except (TypeError, ValidationError):
                continue
            valid_issues.append(issue.model_dump())
    payload["source_issues"] = valid_issues
    return payload


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
