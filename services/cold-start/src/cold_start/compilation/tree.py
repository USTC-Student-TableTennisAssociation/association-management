"""从所有内容来源节点向根节点逐层整合基础记忆。"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from cold_start.compilation.leaf import (
    MAX_PROTOCOL_REPAIRS,
    LeafArtifactPaths,
    LeafBasicCompiler,
    write_leaf_artifact,
)
from cold_start.compilation.missing_objects import MissingObjectRecoveryRunner
from cold_start.compilation.models import (
    FullCompilationSnapshot,
    MemoryPackage,
    MissingObjectRecoveryArtifact,
    NodeIntegrationResult,
    ParentIntegrationDecision,
    RegionCompilationArtifact,
    assertion_object_ids,
    object_assertion_ids,
    object_evidence_ids,
    package_warnings,
    render_statement,
)
from cold_start.compilation.operations import (
    apply_parent_decision,
    rebase_package,
    union_packages,
)
from cold_start.config import CompilationSettings
from cold_start.document.blocks import format_blocks
from cold_start.document.models import ParsedBlock
from cold_start.global_exploration.models import GlobalExplorationSnapshot
from cold_start.llm.base import ChatModel, ModelTurn
from cold_start.progress import NullProgressReporter, ProgressReporter
from cold_start.region_tree.models import RegionNode
from cold_start.region_tree.runtime import BlockIndex

PARENT_INTEGRATION_OUTPUT_PROTOCOL = """
你必须严格遵守以下父节点操作协议。顶层 JSON 只能包含 `object_merges`、
`assertion_merges`、`assertion_revisions` 三个数组；没有操作时对应数组为 `[]`。

`object_merges` 中每项只能包含：
- `object_ids`：至少两个现有 Object ID；
- `preferred_object_id`：必须是 object_ids 中的一个；
- `reason`：父节点为何能确认它们是同一对象。

`assertion_merges` 中每项只能包含：
- `assertion_ids`：至少两个现有 Assertion ID；
- `preferred_assertion_id`：必须是 assertion_ids 中的一个；
- `reason`：为何它们在对象、时间、条件、语气和结论上表达同一件事。

`assertion_revisions` 中每项只能包含：
- `assertion_id`：需要纠正的现有 Assertion ID；
- `mode`：只能是 `record` 或 `viewpoint`；
- `statement_template_markdown`：必须用 `{{object:现有对象ID}}` 引用对象；
- `holder_object_id`：仅 viewpoint 可以填写，record 必须为 `null`；
- `temporal_scope`：完整保留结构化时间对象 `kind`、`display`、`start`、`end`、
  `precision`、`confidence`；
- `temporal_basis_markdown`：时间判断依据；
- `uncertainty_markdown`：没有则为 `null`；
- `reason`：父节点原文如何证明原叙述需要纠正。

Assertion 漏标已有 Object 也使用 `assertion_revisions`：保持原命题、mode、时间对象、时间依据、
不确定性和观点持有者不变，只把正文中实际指向已有 Object 的字面名称替换成对应
`{{object:对象ID}}`。不要为此创建 Object，也不要补充新的事实或关系。

提交前必须逐项满足以下硬性校验：
- 所有 Object ID 和 Assertion ID 都必须来自本次输入包；
- 同一个 ID 最多只能出现在一个同类合并组中；
- 每个 preferred ID 必须包含在对应合并组内；
- 只有引用相同一组 Object、结构化时间完全相同的 Assertion 才允许合并；
- 修订后的模板至少引用一个现有 Object，holder 非空时也必须是现有 Object；
- 所有操作完成后，每个 Object 仍必须连接至少一条 Assertion，不能留下孤立对象；
- `record` 的 holder 必须为 `null`，所有可空字段不得使用空字符串；
- 不得省略规定字段，也不得增加协议外字段。

合法空操作示例：
{
  "object_merges": [],
  "assertion_merges": [],
  "assertion_revisions": []
}

