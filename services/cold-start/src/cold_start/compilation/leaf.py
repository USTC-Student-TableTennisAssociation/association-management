"""指定内容叶子的对象—陈述局部编译。"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from cold_start.compilation.models import MemoryPackage, RegionCompilationArtifact
from cold_start.document.blocks import format_blocks
from cold_start.document.models import ParsedBlock
from cold_start.global_exploration.models import GlobalExplorationSnapshot
from cold_start.llm.base import ChatModel, ModelTurn
from cold_start.progress import NullProgressReporter, ProgressReporter
from cold_start.region_tree.models import RegionNode
from cold_start.region_tree.runtime import BlockIndex

SUBMIT_TOOL_NAME = "submit_memory_package"
SUBMIT_MEMORY_PACKAGE_TOOL: tuple[dict[str, object], ...] = (
    {
        "type": "function",
        "function": {
            "name": SUBMIT_TOOL_NAME,
            "description": "提交当前叶子的对象、陈述、关系、依据和未决项。",
            "parameters": MemoryPackage.model_json_schema(),
        },
    },
)
FORCED_SUBMIT_TOOL = {
    "type": "function",
    "function": {"name": SUBMIT_TOOL_NAME},
}

LEAF_COMPILATION_SYSTEM_PROMPT = """
你在把一段协会文档原文编译为局部记忆中间包，不是在总结、评价重要性或套用固定卡片。
只有带 block_id 的当前叶子原文是事实依据；文档背景和区域路径只帮助消歧，不能作为
新事实来源。

中间包只有四种知识成分：
1. Object：能够在后续被持续指认的对象，例如协会、活动、人物、角色、工作单元、
   档案或概念。原文明确提到的人物可以成为对象，不需要先通过“是否足够重要”筛选。
   kind_hints 只是当前局部的候选，不确定时使用 unknown，不要为了归类而改变原意。
2. Assertion：来源对一个或多个对象作出的陈述。record 表示原文记录存在、状态、事件、
   实践、后果或正式规范；viewpoint 表示某人或组织的解释、评价、建议、目标或方案。
   记录允许不完整，原文没写时间、原因、结果时保持空缺，严禁补全逻辑闭环。
3. Relation：来源明确支持的对象连接。关系可以为零；不要因为两个对象同时出现就连线。
   workflow 和 work step 在对象层统一视为 work_unit，是否为上级、下级或前后步骤由
   contains、next 等关系表达。predicate 使用简短 snake_case 英文临时谓词。
4. Evidence：对象识别、陈述或关系所依据的当前叶子连续原文块范围。

Unresolved 只是编译过程中的未决问题，不是第五种知识。仅当当前原文确实无法判断对象
同一性、类型、陈述范围、观点持有者或关系时记录，留给父节点继续处理。不要把普通的
省略信息全部变成未决项。

区分对象与陈述：对象是被持续指认的“东西”，状态、做法、规则、目标和评价通常是关于
对象的陈述，不要把每一句话都实体化。区分记录与观点：原文写下一个历史状态不等于
作者赞成它；作者提出未来方向也不等于已经成为组织正式原则。

