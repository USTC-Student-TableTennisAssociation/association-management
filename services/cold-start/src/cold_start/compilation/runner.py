"""并行编译内容叶子并保存可审查的局部候选子图。"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from pydantic import ValidationError

from cold_start.compilation.models import (
    CARD_CONTENT_FIELDS,
    LeafCandidateSubgraph,
    LeafCompilationResult,
    LeafCompilationSnapshot,
)
from cold_start.config import CompilationSettings
from cold_start.document.blocks import format_blocks
from cold_start.document.models import ParsedBlock
from cold_start.global_exploration.models import GlobalExplorationSnapshot
from cold_start.llm.base import ChatModel
from cold_start.progress import NullProgressReporter, ProgressReporter
from cold_start.region_tree.models import RegionNode
from cold_start.region_tree.runtime import BlockIndex

LEAF_COMPILATION_SYSTEM_PROMPT = """
你是组织长期记忆的局部编译器。你只处理一棵连续原文区域树中的一个内容叶子，把原文
编译为有来源依据的局部候选子图。不要总结整篇文档，不要评价写作质量，不要使用常识
补齐原文，也不要因为某件事看起来合理就创建卡片或连线。

一张卡片表达一个能够被独立寻址的长期记忆。当前叶子可以生成零张、一张或多张卡片。
人物、活动、角色、历史、档案、工作方法都属于组织记忆；不要把“是否直接指导未来
行动”作为建卡门槛。一个有原文依据的人物可以只建立身份卡，不能因为当前叶子暂时
没有其他卡可连接就将其忽略。不要把区域树节点直接复制成卡片，也不要为了覆盖原文
而把普通叙述强行归类。

你不是在生成互不相关的卡片清单，而是在编译以下四类可以相互连接的图结构。箭头表示
常见的理解和检索路径，不要求每条路径中的卡片全部出现，也不能为了补齐路径杜撰中间
卡片。

一、活动运行主线
activity_pattern → activity_trait → workflow → work_step
- activity_pattern 是跨年份持续存在的活动身份，例如“继往开来杯”，不是某一届活动；
- activity_trait 是可被多个活动共享、并能帮助选择工作流的分类特征，例如“大型比赛”
  “单打比赛”；只属于某个活动的普通描述不必强行独立为特征卡；
- workflow 是为了一个目标组织起来的一组连续、并行、分支、共享或可回退的工作；
- work_step 是工作流中能够独立理解的工作位置，不等于原文中的每一句操作说明；
- 制度、责任机制、治理模式、组织建设方案不是活动，不能为了给 workflow 补一个活动
  根节点而生成 activity_pattern；workflow 可以不依附活动身份而独立存在；
- 活动可以直接使用专属 workflow，也可以经由 activity_trait 复用共同 workflow；
- workflow 可以包含 work_step 或更小的共享 workflow；多个活动可以使用同一 workflow。

二、活动运行的辅助支线
rule、principle、practice → activity_pattern、activity_trait、workflow 或 work_step
- rule 是明确的制度要求、禁止事项、资格条件或行为边界；
- principle 不形成硬门槛，但会长期、稳定地影响选择和判断；
- practice 记录过去在具体情境中实际怎样做、结果如何以及由原文支持的经验；
- rule、principle、practice 优先连接到它们真正影响的 workflow 或 work_step；
- 只有对整个活动、某类活动或所有活动成立时，才连接 activity_pattern 或
  activity_trait；
- 活动专属实践如果发生在某个工作步骤，应连接该 work_step，并用 context_card_id
  指明 activity_pattern 或 activity_trait，而不是只连接活动身份；
- 规则、原则和实践在原文中依次出现，不代表它们互为先后步骤。

三、人员与职责主线
person → role；person 或 role → activity_pattern、workflow、work_step
- person 是原文能够识别、且与组织有关系或贡献的人物身份；不以职位高低或未来是否
  常被查询判断是否建卡；
- role 是跨届可能持续存在的组织职位或职责身份，不是某个人独有的一次性描述；
- 原文明示一个稳定的组织职位或职责名称，就足以建立 role；即使当前叶子没有说明完整
  职责，也只需按原文写明这个角色是什么，不得为填充 definition_markdown 推测职责；