最终正文只能是合法 JSON，不使用 Markdown 围栏，不增加其他字段，不用空字符串代替
`null`。
""".strip()

PARENT_INTEGRATION_SYSTEM_PROMPT = f"""
{PARENT_INTEGRATION_OUTPUT_PROTOCOL}

你在连续原文区域树中整合一个父节点。输入包已经包含所有直接孩子子树以及父节点自有
内容原文提取出的 Object、Assertion、Evidence。程序会无损保留所有输入；你只提交
少量、确定的对齐操作，不要重新输出完整记忆包。

本阶段仍然不建立 Relation，不按活动运营或其他业务视角连线，不给对象和叙述选择卡片
类型，也不判断长期价值。

你可以做三类操作：
1. object_merges：只有在父节点上下文和原文足以确认多个 ID 持续指向同一对象时合并，
   并从现有 ID 中选择表达最清楚的 preferred_object_id。相似活动、上下级工作、人物与
   角色、类别与实例不是同一对象。叙述正文中的 `{{object:对象ID}}` 会由程序自动改写为
   preferred_object_id，不要为改名或换 ID 提交 assertion_revisions。
2. assertion_merges：只有多条叙述在对象、结构化时间、条件、语气和结论上表达同一件事时
   合并，并选择现有 preferred_assertion_id。主题相近、互相补充、一般情况与具体实例、
   规则与历史实践不能因为相关而合并。
3. assertion_revisions：父节点上下文足以证明局部叙述误解了指代、范围、时间、观点归属，
   或漏标了输入包中已有 Object 时纠正。修订仍必须被该叙述原有 Evidence 支持，不能补充
   新的推论。修订的
   `statement_template_markdown` 必须继续用 `{{object:对象ID}}` 引用输入中的对象；名称
   本身是陈述内容时才在引号中保留字面值。不要输出 `statement_markdown` 或
   `about_object_ids`。

修订时间时必须同时提交完整 `temporal_scope` 和 `temporal_basis_markdown`。父节点可以用
明确的章节时期纠正局部的保守时间推断，但不能虚构精度；若不修改时间，原样提交两项。