每个对象、陈述和关系必须引用 evidence_ids。依据范围必须位于当前叶子内。不要输出
分析正文；完成判断后只调用 submit_memory_package 一次。
""".strip()


@dataclass(frozen=True)
class LeafArtifactPaths:
    directory: Path
    snapshot_json: Path
    report_markdown: Path
    model_streams: Path


class LeafObjectCompiler:
    """一次只编译一个指定叶子，便于先验证真实提取质量。"""

    def __init__(
        self,
        *,
        model: ChatModel,
        exploration: GlobalExplorationSnapshot,
        blocks: tuple[ParsedBlock, ...],
        progress: ProgressReporter | None = None,
    ) -> None:
        self.model = model
        self.exploration = exploration
        self.blocks = blocks
        self.index = BlockIndex(blocks)
        self.progress = progress or NullProgressReporter()
        self.nodes = {node.node_id: node for node in exploration.region_tree.nodes}

    async def compile(self, leaf_node_id: str) -> RegionCompilationArtifact:
        leaf = self._leaf(leaf_node_id)
        source_blocks = self.index.slice(leaf.start_block_id, leaf.end_block_id)
        lineage = self._lineage(leaf)
        prompt = _leaf_prompt(
            document_context=self.exploration.document_context_markdown,
            lineage=lineage,
            leaf=leaf,
            blocks=source_blocks,
        )
        messages: list[Mapping[str, Any]] = [
            {"role": "system", "content": LEAF_COMPILATION_SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ]
        label = f"对象编译·{leaf.node_id}"
        self.progress.report(label, f"开始：{leaf.label}")

        first = await self.model.complete_turn(
            messages=messages,
            tools=SUBMIT_MEMORY_PACKAGE_TOOL,
            tool_choice=FORCED_SUBMIT_TOOL,
            request_label=label,
            thinking="enabled",
        )
        model_calls = 1
        try:
            package = self._parse(first, leaf)
        except (ValidationError, ValueError, json.JSONDecodeError) as error:
            self.progress.report(label, f"首次提交校验失败，进行一次定向修复：{error}")
            repair = await self.model.complete_turn(
                messages=_repair_messages(messages, first, error),
                tools=SUBMIT_MEMORY_PACKAGE_TOOL,
                tool_choice=FORCED_SUBMIT_TOOL,
                request_label=f"{label}·修复",
                thinking="disabled",
            )
            model_calls += 1
            package = self._parse(repair, leaf)

        self.progress.report(
            label,
            (
                f"完成：对象 {len(package.objects)}，陈述 {len(package.assertions)}，"
                f"关系 {len(package.relations)}，未决 {len(package.unresolved)}"
            ),
        )
        return RegionCompilationArtifact(
            created_at=datetime.now(UTC),
            source=self.exploration.source,
            region_tree_schema_version=self.exploration.region_tree.schema_version,
            region_node_id=leaf.node_id,
            label=leaf.label,
            lineage_node_ids=[item.node_id for item in lineage],
            start_block_id=leaf.start_block_id,
            end_block_id=leaf.end_block_id,
            source_pages=leaf.source_pages,
            package=package,
            model_calls=model_calls,
        )

    def _leaf(self, node_id: str) -> RegionNode:
        if node_id not in self.nodes:
            raise ValueError(f"区域树中不存在节点 {node_id}")
        node = self.nodes[node_id]
        if node.status != "leaf":
            raise ValueError(f"{node_id} 不是叶子节点")
        if node.owned_source_role != "content_source":
            raise ValueError(f"{node_id} 不是内容来源叶子")
        return node

    def _lineage(self, node: RegionNode) -> list[RegionNode]:
        lineage: list[RegionNode] = []
        parent_id = node.parent_id
        while parent_id:
            parent = self.nodes[parent_id]
            lineage.append(parent)
            parent_id = parent.parent_id
        return list(reversed(lineage))

    def _parse(self, turn: ModelTurn, leaf: RegionNode) -> MemoryPackage:
        if len(turn.tool_calls) != 1:
            raise ValueError(
                f"模型必须调用 {SUBMIT_TOOL_NAME} 一次，实际 {len(turn.tool_calls)} 次"
            )
        call = turn.tool_calls[0]
        if call.name != SUBMIT_TOOL_NAME:
            raise ValueError(f"模型调用了未知工具 {call.name}")
        package = MemoryPackage.model_validate(json.loads(call.arguments))
        self._validate_evidence_ranges(package, leaf)
        return package

    def _validate_evidence_ranges(
        self,
        package: MemoryPackage,
        leaf: RegionNode,
    ) -> None:
        leaf_left = self.index.position(leaf.start_block_id)
        leaf_right = self.index.position(leaf.end_block_id)
        for evidence in package.evidence:
            left = self.index.position(evidence.start_block_id)
            right = self.index.position(evidence.end_block_id)
            if right < left or left < leaf_left or right > leaf_right:
                raise ValueError(
                    f"依据 {evidence.evidence_id} 超出当前叶子范围："
                    f"{evidence.start_block_id} → {evidence.end_block_id}"
                )


def load_exploration_inputs(
    run_directory: Path,
) -> tuple[GlobalExplorationSnapshot, tuple[ParsedBlock, ...]]:
    directory = run_directory.expanduser().resolve()
    snapshot_path = directory / "global-exploration.json"
    blocks_path = directory / "parsed-blocks.json"
    if not snapshot_path.is_file() or not blocks_path.is_file():
        raise ValueError("运行目录缺少 global-exploration.json 或 parsed-blocks.json")
    exploration = GlobalExplorationSnapshot.model_validate_json(
        snapshot_path.read_text(encoding="utf-8")
    )
    raw_blocks = json.loads(blocks_path.read_text(encoding="utf-8"))
    blocks = tuple(ParsedBlock.model_validate(item) for item in raw_blocks)
    if len(blocks) != exploration.source.block_count:
        raise ValueError("parsed-blocks.json 与全局勘探快照的块数量不一致")
    return exploration, blocks


def create_leaf_artifact_paths(
    run_directory: Path,
    leaf_node_id: str,
) -> LeafArtifactPaths:
    directory = (
        run_directory.expanduser().resolve()
        / "object-compilations"
        / f"{datetime.now(UTC):%Y%m%dT%H%M%S%fZ}-{leaf_node_id}"
    )
    directory.mkdir(parents=True, exist_ok=False)
    model_streams = directory / "model-streams"
    model_streams.mkdir()
    return LeafArtifactPaths(
        directory=directory,
        snapshot_json=directory / "region-compilation.json",
        report_markdown=directory / "region-compilation.md",
        model_streams=model_streams,
    )


def write_leaf_artifact(
    paths: LeafArtifactPaths,
    artifact: RegionCompilationArtifact,
) -> None:
    paths.snapshot_json.write_text(
        artifact.model_dump_json(indent=2),
        encoding="utf-8",
    )
    paths.report_markdown.write_text(_render_artifact(artifact), encoding="utf-8")


def _leaf_prompt(
    *,
    document_context: str,
    lineage: Sequence[RegionNode],
    leaf: RegionNode,
    blocks: tuple[ParsedBlock, ...],
) -> str:
    path = "\n".join(
        f"- {item.node_id}｜{item.label}：{item.introduction}"
        for item in [*lineage, leaf]
    )
    return f"""