- “历任会长”“全体干事”这类未列出姓名的群体表述可以支持建立“会长”“干事”
  role，但不能据此创建未知 person；“老师”“学长”等一般称谓只有在原文同时说明其
  对组织承担的角色或关系时，才建立 role；
- held_role 表达某人在一段时间担任某角色；
- responsible_for 表达人物或角色负责某项活动、工作流或工作步骤；
- 人物参与某届活动或承担某次具体工作时，关系应保留原文给出的时间或届次范围；
- 不要因为原文只出现人物姓名就推测其职位、职责或参与事项。

四、组织历史与档案支线
historical_event → 它建立、改变或结束的活动、角色、规则、工作流
archive_record → 它记录或支持的人物、事件、活动及其他记忆
- historical_event 是在明确时间点或时间范围发生的一次事情或变化；
- archive_record 是原文能够指认、已经存在的重要档案或档案集合；未来计划建立的档案
  类型不能当作已经存在的档案；
- 某届活动只有在原文把它作为一次历史事实或变化记录时，才建立 historical_event；
- 人物可以 authored 某项 archive_record，档案也可以为其他记忆提供背景。

关系语义和方向：
- has_trait：activity_pattern → activity_trait；
- uses：activity_pattern、activity_trait 或 workflow → 被使用的 workflow；
- contains：workflow → 其直接 work_step 或子 workflow；
- next：work_step → 下一 work_step；只有原文支持真实先后关系时使用；
- requires：活动、workflow 或 work_step → 必须先具备或完成的 workflow、work_step；
- constrains：rule → 受其约束的活动、特征、workflow 或 work_step；
- informs：principle、practice 或 archive_record → 被其影响或说明的记忆；
- relevant_at：rule、principle 或 practice → 它真正发挥作用的 workflow 或 work_step；
- applies_to：rule、principle、practice 或 workflow → 适用的活动或活动特征；
- exception_to：较窄的 rule → 被其例外处理的较宽 rule；
- deviates_from：practice → 与实际做法有偏离的 rule 或 principle；
- establishes：historical_event → 由该事件建立的记忆；
- changes：historical_event → 由该事件改变的既有记忆；
- held_role：person → role，任期写入 temporal_scope_markdown；
- responsible_for：person 或 role → activity_pattern、workflow 或 work_step；
- participated_in：person → activity_pattern 或 historical_event，具体时间写入
  temporal_scope_markdown；
- authored：person → archive_record。

关系名称相同也不能替代事实判断。原文只是并列、邻近、同属一章或依次出现，不足以
证明存在关系。编号顺序、项目符号顺序、表格行顺序和写作顺序本身也不能证明 next；
只有原文明示“先后、随后、完成后、再进行”或后一项确实依赖前一项完成时才能使用。
尤其不能用 next 串联并列的工作组成、规则、原则、实践或活动特征。不要为了让局部子图
看起来完整而创建没有原文依据的边。

不要生成 SearchCard；搜索入口在全图稳定后生成。地点、物资和系统也不作为独立卡片。
如果值得记忆的内容无法由现有类型准确表达，放入 unsupported_card_kind，不得硬塞。

content 字段必须与卡片类型对应：
{content_fields}

按以下顺序完成一次判断：先识别原文明确支持的卡片，再判断局部关系，最后检查原文块
覆盖。已经有原文支持的选择不要为了寻找“唯一最佳分类”反复推翻；无法从当前原文
消除、且不影响事实成立的歧义，简短保留在卡片内容、关系时间范围或
needs_parent_context 中，然后继续输出。

边的两端和 context_card_id 只能引用本次 new_cards 中的 card_id。某张卡可以暂时
没有局部边；不要为了连线删除这张卡，也不要杜撰目标卡。跨叶子关系放入
needs_parent_context，留给父节点处理。