不要删除独特信息，不要创建新对象或新叙述，不要传播实践的适用范围，不要解释不同
信息对业务意味着什么。逐项思考后严格按上述唯一协议输出 JSON；没有可靠操作时输出
三个空数组。
""".strip()


@dataclass(frozen=True)
class FullArtifactPaths:
    directory: Path
    model_streams: Path
    sources: Path
    nodes: Path
    snapshot_json: Path
    report_markdown: Path
    root_package_json: Path
    working_json: Path


def create_full_artifact_paths(run_directory: Path) -> FullArtifactPaths:
    directory = (
        run_directory.expanduser().resolve()
        / "basic-compilations"
        / f"{datetime.now(UTC):%Y%m%dT%H%M%S%fZ}-full"
    )
    directory.mkdir(parents=True, exist_ok=False)
    model_streams = directory / "model-streams"
    sources = directory / "sources"
    nodes = directory / "nodes"
    model_streams.mkdir()
    sources.mkdir()
    nodes.mkdir()
    return FullArtifactPaths(
        directory=directory,
        model_streams=model_streams,
        sources=sources,
        nodes=nodes,
        snapshot_json=directory / "basic-compilation.json",
        report_markdown=directory / "basic-compilation.md",
        root_package_json=directory / "root-package.json",
        working_json=directory / "working.json",
    )


def open_full_artifact_paths(directory: Path) -> FullArtifactPaths:
    """打开一次未完成的完整基础编译目录，用于复用已落盘的来源结果。"""

    resolved = directory.expanduser().resolve()
    if not resolved.is_dir():
        raise ValueError("--resume 必须指向已有的完整基础编译目录")
    model_streams = resolved / "model-streams"
    sources = resolved / "sources"
    nodes = resolved / "nodes"
    if not model_streams.is_dir() or not sources.is_dir() or not nodes.is_dir():
        raise ValueError("恢复目录缺少 model-streams、sources 或 nodes")
    if (resolved / "basic-compilation.json").is_file():
        raise ValueError("该完整基础编译已经完成，不需要恢复")
    return FullArtifactPaths(
        directory=resolved,
        model_streams=model_streams,
        sources=sources,
        nodes=nodes,
        snapshot_json=resolved / "basic-compilation.json",
        report_markdown=resolved / "basic-compilation.md",
        root_package_json=resolved / "root-package.json",
        working_json=resolved / "working.json",
    )


class FullBasicCompilationRunner:
    """先编译全部内容来源，再按深度从叶子整合到根节点。"""

    def __init__(
        self,
        *,
        model: ChatModel,
        exploration: GlobalExplorationSnapshot,
        blocks: tuple[ParsedBlock, ...],
        paths: FullArtifactPaths,
        settings: CompilationSettings | None = None,
        progress: ProgressReporter | None = None,
    ) -> None:
        self.model = model
        self.exploration = exploration
        self.blocks = blocks
        self.paths = paths
        self.settings = settings or CompilationSettings()
        self.progress = progress or NullProgressReporter()
        self.index = BlockIndex(blocks)
        self.nodes = {node.node_id: node for node in exploration.region_tree.nodes}
        self.source_compiler = LeafBasicCompiler(
            model=model,
            exploration=exploration,
            blocks=blocks,
            progress=self.progress,
        )
        self.missing_object_recovery = MissingObjectRecoveryRunner(
            model=model,
            progress=self.progress,
        )
        self.source_artifacts: dict[str, RegionCompilationArtifact] = {}
        self.source_packages: dict[str, MemoryPackage] = {}
        self.packages: dict[str, MemoryPackage] = {}
        self.results: dict[str, NodeIntegrationResult] = {}
        self.missing_object_artifacts: dict[str, MissingObjectRecoveryArtifact] = {}

    async def run(self) -> FullCompilationSnapshot:
        tree = self.exploration.region_tree
        if tree.status != "frozen":
            raise ValueError("区域树尚未冻结，不能开始完整基础编译")
        source_ids = [
            node_id
            for node_id in tree.content_node_ids
            if self.nodes[node_id].owned_source_role == "content_source"
        ]
        self._load_completed_sources(source_ids)
        pending_source_ids = [
            node_id for node_id in source_ids if node_id not in self.source_packages
        ]
        self.progress.report(
            "完整基础编译",
            (
                f"阶段 1/2：来源共 {len(source_ids)} 个，复用已完成 "
                f"{len(self.source_packages)} 个，待提取 {len(pending_source_ids)} 个；"
                f"并发上限 {self.settings.max_parallel_sources}"
            ),
        )
        await self._compile_sources(pending_source_ids)
        self._initialize_leaf_packages()

        branches = [node for node in self.nodes.values() if node.child_ids]
        depths = sorted({node.depth for node in branches}, reverse=True)
        self.progress.report(
            "完整基础编译",
            (
                f"阶段 2/2：整合 {len(branches)} 个父节点；"
                f"并发上限 {self.settings.max_parallel_parents}"
            ),
        )
        for depth in depths:
            parents = sorted(
                (node for node in branches if node.depth == depth),
                key=lambda node: self.index.position(node.start_block_id),
            )
            await self._integrate_depth(parents)

        root_id = tree.root_node_id
        if root_id not in self.packages:
            self.packages[root_id] = self.source_packages.get(root_id, MemoryPackage())
            self._record_leaf_result(self.nodes[root_id], self.packages[root_id])
            self._write_node_package(root_id, self.packages[root_id])

        snapshot = self._snapshot(self.packages[root_id])
        write_full_artifacts(self.paths, snapshot)
        self.progress.report(
            "完整基础编译",
            (
                f"完成：根包对象 {len(snapshot.root_package.objects)}，"
                f"叙述 {len(snapshot.root_package.assertions)}，"
                f"原文覆盖 {len(snapshot.covered_block_ids)}/"
                f"{len(snapshot.content_source_block_ids)}，"
                f"模型调用 {snapshot.model_calls} 次"
            ),
        )
        return snapshot

    def _load_completed_sources(self, source_ids: Sequence[str]) -> None:
        expected = set(source_ids)
        for snapshot_path in sorted(self.paths.sources.glob("*/source-compilation.json")):
            artifact = RegionCompilationArtifact.model_validate_json(
                snapshot_path.read_text(encoding="utf-8")
            )
            node_id = artifact.region_node_id
            if node_id not in expected:
                raise ValueError(f"恢复目录包含当前区域树之外的来源节点：{node_id}")
            if artifact.source.sha256 != self.exploration.source.sha256:
                raise ValueError(f"恢复来源 {node_id} 属于另一份文档")
            if artifact.region_tree_schema_version != self.exploration.region_tree.schema_version:
                raise ValueError(f"恢复来源 {node_id} 使用了不同的区域树协议")
            self.source_artifacts[node_id] = artifact
            self.source_packages[node_id] = rebase_package(artifact.package, node_id)

    async def _compile_sources(self, source_ids: list[str]) -> None:
        semaphore = asyncio.Semaphore(self.settings.max_parallel_sources)

        async def compile_one(position: int, node_id: str) -> None:
            async with semaphore:
                self.progress.report(
                    "基础来源",
                    f"开始 {position}/{len(source_ids)}：{node_id}",
                )
                artifact = await self.source_compiler.compile_owned_source(node_id)
            package = rebase_package(artifact.package, node_id)
            self.source_artifacts[node_id] = artifact
            self.source_packages[node_id] = package
            self._write_source_artifact(artifact)
            self._checkpoint()

        outcomes = await asyncio.gather(
            *(
                compile_one(position, node_id)
                for position, node_id in enumerate(source_ids, start=1)
            ),
            return_exceptions=True,
        )
        failures = [
            f"{node_id}：{outcome}"
            for node_id, outcome in zip(source_ids, outcomes, strict=True)
            if isinstance(outcome, BaseException)
        ]
        if failures:
            raise RuntimeError("基础来源编译失败：" + "；".join(failures))

    def _initialize_leaf_packages(self) -> None:
        for leaf_id in self.exploration.region_tree.leaf_node_ids:
            package = self.source_packages.get(leaf_id, MemoryPackage())
            self.packages[leaf_id] = package
            self._record_leaf_result(self.nodes[leaf_id], package)
            self._write_node_package(leaf_id, package)
        self._checkpoint()

    async def _integrate_depth(self, parents: list[RegionNode]) -> None:
        semaphore = asyncio.Semaphore(self.settings.max_parallel_parents)

        async def integrate_one(position: int, parent: RegionNode) -> None:
            async with semaphore:
                self.progress.report(
                    f"父节点整合·{parent.node_id}",
                    f"开始本层 {position}/{len(parents)}：{parent.label}",
                )
                (
                    package,
                    integration_calls,
                    input_package,
                    recovery_artifact,
                ) = await self._integrate_parent(parent)
            self.packages[parent.node_id] = package
            self.missing_object_artifacts[parent.node_id] = recovery_artifact
            source_calls = self.source_artifacts.get(parent.node_id)
            warnings = package_warnings(package)
            self.results[parent.node_id] = NodeIntegrationResult(
                node_id=parent.node_id,
                label=parent.label,
                depth=parent.depth,
                child_ids=parent.child_ids,
                source_compiled=parent.node_id in self.source_packages,
                input_object_count=len(input_package.objects),
                output_object_count=len(package.objects),
                input_assertion_count=len(input_package.assertions),
                output_assertion_count=len(package.assertions),
                source_model_calls=source_calls.model_calls if source_calls else 0,
                integration_model_calls=integration_calls,
                missing_object_model_calls=recovery_artifact.model_calls,
                recovered_object_count=len(recovery_artifact.created_object_ids),
                warnings=warnings,
            )
            self._write_node_package(parent.node_id, package)
            self._write_missing_object_artifact(recovery_artifact)
            self._checkpoint()
            self.progress.report(
                f"父节点整合·{parent.node_id}",
                (
                    f"完成：对象 {len(input_package.objects)} → {len(package.objects)}，"
                    f"叙述 {len(input_package.assertions)} → {len(package.assertions)}，"
                    f"恢复缺失对象 {len(recovery_artifact.created_object_ids)} 个"
                ),
            )

        outcomes = await asyncio.gather(
            *(
                integrate_one(position, parent)
                for position, parent in enumerate(parents, start=1)
            ),
            return_exceptions=True,
        )
        failures = [
            f"{parent.node_id}：{outcome}"
            for parent, outcome in zip(parents, outcomes, strict=True)
            if isinstance(outcome, BaseException)
        ]
        if failures:
            raise RuntimeError("父节点整合失败：" + "；".join(failures))

    async def _integrate_parent(
        self,
        parent: RegionNode,
    ) -> tuple[
        MemoryPackage,
        int,
        MemoryPackage,
        MissingObjectRecoveryArtifact,
    ]:
        input_package = union_packages(
            [
                *(self.packages[child_id] for child_id in parent.child_ids),
                self.source_packages.get(parent.node_id, MemoryPackage()),
            ]
        )
        if not input_package.objects and not input_package.assertions:
            artifact = MissingObjectRecoveryArtifact(
                node_id=parent.node_id,
                discovery={"candidates": []},
                review={"decisions": []},
                created_object_ids=[],
                model_calls=0,
            )
            return input_package, 0, input_package, artifact

        messages: list[Mapping[str, Any]] = [
            {"role": "system", "content": PARENT_INTEGRATION_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": self._parent_prompt(parent, input_package),
            },
        ]
        label = f"父节点整合·{parent.node_id}"
        turn = await self.model.complete_turn(
            messages=messages,
            request_label=label,
            thinking="enabled",
        )
        calls = 1
        repairs = 0
        conversation = messages
        integrated_package: MemoryPackage | None = None
        while True:
            try:
                decision = self._parse_parent_decision(turn)
                integrated_package = apply_parent_decision(input_package, decision)
                break
            except (ValidationError, ValueError, json.JSONDecodeError) as error:
                failure_kind = _failure_kind(error)
                if repairs >= MAX_PROTOCOL_REPAIRS:
                    raise
                repairs += 1
                self.progress.report(
                    label,
                    (
                        f"{failure_kind} 校验失败，进行第 {repairs}/"
                        f"{MAX_PROTOCOL_REPAIRS} 次定向修复：{error}"
                    ),
                )
                conversation = _parent_repair_messages(conversation, turn, error)
                turn = await self.model.complete_turn(
                    messages=conversation,
                    request_label=f"{label}·修复{repairs}",
                    thinking="enabled",
                )
                calls += 1

        assert integrated_package is not None
        evidence_text_by_id = self._evidence_text_by_id(integrated_package)
        recovery = await self.missing_object_recovery.run(
            node_id=parent.node_id,
            context_markdown=self._parent_context(parent),
            package=integrated_package,
            evidence_text_by_id=evidence_text_by_id,
        )
        return recovery.package, calls, input_package, recovery.artifact

    def _parse_parent_decision(self, turn: ModelTurn) -> ParentIntegrationDecision:
        if turn.tool_calls:
            raise ValueError("父节点整合必须返回正文 JSON，不能调用工具")
        return ParentIntegrationDecision.model_validate_json(_json_object(turn.content))

    def _parent_prompt(self, parent: RegionNode, package: MemoryPackage) -> str:
        context = self._parent_context(parent)
        knowledge = {
            "objects": [item.model_dump() for item in package.objects],
            "assertions": [item.model_dump() for item in package.assertions],
            "possible_missing_object_references": self._reference_candidates(
                package
            ),
        }
        return f"""