[STAGE: compile_object_assertion_leaf]

文档背景（低权威上下文）：
{document_context}

根节点到当前叶子的区域路径（低权威上下文）：
{path}

当前叶子范围：{leaf.start_block_id} → {leaf.end_block_id}

当前叶子完整原文（唯一事实依据）：
{format_blocks(blocks)}

先识别可持续指认的对象，再记录原文对对象作出的陈述，最后只添加原文明示或必然支持
的对象关系。不要把区域节点本身当成对象，不要生成数据库 ID。临时 ID 分别使用
obj-1、assert-1、rel-1、evidence-1、unresolved-1 形式。完成后只调用
submit_memory_package。
""".strip()


def _repair_messages(
    original: Sequence[Mapping[str, Any]],
    turn: ModelTurn,
    error: Exception,
) -> list[Mapping[str, Any]]:
    messages = [*original, turn.as_assistant_message()]
    if turn.tool_calls:
        for call in turn.tool_calls:
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": json.dumps(
                        {"accepted": False, "validation_error": str(error)},
                        ensure_ascii=False,
                    ),
                }
            )
    messages.append(
        {
            "role": "user",
            "content": (
                "程序拒绝了上一次提交。只修复校验错误，不增加原文没有的信息；"
                f"重新调用 {SUBMIT_TOOL_NAME} 一次。错误：{error}"
            ),
        }
    )
    return messages


def _render_artifact(artifact: RegionCompilationArtifact) -> str:
    package = artifact.package
    lines = [
        f"# {artifact.label}",
        "",
        f"> 区域：`{artifact.region_node_id}`",
        f"> 原文：`{artifact.start_block_id}` → `{artifact.end_block_id}`",
        f"> 模型调用：{artifact.model_calls}",
        "",
        "## 对象",
        "",
    ]
    lines.extend(
        f"- `{item.object_id}` **{item.label}**｜{', '.join(item.kind_hints)}｜"
        f"依据 {', '.join(item.evidence_ids)}"
        for item in package.objects
    )
    if not package.objects:
        lines.append("无。")
    lines.extend(["", "## 陈述", ""])
    lines.extend(
        f"- `{item.assertion_id}`｜{item.mode}"
        f"{f'/{item.kind_hint}' if item.kind_hint else ''}｜{item.statement_markdown}｜"
        f"对象 {', '.join(item.about_object_ids)}｜依据 {', '.join(item.evidence_ids)}"
        for item in package.assertions
    )
    if not package.assertions:
        lines.append("无。")
    lines.extend(["", "## 关系", ""])
    lines.extend(
        f"- `{item.relation_id}`：`{item.from_object_id}` —{item.predicate}→ "
        f"`{item.to_object_id}`｜依据 {', '.join(item.evidence_ids)}"
        for item in package.relations
    )
    if not package.relations:
        lines.append("无。")
    lines.extend(["", "## 依据", ""])
    lines.extend(
        f"- `{item.evidence_id}`｜{item.role}｜`{item.start_block_id}` → "
        f"`{item.end_block_id}`{f'｜{item.note_markdown}' if item.note_markdown else ''}"
        for item in package.evidence
    )
    if not package.evidence:
        lines.append("无。")
    lines.extend(["", "## 未决项", ""])
    lines.extend(
        f"- `{item.unresolved_id}`｜{item.kind}｜{item.description_markdown}"
        for item in package.unresolved
    )
    if not package.unresolved:
        lines.append("无。")
    return "\n".join(lines).rstrip() + "\n"