每张卡片和每条边至少引用一项 source_evidence。依据范围必须位于当前叶子内，且边的
依据要能够支持关系本身。覆盖检查以原文 block 为单位，不要求把一个 block 内的每个
词句都分别编译：一个 block 只要已被某项 source_evidence 覆盖，就已经完成覆盖；
其中没有单独建卡的称谓、修饰语、群体或背景句不再重复写入 uncompiled_segments。
只有整个连续 block 没有支持任何卡片或关系，或者其整体必须留待父节点处理时，才写入
uncompiled_segments。不要让同一个 block 同时承担“已编译依据”和“未编译片段”来
追求句内语义穷尽。最终只输出符合 JSON Schema 的 JSON。
""".strip()


def content_field_guide() -> str:
    lines: list[str] = []
    for kind, (required, optional) in CARD_CONTENT_FIELDS.items():
        required_text = "、".join(sorted(required))
        optional_text = "、".join(sorted(optional)) or "无"
        lines.append(f"- {kind}：必填 {required_text}；可选 {optional_text}")
    lines.append(
        "- activity_pattern.recurrence_kind：annual、semester、irregular、"
        "on_demand、unknown"
    )
    lines.append(
        "- activity_trait.dimension：scale、format、audience、funding、venue、"
        "recurrence、other"
    )
    return "\n".join(lines)


def leaf_compilation_prompt(
    *,
    document_context: str,
    lineage: list[RegionNode],
    leaf: RegionNode,
    blocks: tuple[ParsedBlock, ...],
) -> str:
    path = "\n".join(
        f"- {node.label}：{node.introduction}" for node in [*lineage, leaf]
    )
    return f"""
[STAGE: compile_leaf]
这是叶子 {leaf.node_id} 的第一次局部编译。

文档背景（低权威，只帮助理解）：
{document_context}

根节点到当前叶子的路径（低权威，只帮助理解）：
{path}

当前叶子范围：{leaf.start_block_id} → {leaf.end_block_id}

当前叶子完整原文（唯一事实依据）：
{format_blocks(blocks)}

请完成四项输出：
1. new_cards：原子化的新记忆卡片候选；
2. local_edges：这些新卡片之间由原文支持的局部连线候选；
3. source_evidence：卡片和连线引用的连续原文依据；
4. uncompiled_segments：没有编译为记忆，或需要父节点处理的原文说明。

card_id、edge_id、evidence_id 只使用 card-1、edge-1、evidence-1 这类本次调用内的
临时编号。不要生成数据库 UUID。