[STAGE: integrate_basic_memory_parent]

{context}

待整合对象和叙述：
{json.dumps(knowledge, ensure_ascii=False, indent=2)}

各项 Evidence 对应的原文：
{self._evidence_text(package)}

`possible_missing_object_references` 只按现有 Object 的 label/alias 与模板字面匹配生成，
只是复核候选，不代表一定需要补充。逐项排除同名歧义、名称被当作文字讨论和普通词误命中；
确认命题确实以该 Object 为参与者时，使用 assertion_revisions 保持原命题不变并补入引用。

分析哪些对象合并、重复叙述合并、引用补全和必要纠正可靠，输出完整 JSON 操作对象。
不要建立任何连接；这里只纠正基础 Assertion 本身。
""".strip()

    def _parent_context(self, parent: RegionNode) -> str:
        lineage = self._lineage(parent)
        path = "\n".join(
            f"- {node.node_id}｜{node.label}：{node.introduction}"
            for node in [*lineage, parent]
        )
        children = "\n".join(
            f"- {child.node_id}｜{child.label}：{child.introduction}"
            for child in (self.nodes[value] for value in parent.child_ids)
        ) or "无直接孩子。"
        structural_blocks = self._owned_blocks(parent, role="structural_context")
        structural = format_blocks(structural_blocks) if structural_blocks else "无。"
        return f"""