JSON Schema：
{json.dumps(LeafCandidateSubgraph.model_json_schema(), ensure_ascii=False, separators=(",", ":"))}
""".strip()


@dataclass(frozen=True)
class CompilationArtifactPaths:
    directory: Path
    snapshot_json: Path
    report_markdown: Path
    working_json: Path
    model_streams: Path


class LeafCompilationRunner:
    def __init__(
        self,
        *,
        model: ChatModel,
        exploration: GlobalExplorationSnapshot,
        blocks: tuple[ParsedBlock, ...],
        settings: CompilationSettings | None = None,
        progress: ProgressReporter | None = None,
        checkpoint: Callable[[LeafCompilationSnapshot], None] | None = None,
    ) -> None:
        self.model = model
        self.exploration = exploration
        self.blocks = blocks
        self.index = BlockIndex(blocks)
        self.settings = settings or CompilationSettings()
        self.progress = progress or NullProgressReporter()
        self.checkpoint = checkpoint
        self.nodes = {node.node_id: node for node in exploration.region_tree.nodes}
        self.created_at = datetime.now(UTC)

    async def run(self) -> LeafCompilationSnapshot:
        tree = self.exploration.region_tree
        if tree.status != "frozen":
            raise ValueError("区域树尚未冻结，不能开始叶子编译")
        leaf_ids = [
            node_id
            for node_id in tree.leaf_node_ids
            if self.nodes[node_id].owned_source_role == "content_source"
        ]
        deferred = [
            node_id
            for node_id in tree.content_node_ids
            if node_id not in set(leaf_ids)
        ]
        self.progress.report(
            "叶子编译",
            (
                f"准备编译 {len(leaf_ids)} 个内容叶子；"
                f"{len(deferred)} 个含自有原文的父节点留待下一阶段"
            ),
        )

        semaphore = asyncio.Semaphore(self.settings.max_parallel_leaves)
        lock = asyncio.Lock()
        results: dict[str, LeafCompilationResult] = {}

        async def compile_one(position: int, node_id: str) -> None:
            async with semaphore:
                result = await self._compile_leaf(
                    self.nodes[node_id],
                    position=position,
                    total=len(leaf_ids),
                )
            async with lock:
                results[node_id] = result
                if self.checkpoint:
                    self.checkpoint(
                        self._snapshot(
                            results=[results[item] for item in leaf_ids if item in results],
                            deferred=deferred,
                            status="running",
                        )
                    )

        await asyncio.gather(
            *(
                compile_one(position, node_id)
                for position, node_id in enumerate(leaf_ids, start=1)
            )
        )
        ordered_results = [results[node_id] for node_id in leaf_ids]
        status = (
            "complete"
            if all(result.status == "compiled" for result in ordered_results)
            else "partial"
        )
        snapshot = self._snapshot(
            results=ordered_results,
            deferred=deferred,
            status=status,
        )
        self.progress.report(
            "叶子编译",
            (
                f"完成：{sum(item.status == 'compiled' for item in ordered_results)}/"
                f"{len(ordered_results)} 个叶子成功，模型调用 {snapshot.model_calls} 次"
            ),
        )
        return snapshot

    async def _compile_leaf(
        self,
        leaf: RegionNode,
        *,
        position: int,
        total: int,
    ) -> LeafCompilationResult:
        started = time.perf_counter()
        label = f"叶子编译·{leaf.node_id}"
        self.progress.report(label, f"开始 {position}/{total}：{leaf.label}")
        lineage = self._lineage(leaf)
        blocks = self.index.slice(leaf.start_block_id, leaf.end_block_id)
        system_prompt = LEAF_COMPILATION_SYSTEM_PROMPT.format(
            content_fields=content_field_guide()
        )
        prompt = leaf_compilation_prompt(
            document_context=self.exploration.document_context_markdown,
            lineage=lineage,
            leaf=leaf,
            blocks=blocks,
        )
        model_calls = 0
        try:
            model_calls += 1
            turn = await self.model.complete_turn(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": prompt},
                ],
                request_label=label,
                thinking="enabled",
            )
            try:
                subgraph = self._parse_and_validate(turn.content, leaf)
            except (ValidationError, ValueError, json.JSONDecodeError) as error:
                model_calls += 1
                repair = await self.model.complete_turn(
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": prompt},
                        turn.as_assistant_message(),
                        {
                            "role": "user",
                            "content": (
                                f"上一次输出无法通过程序校验：{error}\n"
                                "请基于已有原文，只输出修正后的完整 JSON。"
                            ),
                        },
                    ],
                    request_label=f"{label}·修复",
                    thinking="disabled",
                )
                subgraph = self._parse_and_validate(repair.content, leaf)
            self.progress.report(
                label,
                (
                    f"完成：{len(subgraph.new_cards)} 张卡片，"
                    f"{len(subgraph.local_edges)} 条边，"
                    f"{len(subgraph.uncompiled_segments)} 段未编译说明，"
                    f"耗时 {time.perf_counter() - started:.1f} 秒"
                ),
            )
            return LeafCompilationResult(
                leaf_node_id=leaf.node_id,
                label=leaf.label,
                lineage=[node.node_id for node in lineage],
                start_block_id=leaf.start_block_id,
                end_block_id=leaf.end_block_id,
                source_pages=leaf.source_pages,
                status="compiled",
                subgraph=subgraph,
                model_calls=model_calls,
            )
        except Exception as error:
            self.progress.report(label, f"失败：{error}")
            return LeafCompilationResult(
                leaf_node_id=leaf.node_id,
                label=leaf.label,
                lineage=[node.node_id for node in lineage],
                start_block_id=leaf.start_block_id,
                end_block_id=leaf.end_block_id,
                source_pages=leaf.source_pages,
                status="failed",
                error=str(error),
                model_calls=model_calls,
            )

    def _parse_and_validate(
        self,
        raw: str,
        leaf: RegionNode,
    ) -> LeafCandidateSubgraph:
        subgraph = LeafCandidateSubgraph.model_validate_json(_json_object(raw))
        card_ids = _unique_ids(
            [card.card_id for card in subgraph.new_cards],
            "card_id",
        )
        edge_ids = _unique_ids(
            [edge.edge_id for edge in subgraph.local_edges],
            "edge_id",
        )
        del edge_ids
        evidence_ids = _unique_ids(
            [evidence.evidence_id for evidence in subgraph.source_evidence],
            "evidence_id",
        )
        referenced_evidence: set[str] = set()
        for card in subgraph.new_cards:
            _validate_references(card.evidence_ids, evidence_ids, card.card_id)
            referenced_evidence.update(card.evidence_ids)
        for edge in subgraph.local_edges:
            if edge.from_card_id not in card_ids or edge.to_card_id not in card_ids:
                raise ValueError(f"{edge.edge_id} 引用了当前叶子之外的卡片")
            if edge.from_card_id == edge.to_card_id:
                raise ValueError(f"{edge.edge_id} 不能形成自环")
            if edge.context_card_id and edge.context_card_id not in card_ids:
                raise ValueError(f"{edge.edge_id} 的 context_card_id 无效")
            _validate_references(edge.evidence_ids, evidence_ids, edge.edge_id)
            referenced_evidence.update(edge.evidence_ids)
        unused_evidence = evidence_ids - referenced_evidence
        if unused_evidence:
            subgraph = subgraph.model_copy(
                update={
                    "source_evidence": [
                        evidence
                        for evidence in subgraph.source_evidence
                        if evidence.evidence_id not in unused_evidence
                    ]
                }
            )

        leaf_left = self.index.position(leaf.start_block_id)
        leaf_right = self.index.position(leaf.end_block_id)
        covered: set[int] = set()
        for segment in [
            *subgraph.source_evidence,
            *subgraph.uncompiled_segments,
        ]:
            left = self.index.position(segment.start_block_id)
            right = self.index.position(segment.end_block_id)
            if right < left or left < leaf_left or right > leaf_right:
                raise ValueError(
                    f"来源范围不在当前叶子内："
                    f"{segment.start_block_id} → {segment.end_block_id}"
                )
            covered.update(range(left, right + 1))
        missing = [
            self.blocks[position].block_id
            for position in range(leaf_left, leaf_right + 1)
            if position not in covered
        ]
        if missing:
            raise ValueError(f"以下原文块既无依据也无未编译说明：{', '.join(missing)}")
        return subgraph

    def _lineage(self, leaf: RegionNode) -> list[RegionNode]:
        lineage: list[RegionNode] = []
        parent_id = leaf.parent_id
        while parent_id:
            parent = self.nodes[parent_id]
            lineage.append(parent)
            parent_id = parent.parent_id
        return list(reversed(lineage))

    def _snapshot(
        self,
        *,
        results: list[LeafCompilationResult],
        deferred: list[str],
        status: str,
    ) -> LeafCompilationSnapshot:
        issues = [
            f"{result.leaf_node_id} {result.label}：{result.error}"
            for result in results
            if result.status == "failed"
        ]
        return LeafCompilationSnapshot(
            created_at=self.created_at,
            status=status,
            source=self.exploration.source,
            region_tree_schema_version=self.exploration.region_tree.schema_version,
            leaf_results=results,
            deferred_content_node_ids=deferred,
            model_calls=sum(result.model_calls for result in results),
            issues=issues,
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


def create_compilation_directory(run_directory: Path) -> CompilationArtifactPaths:
    directory = (
        run_directory.expanduser().resolve()
        / "leaf-compilations"
        / f"{datetime.now(UTC):%Y%m%dT%H%M%S%fZ}"
    )
    directory.mkdir(parents=True, exist_ok=False)
    model_streams = directory / "model-streams"
    model_streams.mkdir()
    return CompilationArtifactPaths(
        directory=directory,
        snapshot_json=directory / "leaf-compilation.json",
        report_markdown=directory / "leaf-compilation.md",
        working_json=directory / "leaf-compilation-working.json",
        model_streams=model_streams,
    )


def write_compilation_artifacts(
    *,
    paths: CompilationArtifactPaths,
    snapshot: LeafCompilationSnapshot,
    blocks: tuple[ParsedBlock, ...],
) -> None:
    paths.snapshot_json.write_text(snapshot.model_dump_json(indent=2), encoding="utf-8")
    paths.report_markdown.write_text(
        _render_report(snapshot, blocks),
        encoding="utf-8",
    )


def write_compilation_checkpoint(
    paths: CompilationArtifactPaths,
    snapshot: LeafCompilationSnapshot,
) -> None:
    paths.working_json.write_text(snapshot.model_dump_json(indent=2), encoding="utf-8")


def _render_report(
    snapshot: LeafCompilationSnapshot,
    blocks: tuple[ParsedBlock, ...],
) -> str:
    index = BlockIndex(blocks)
    successful = sum(item.status == "compiled" for item in snapshot.leaf_results)
    lines = [
        "# 叶子局部编译结果",
        "",
        f"> 状态：{snapshot.status}",
        f"> 已编译：{successful}/{len(snapshot.leaf_results)} 个内容叶子",
        f"> 模型调用：{snapshot.model_calls}",
        f"> 待后续编译的父节点：{len(snapshot.deferred_content_node_ids)}",
        "",
    ]
    for result in snapshot.leaf_results:
        lines.extend(
            [
                f"## {result.label}",
                "",
                (
                    f"`{result.leaf_node_id}`｜`{result.start_block_id}` → "
                    f"`{result.end_block_id}`｜{result.status}"
                ),
                "",
            ]
        )
        if result.status == "failed" or result.subgraph is None:
            lines.extend([f"失败原因：{result.error}", ""])
            continue
        subgraph = result.subgraph
        lines.extend(["### 新卡片候选", ""])
        if not subgraph.new_cards:
            lines.extend(["无。", ""])
        for card in subgraph.new_cards:
            lines.extend(
                [
                    f"- **{card.title}** (`{card.card_id}`，`{card.kind}`)",
                    f"  {card.summary}",
                ]
            )
            for key, value in card.content.items():
                if value is not None:
                    lines.append(f"  - `{key}`：{value}")
            lines.append(f"  - 来源：{', '.join(card.evidence_ids)}")
        if subgraph.new_cards:
            lines.append("")

        lines.extend(["### 局部连线候选", ""])
        if not subgraph.local_edges:
            lines.extend(["无。", ""])
        else:
            for edge in subgraph.local_edges:
                context = (
                    f"，context={edge.context_card_id}"
                    if edge.context_card_id
                    else ""
                )
                lines.append(
                    f"- `{edge.edge_id}`：`{edge.from_card_id}` "
                    f"—{edge.relation_type}→ `{edge.to_card_id}`{context}；"
                    f"来源 {', '.join(edge.evidence_ids)}"
                )
            lines.append("")

        lines.extend(["### 来源依据", ""])
        if not subgraph.source_evidence:
            lines.extend(["无。", ""])
        else:
            for evidence in subgraph.source_evidence:
                excerpt = " ".join(
                    block.markdown.replace("\n", " ")
                    for block in index.slice(
                        evidence.start_block_id,
                        evidence.end_block_id,
                    )
                )
                if len(excerpt) > 240:
                    excerpt = excerpt[:237] + "..."
                lines.extend(
                    [
                        (
                            f"- `{evidence.evidence_id}`｜{evidence.role}｜"
                            f"`{evidence.start_block_id}` → "
                            f"`{evidence.end_block_id}`：{evidence.note_markdown}"
                        ),
                        f"  > {excerpt}",
                    ]
                )
            lines.append("")

        lines.extend(["### 未编译说明", ""])
        if not subgraph.uncompiled_segments:
            lines.extend(["无。", ""])
        else:
            for segment in subgraph.uncompiled_segments:
                lines.append(
                    f"- `{segment.start_block_id}` → `{segment.end_block_id}`｜"
                    f"`{segment.reason_kind}`：{segment.reason}"
                )
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _json_object(raw: str) -> str:
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end < start:
        raise ValueError("模型输出中不存在 JSON 对象")
    return raw[start : end + 1]


def _unique_ids(values: list[str], name: str) -> set[str]:
    result = set(values)
    if len(result) != len(values):
        raise ValueError(f"{name} 不能重复")
    return result


def _validate_references(
    references: list[str],
    valid: set[str],
    owner: str,
) -> None:
    unknown = set(references) - valid
    if unknown:
        raise ValueError(f"{owner} 引用了不存在的来源依据：{', '.join(sorted(unknown))}")