文档背景（低权威）：
{self.exploration.document_context_markdown}

根节点到当前父节点的路径：
{path}

直接孩子：
{children}

父节点直接拥有的结构性原文（只用于消歧）：
{structural}
""".strip()

    @staticmethod
    def _reference_candidates(package: MemoryPackage) -> list[dict[str, object]]:
        result = []
        for assertion in package.assertions:
            template = assertion.statement_template_markdown.casefold()
            referenced = set(assertion_object_ids(assertion))
            candidates = []
            for item in package.objects:
                if item.object_id in referenced:
                    continue
                names = [item.label, *item.aliases]
                if any(name.casefold() in template for name in names if name.strip()):
                    candidates.append(
                        {
                            "object_id": item.object_id,
                            "label": item.label,
                            "aliases": item.aliases,
                        }
                    )
            if candidates:
                result.append(
                    {
                        "assertion_id": assertion.assertion_id,
                        "candidate_objects": candidates,
                    }
                )
        return result

    def _evidence_text(self, package: MemoryPackage) -> str:
        grouped: dict[tuple[str, str], list[str]] = {}
        for evidence in package.evidence:
            grouped.setdefault(
                (evidence.start_block_id, evidence.end_block_id),
                [],
            ).append(evidence.evidence_id)
        parts: list[str] = []
        for (start_block_id, end_block_id), evidence_ids in grouped.items():
            parts.append(
                f"### {', '.join(evidence_ids)}\n"
                + format_blocks(
                    self.index.slice(
                        start_block_id,
                        end_block_id,
                    )
                )
            )
        return "\n\n".join(parts) or "无。"

    def _evidence_text_by_id(self, package: MemoryPackage) -> dict[str, str]:
        return {
            evidence.evidence_id: format_blocks(
                self.index.slice(evidence.start_block_id, evidence.end_block_id)
            )
            for evidence in package.evidence
        }

    def _lineage(self, node: RegionNode) -> list[RegionNode]:
        result: list[RegionNode] = []
        parent_id = node.parent_id
        while parent_id:
            parent = self.nodes[parent_id]
            result.append(parent)
            parent_id = parent.parent_id
        return list(reversed(result))

    def _owned_blocks(
        self,
        node: RegionNode,
        *,
        role: str,
    ) -> tuple[ParsedBlock, ...]:
        if node.owned_source_role != role:
            return ()
        blocks: list[ParsedBlock] = []
        for segment in node.owned_segments:
            blocks.extend(self.index.slice(segment.start_block_id, segment.end_block_id))
        return tuple(blocks)

    def _record_leaf_result(self, node: RegionNode, package: MemoryPackage) -> None:
        source = self.source_artifacts.get(node.node_id)
        self.results[node.node_id] = NodeIntegrationResult(
            node_id=node.node_id,
            label=node.label,
            depth=node.depth,
            child_ids=node.child_ids,
            source_compiled=node.node_id in self.source_packages,
            input_object_count=len(package.objects),
            output_object_count=len(package.objects),
            input_assertion_count=len(package.assertions),
            output_assertion_count=len(package.assertions),
            source_model_calls=source.model_calls if source else 0,
            integration_model_calls=0,
            warnings=package_warnings(package),
        )

    def _write_source_artifact(self, artifact: RegionCompilationArtifact) -> None:
        directory = self.paths.sources / artifact.region_node_id
        directory.mkdir(exist_ok=True)
        write_leaf_artifact(
            LeafArtifactPaths(
                directory=directory,
                snapshot_json=directory / "source-compilation.json",
                report_markdown=directory / "source-compilation.md",
                model_streams=self.paths.model_streams,
            ),
            artifact,
            self.blocks,
        )

    def _write_node_package(self, node_id: str, package: MemoryPackage) -> None:
        (self.paths.nodes / f"{node_id}.json").write_text(
            package.model_dump_json(indent=2),
            encoding="utf-8",
        )

    def _write_missing_object_artifact(
        self,
        artifact: MissingObjectRecoveryArtifact,
    ) -> None:
        (self.paths.nodes / f"{artifact.node_id}.missing-objects.json").write_text(
            artifact.model_dump_json(indent=2),
            encoding="utf-8",
        )

    def _checkpoint(self) -> None:
        self.paths.working_json.write_text(
            json.dumps(
                {
                    "source_node_ids": sorted(self.source_packages),
                    "integrated_node_ids": sorted(self.packages),
                    "node_results": [
                        self.results[node_id].model_dump()
                        for node_id in sorted(self.results)
                    ],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    def _snapshot(self, root_package: MemoryPackage) -> FullCompilationSnapshot:
        content_ids = [
            block_id
            for artifact in self.source_artifacts.values()
            for block_id in artifact.source_block_ids
        ]
        covered = {
            block.block_id
            for evidence in root_package.evidence
            for block in self.index.slice(
                evidence.start_block_id,
                evidence.end_block_id,
            )
        }
        structural_ids = [
            block.block_id
            for node in self.nodes.values()
            if node.owned_source_role == "structural_context"
            for segment in node.owned_segments
            for block in self.index.slice(segment.start_block_id, segment.end_block_id)
        ]
        content_ids = sorted(set(content_ids), key=self.index.position)
        covered_ids = [value for value in content_ids if value in covered]
        uncovered_ids = [value for value in content_ids if value not in covered]
        warnings = package_warnings(root_package)
        if uncovered_ids:
            warnings.append(
                "以下 content_source 原文块在根包中没有 Evidence："
                + ", ".join(uncovered_ids)
            )
        ordered_results = sorted(
            self.results.values(),
            key=lambda item: (
                -item.depth,
                self.index.position(self.nodes[item.node_id].start_block_id),
            ),
        )
        return FullCompilationSnapshot(
            created_at=datetime.now(UTC),
            source=self.exploration.source,
            region_tree_schema_version=self.exploration.region_tree.schema_version,
            root_node_id=self.exploration.region_tree.root_node_id,
            root_package=root_package,
            node_results=ordered_results,
            content_source_block_ids=content_ids,
            covered_block_ids=covered_ids,
            uncovered_block_ids=uncovered_ids,
            structural_context_block_ids=sorted(
                set(structural_ids),
                key=self.index.position,
            ),
            model_calls=sum(
                item.model_calls for item in ordered_results
            ),
            warnings=warnings,
        )


def _parent_repair_messages(
    original: Sequence[Mapping[str, Any]],
    turn: ModelTurn,
    error: Exception,
) -> list[Mapping[str, Any]]:
    messages = [*original, turn.as_assistant_message()]
    messages.append(
        {
            "role": "user",
            "content": (
                "程序拒绝了上一次正文 JSON。这是协议修复，不是重新分析父节点：保留"
                "原操作意图，只做最小修改。即使当前只报告 JSON 语法错误，修复后也要"
                "逐字段对照系统消息中的父节点操作协议。重新输出包含 object_merges、"
                "assertion_merges、assertion_revisions 三个数组的完整 JSON，不能只"
                f"输出补丁。程序错误：{error}"
            ),
        }
    )
    return messages


def _json_object(raw: str) -> str:
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end < start:
        raise ValueError("模型正文中不存在 JSON 对象")
    return raw[start : end + 1]


def _failure_kind(error: Exception) -> str:
    if isinstance(error, json.JSONDecodeError):
        return "json"
    if isinstance(error, ValidationError) and any(
        item["type"] == "json_invalid" for item in error.errors()
    ):
        return "json"
    if isinstance(error, ValueError) and "不存在 JSON 对象" in str(error):
        return "json"
    return "protocol"


def write_full_artifacts(
    paths: FullArtifactPaths,
    snapshot: FullCompilationSnapshot,
) -> None:
    paths.snapshot_json.write_text(snapshot.model_dump_json(indent=2), encoding="utf-8")
    paths.root_package_json.write_text(
        snapshot.root_package.model_dump_json(indent=2),
        encoding="utf-8",
    )
    paths.report_markdown.write_text(_full_report(snapshot), encoding="utf-8")


def _full_report(snapshot: FullCompilationSnapshot) -> str:
    package = snapshot.root_package
    objects_by_id = {item.object_id: item for item in package.objects}
    lines = [
        "# 完整基础编译",
        "",
        f"> 根节点：`{snapshot.root_node_id}`",
        f"> 对象：{len(package.objects)}",
        f"> 叙述：{len(package.assertions)}",
        f"> 依据：{len(package.evidence)}",
        f"> content_source 覆盖：{len(snapshot.covered_block_ids)}/"
        f"{len(snapshot.content_source_block_ids)}",
        f"> 模型调用：{snapshot.model_calls}",
        "",
        "## 警告",
        "",
        *(f"- {warning}" for warning in snapshot.warnings),
        *([] if snapshot.warnings else ["无。"]),
        "",
        "## 节点处理",
        "",
    ]
    lines.extend(
        f"- `{item.node_id}` {item.label}：对象 "
        f"{item.input_object_count} → {item.output_object_count}，叙述 "
        f"{item.input_assertion_count} → {item.output_assertion_count}，"
        f"缺失对象 {item.recovered_object_count}，模型调用 "
        f"{item.model_calls}"
        for item in snapshot.node_results
    )
    lines.extend(["", "## 根包对象", ""])
    lines.extend(
        f"- `{item.object_id}` **{item.label}**｜关联叙述 "
        f"{', '.join(object_assertion_ids(package, item.object_id))}｜间接依据 "
        f"{', '.join(object_evidence_ids(package, item.object_id))}"
        for item in package.objects
    )
    if not package.objects:
        lines.append("无。")
    lines.extend(["", "## 根包叙述", ""])
    for item in package.assertions:
        lines.append(
            f"- `{item.assertion_id}`｜{item.mode}｜"
            f"{render_statement(item, objects_by_id)}｜"
            f"对象 {', '.join(item.referenced_object_ids)}｜"
            f"依据 {', '.join(item.evidence_ids)}"
        )
        lines.append(f"  - 模板：`{item.statement_template_markdown}`")
    if not package.assertions:
        lines.append("无。")
    return "\n".join(lines).rstrip() + "\n"
