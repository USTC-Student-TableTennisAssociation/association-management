"""从叶子向根节点逐层整合局部候选子图。"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from pydantic import ValidationError

from cold_start.compilation.models import LeafCompilationSnapshot
from cold_start.compilation.parent_models import (
    AddEdgeOperation,
    IntegratedCard,
    IntegratedEdge,
    IntegratedEvidence,
    IntegratedSubgraph,
    IntegrationCardDefinition,
    IntegrationIssue,
    ParentIntegrationAgenda,
    ParentIntegrationDecision,
    ParentIntegrationResult,
    ParentIntegrationSnapshot,
)
from cold_start.compilation.runner import content_field_guide, load_exploration_inputs
from cold_start.config import CompilationSettings
from cold_start.document.blocks import format_blocks
from cold_start.document.models import ParsedBlock
from cold_start.global_exploration.models import GlobalExplorationSnapshot
from cold_start.llm.base import ChatModel
from cold_start.progress import NullProgressReporter, ProgressReporter
from cold_start.region_tree.models import RegionNode, SourceSegment
from cold_start.region_tree.runtime import BlockIndex

PARENT_ROUTER_SYSTEM_PROMPT = """
你是组织长期记忆图的父节点路由器。你看到当前父节点的语义、父节点自有原文，以及每个
直接孩子已经整合好的紧凑卡片目录。你的任务只是指出哪些小范围值得展开检查，不作最终
合并、改卡或连线。

只关注四类候选：
- possible_duplicate：不同孩子中可能表示同一身份或同一知识边界的卡片；
- possible_correction：补充父节点语境后，可能存在类型、身份、范围或关系理解偏差的卡片；
- possible_cross_child_link：不同孩子之间可能存在活动、工作、指导、人员、历史或档案关系；
- possible_parent_source_link：父节点自有原文可能生成新卡，或可能说明已有卡片之间的关系。

孩子内部已经完成的关系不需要重新检查。标题相似不等于重复，主题相关也不等于存在边。
父节点介绍和文档背景只用于发现候选，不能作为最终事实依据。card_id 必须原样取自目录；
不要发明卡片 ID。没有候选时返回空 candidate_groups。只输出符合 JSON Schema 的 JSON。
""".strip()


PARENT_DECISION_SYSTEM_PROMPT = f"""
你是组织长期记忆图的父节点裁决器。输入只展开了路由阶段选中的卡片、已有边和来源，
还包含父节点真正拥有的原文。未出现在操作中的卡片和边会由程序原样继承，因此只输出
必要的增量修改，不要重写整个子图。

允许的操作：
- new_cards：只根据父节点自有原文或已展开证据新增卡片；
- merge_cards：确认多个卡片是同一节点，并给出合并后的定义；
- revise_cards：更正卡片类型、标题、内容范围或局部理解；
- remove_cards：撤销原文无法支持或明显误解的卡片；
- add_edges、remove_edges：补充跨孩子关系或撤销错误关系；
- resolved_issue_ids、deferred_issues：解决已有未决项，或继续交给更高父节点。

上下文重解释不能自由改写。每次合并、修正、删除和连线都必须引用展开内容中存在的来源
依据。父节点介绍是低权威提示，不能单独支持修改。ActivityPattern、HistoricalEvent、
Workflow、WorkStep、Rule、Principle、Practice、Person、Role 和 ArchiveRecord 不能
仅因主题相近而合并。

父节点自有标题、章节概览和统领性引言不自动成为卡片。只有原文本身表达了可以脱离
章节目录独立检索和使用的长期知识时才新增卡片；不要生成“本章讨论什么”的摘要卡。
原文只给出概念名称、没有提供定义或理由时，不得用常识补齐必填字段，可将原文留作
未编译说明或递交更高父节点。

卡片 content 字段必须严格使用对应类型允许的字段，不得创造 scope_markdown、
principle_markdown 等未列出的字段：
{content_field_guide()}

主要图结构：
- ActivityPattern → has_trait → ActivityTrait；
- ActivityPattern、ActivityTrait 或 Workflow → uses → Workflow；
- Workflow → contains → WorkStep 或子 Workflow；
- next 只连接原文明示先后或真实依赖的 WorkStep；
- ActivityPattern、ActivityTrait、Workflow 或 WorkStep → requires → 必须先具备或完成的
  Workflow、WorkStep；
- Rule → exception_to → 更宽的 Rule；
- Rule、Principle、Practice 或 Workflow → applies_to → ActivityPattern、ActivityTrait；
- Rule、Principle 或 Practice → relevant_at → 真正发挥作用的 Workflow、WorkStep；
- Principle、Practice 或 ArchiveRecord → informs → 有来源直接支持其说明或影响的记忆；
- Rule → constrains → ActivityPattern、ActivityTrait、Workflow 或 WorkStep；
- Practice → deviates_from → 与实际做法存在偏离的 Rule、Principle；
- Person → held_role → Role；
- Person 或 Role → responsible_for → ActivityPattern、Workflow 或 WorkStep；
- Person → participated_in → ActivityPattern 或 HistoricalEvent；
- HistoricalEvent 可以 establishes/changes 其他记忆；
- Person → authored → ArchiveRecord。

add_edges 的门槛高于“两个知识相关”：来源必须直接支持关系本身。以下情况均不得建边：
- 同属一章、使用同一名词、服务同一宽泛目标；
- 仅能从时间相邻、常识或合理故事推导出因果、支撑、实现、回应关系；
- 当前关系类型无法准确表达，只能借用 informs、contains、establishes 等近似词。
informs 不是通用相关关系；establishes/changes 的起点必须是确实建立或改变某项记忆的
历史事件；next 只表示直接相邻或原文明示的下一工作步骤。没有准确关系类型时写入
deferred_issues，不要勉强连线。

制度、责任机制、治理模式和组织建设方案不是 ActivityPattern。父节点可以创建不依附活动
身份的 Workflow。某张卡暂时没有边不是删除理由。

新卡、新边和父节点来源依据分别使用 card-1、edge-1、evidence-1 形式的局部编号。
已有卡片、边、依据和未决项必须使用输入中的完整 ID。父节点自有原文的每个 block 必须
被 source_evidence 或 uncompiled_parent_segments 覆盖。source_evidence 必须被至少一项
实际卡片或边操作引用；如果父节点原文只提供结构或理解背景，应放入
uncompiled_parent_segments。只输出符合 JSON Schema 的 JSON。
""".strip()


_RELATION_KIND_RULES: dict[str, tuple[frozenset[str], frozenset[str]]] = {
    "has_trait": (frozenset({"activity_pattern"}), frozenset({"activity_trait"})),
    "uses": (
        frozenset({"activity_pattern", "activity_trait", "workflow"}),
        frozenset({"workflow"}),
    ),
    "contains": (
        frozenset({"workflow"}),
        frozenset({"workflow", "work_step"}),
    ),
    "next": (frozenset({"work_step"}), frozenset({"work_step"})),
    "requires": (
        frozenset(
            {"activity_pattern", "activity_trait", "workflow", "work_step"}
        ),
        frozenset({"workflow", "work_step"}),
    ),
    "exception_to": (frozenset({"rule"}), frozenset({"rule"})),
    "applies_to": (
        frozenset({"rule", "principle", "practice", "workflow"}),
        frozenset({"activity_pattern", "activity_trait"}),
    ),
    "relevant_at": (
        frozenset({"rule", "principle", "practice"}),
        frozenset({"workflow", "work_step"}),
    ),
    "informs": (
        frozenset({"principle", "practice", "archive_record"}),
        frozenset(
            {
                "activity_pattern",
                "activity_trait",
                "person",
                "role",
                "historical_event",
                "workflow",
                "work_step",
                "rule",
                "principle",
                "practice",
                "archive_record",
            }
        ),
    ),
    "constrains": (
        frozenset({"rule"}),
        frozenset(
            {"activity_pattern", "activity_trait", "workflow", "work_step"}
        ),
    ),
    "deviates_from": (
        frozenset({"practice"}),
        frozenset({"rule", "principle"}),
    ),
    "establishes": (
        frozenset({"historical_event"}),
        frozenset(
            {
                "activity_pattern",
                "activity_trait",
                "person",
                "role",
                "historical_event",
                "workflow",
                "work_step",
                "rule",
                "principle",
                "practice",
                "archive_record",
            }
        ),
    ),
    "changes": (
        frozenset({"historical_event"}),
        frozenset(
            {
                "activity_pattern",
                "activity_trait",
                "person",
                "role",
                "historical_event",
                "workflow",
                "work_step",
                "rule",
                "principle",
                "practice",
                "archive_record",
            }
        ),
    ),
    "held_role": (frozenset({"person"}), frozenset({"role"})),
    "responsible_for": (
        frozenset({"person", "role"}),
        frozenset({"activity_pattern", "workflow", "work_step"}),
    ),
    "participated_in": (
        frozenset({"person"}),
        frozenset({"activity_pattern", "historical_event"}),
    ),
    "authored": (frozenset({"person"}), frozenset({"archive_record"})),
}


@dataclass(frozen=True)
class ParentIntegrationArtifactPaths:
    directory: Path
    snapshot_json: Path
    report_markdown: Path
    working_json: Path
    model_streams: Path


class ParentIntegrationRunner:
    def __init__(
        self,
        *,
        model: ChatModel,
        exploration: GlobalExplorationSnapshot,
        leaf_compilation: LeafCompilationSnapshot,
        blocks: tuple[ParsedBlock, ...],
        settings: CompilationSettings | None = None,
        progress: ProgressReporter | None = None,
        checkpoint: Callable[[ParentIntegrationSnapshot], None] | None = None,
    ) -> None:
        self.model = model
        self.exploration = exploration
        self.leaf_compilation = leaf_compilation
        self.blocks = blocks
        self.index = BlockIndex(blocks)
        self.settings = settings or CompilationSettings()
        self.progress = progress or NullProgressReporter()
        self.checkpoint = checkpoint
        self.nodes = {node.node_id: node for node in exploration.region_tree.nodes}
        self.created_at = datetime.now(UTC)

    async def run(self) -> ParentIntegrationSnapshot:
        packages = self._initial_leaf_packages()
        results: dict[str, ParentIntegrationResult] = {}
        semaphore = asyncio.Semaphore(self.settings.max_parallel_parents)
        lock = asyncio.Lock()
        branches = [
            node for node in self.nodes.values() if node.status == "branch"
        ]
        self.progress.report(
            "父节点整合",
            (
                f"准备自底向上处理 {len(branches)} 个父节点；"
                f"并发上限 {self.settings.max_parallel_parents}"
            ),
        )

        for depth in sorted({node.depth for node in branches}, reverse=True):
            current = sorted(
                (node for node in branches if node.depth == depth),
                key=lambda item: item.node_id,
            )

            async def integrate(node: RegionNode) -> None:
                missing = [
                    child_id for child_id in node.child_ids if child_id not in packages
                ]
                if missing:
                    result = ParentIntegrationResult(
                        node_id=node.node_id,
                        label=node.label,
                        depth=node.depth,
                        child_ids=node.child_ids,
                        status="blocked",
                        error=f"孩子整合结果缺失：{', '.join(missing)}",
                    )
                    package = None
                else:
                    async with semaphore:
                        result, package = await self._integrate_parent(
                            node,
                            [packages[child_id] for child_id in node.child_ids],
                        )
                async with lock:
                    results[node.node_id] = result
                    if package is not None:
                        packages[node.node_id] = package
                    if self.checkpoint:
                        self.checkpoint(
                            self._snapshot(
                                results=results,
                                root_subgraph=packages.get(
                                    self.exploration.region_tree.root_node_id
                                ),
                                status="running",
                            )
                        )

            await asyncio.gather(*(integrate(node) for node in current))

        root_id = self.exploration.region_tree.root_node_id
        root = packages.get(root_id)
        status = "complete" if root is not None else "partial"
        snapshot = self._snapshot(
            results=results,
            root_subgraph=root,
            status=status,
        )
        self.progress.report(
            "父节点整合",
            (
                f"完成：{sum(item.status == 'integrated' for item in results.values())}/"
                f"{len(branches)} 个父节点成功，模型调用 {snapshot.model_calls} 次"
            ),
        )
        return snapshot

    def _initial_leaf_packages(self) -> dict[str, IntegratedSubgraph]:
        failed = [
            result
            for result in self.leaf_compilation.leaf_results
            if result.status != "compiled" or result.subgraph is None
        ]
        if failed:
            labels = ", ".join(f"{item.leaf_node_id} {item.label}" for item in failed)
            raise ValueError(f"叶子编译仍有失败节点，请重新编译后再整合：{labels}")
        by_id = {
            result.leaf_node_id: result for result in self.leaf_compilation.leaf_results
        }
        packages: dict[str, IntegratedSubgraph] = {}
        for leaf_id in self.exploration.region_tree.leaf_node_ids:
            result = by_id.get(leaf_id)
            packages[leaf_id] = (
                self._leaf_package(result) if result is not None else IntegratedSubgraph()
            )
        return packages

    def _leaf_package(self, result) -> IntegratedSubgraph:
        assert result.subgraph is not None
        prefix = result.leaf_node_id
        evidence_map = {
            item.evidence_id: f"{prefix}/{item.evidence_id}"
            for item in result.subgraph.source_evidence
        }
        card_map = {
            item.card_id: f"{prefix}/{item.card_id}"
            for item in result.subgraph.new_cards
        }
        evidence = [
            IntegratedEvidence(
                evidence_id=evidence_map[item.evidence_id],
                source_node_id=prefix,
                start_block_id=item.start_block_id,
                end_block_id=item.end_block_id,
                role=item.role,
                note_markdown=item.note_markdown,
            )
            for item in result.subgraph.source_evidence
        ]
        cards = [
            IntegratedCard(
                card_id=card_map[item.card_id],
                kind=item.kind,
                title=item.title,
                summary=item.summary,
                content=item.content,
                evidence_ids=[evidence_map[value] for value in item.evidence_ids],
                origin_card_ids=[card_map[item.card_id]],
            )
            for item in result.subgraph.new_cards
        ]
        edges = [
            IntegratedEdge(
                edge_id=f"{prefix}/{item.edge_id}",
                from_card_id=card_map[item.from_card_id],
                to_card_id=card_map[item.to_card_id],
                context_card_id=(
                    card_map[item.context_card_id] if item.context_card_id else None
                ),
                relation_type=item.relation_type,
                sequence=item.sequence,
                temporal_scope_markdown=item.temporal_scope_markdown,
                note_markdown=item.note_markdown,
                evidence_ids=[evidence_map[value] for value in item.evidence_ids],
                origin_edge_ids=[f"{prefix}/{item.edge_id}"],
            )
            for item in result.subgraph.local_edges
        ]
        issues = [
            IntegrationIssue(
                issue_id=f"{prefix}/issue-{position}",
                source_node_id=prefix,
                source_segments=[
                    SourceSegment(
                        start_block_id=item.start_block_id,
                        end_block_id=item.end_block_id,
                    )
                ],
                description=item.reason,
            )
            for position, item in enumerate(
                (
                    segment
                    for segment in result.subgraph.uncompiled_segments
                    if segment.reason_kind == "needs_parent_context"
                ),
                start=1,
            )
        ]
        return IntegratedSubgraph(
            cards=cards,
            edges=edges,
            evidence=evidence,
            unresolved_issues=issues,
        )

    async def _integrate_parent(
        self,
        parent: RegionNode,
        child_packages: list[IntegratedSubgraph],
    ) -> tuple[ParentIntegrationResult, IntegratedSubgraph | None]:
        label = f"父节点整合·{parent.node_id}"
        self.progress.report(label, f"开始：{parent.label}")
        inherited = _union_subgraphs(child_packages)
        owned_blocks = self._owned_blocks(parent)
        model_calls = 0
        try:
            route_prompt = self._route_prompt(parent, child_packages, owned_blocks)
            agenda, calls = await self._structured_call(
                system_prompt=PARENT_ROUTER_SYSTEM_PROMPT,
                user_prompt=route_prompt,
                output_type=ParentIntegrationAgenda,
                request_label=f"{label}·路由",
                validate=lambda value: self._validate_agenda(value, inherited),
            )
            model_calls += calls
            selected_ids = {
                card_id
                for group in agenda.candidate_groups
                for card_id in group.card_ids
            }
            should_decide = bool(
                selected_ids
                or inherited.unresolved_issues
                or (
                    owned_blocks
                    and parent.owned_source_role == "content_source"
                )
                or any(
                    group.kind == "possible_parent_source_link"
                    for group in agenda.candidate_groups
                )
            )
            if should_decide:
                decision_prompt = self._decision_prompt(
                    parent=parent,
                    inherited=inherited,
                    selected_ids=selected_ids,
                    owned_blocks=owned_blocks,
                    agenda=agenda,
                )
                decision, calls = await self._structured_call(
                    system_prompt=PARENT_DECISION_SYSTEM_PROMPT,
                    user_prompt=decision_prompt,
                    output_type=ParentIntegrationDecision,
                    request_label=f"{label}·裁决",
                    validate=lambda value: self._validate_decision(
                        value,
                        parent=parent,
                        inherited=inherited,
                        selected_ids=selected_ids,
                        owned_blocks=owned_blocks,
                    ),
                )
                model_calls += calls
                package = self._apply_decision(
                    parent=parent,
                    inherited=inherited,
                    decision=decision,
                )
            else:
                decision = None
                package = inherited
            result = ParentIntegrationResult(
                node_id=parent.node_id,
                label=parent.label,
                depth=parent.depth,
                child_ids=parent.child_ids,
                status="integrated",
                agenda=agenda,
                decision=decision,
                input_card_count=len(inherited.cards),
                output_card_count=len(package.cards),
                output_edge_count=len(package.edges),
                model_calls=model_calls,
            )
            self.progress.report(
                label,
                (
                    f"完成：{len(inherited.cards)} → {len(package.cards)} 张卡片，"
                    f"{len(package.edges)} 条边，模型调用 {model_calls} 次"
                ),
            )
            return result, package
        except Exception as error:
            self.progress.report(label, f"失败：{error}")
            return (
                ParentIntegrationResult(
                    node_id=parent.node_id,
                    label=parent.label,
                    depth=parent.depth,
                    child_ids=parent.child_ids,
                    status="failed",
                    input_card_count=len(inherited.cards),
                    model_calls=model_calls,
                    error=str(error),
                ),
                None,
            )

    async def _structured_call(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        output_type,
        request_label: str,
        validate,
    ):
        schema = json.dumps(
            output_type.model_json_schema(),
            ensure_ascii=False,
            separators=(",", ":"),
        )
        prompt = f"{user_prompt}\n\nJSON Schema：\n{schema}"
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ]
        turn = await self.model.complete_turn(
            messages=messages,
            request_label=request_label,
            thinking="enabled",
        )
        calls = 1
        for repair_index in range(3):
            try:
                value = output_type.model_validate_json(_json_object(turn.content))
                return validate(value), calls
            except (ValidationError, ValueError, json.JSONDecodeError) as error:
                if repair_index == 2:
                    raise
                messages.extend(
                    [
                        turn.as_assistant_message(),
                        {
                            "role": "user",
                            "content": (
                                f"上一次输出无法通过程序校验：{error}\n"
                                "严格按系统提示和 JSON Schema 修正；不要保留报错中指出的"
                                "非法字段、ID、关系或未引用依据。只输出修正后的完整 JSON。"
                            ),
                        },
                    ]
                )
                calls += 1
                turn = await self.model.complete_turn(
                    messages=messages,
                    request_label=f"{request_label}·修复{calls - 1}",
                    thinking="disabled",
                )
        raise AssertionError("结构化调用修复循环异常结束")

    def _route_prompt(
        self,
        parent: RegionNode,
        child_packages: list[IntegratedSubgraph],
        owned_blocks: tuple[ParsedBlock, ...],
    ) -> str:
        catalog = []
        for child_id, package in zip(parent.child_ids, child_packages, strict=True):
            catalog.append(
                {
                    "child_node_id": child_id,
                    "child_label": self.nodes[child_id].label,
                    "child_introduction": self.nodes[child_id].introduction,
                    "cards": [
                        {
                            "card_id": card.card_id,
                            "kind": card.kind,
                            "title": card.title,
                            "summary": card.summary,
                        }
                        for card in package.cards
                    ],
                    "edges": [
                        {
                            "relation_type": edge.relation_type,
                            "from_card_id": edge.from_card_id,
                            "to_card_id": edge.to_card_id,
                        }
                        for edge in package.edges
                    ],
                }
            )
        return f"""
[STAGE: parent_integration_route]
当前父节点：{parent.node_id}｜{parent.label}
父节点说明（低权威）：{parent.introduction}

父节点自有原文：
{format_blocks(owned_blocks) if owned_blocks else "（无）"}

直接孩子紧凑目录：
{json.dumps(catalog, ensure_ascii=False, separators=(",", ":"))}

待父节点处理的问题：
{json.dumps(
    [
        issue.model_dump()
        for package in child_packages
        for issue in package.unresolved_issues
    ],
    ensure_ascii=False,
    separators=(",", ":"),
)}

请只形成候选检查议程，不作最终图修改。
""".strip()

    def _decision_prompt(
        self,
        *,
        parent: RegionNode,
        inherited: IntegratedSubgraph,
        selected_ids: set[str],
        owned_blocks: tuple[ParsedBlock, ...],
        agenda: ParentIntegrationAgenda,
    ) -> str:
        cards = [card for card in inherited.cards if card.card_id in selected_ids]
        selected_edges = [
            edge
            for edge in inherited.edges
            if (
                edge.from_card_id in selected_ids
                or edge.to_card_id in selected_ids
                or edge.context_card_id in selected_ids
            )
        ]
        card_by_id = {card.card_id: card for card in inherited.cards}
        neighbor_ids = {
            card_id
            for edge in selected_edges
            for card_id in (
                edge.from_card_id,
                edge.to_card_id,
                edge.context_card_id,
            )
            if card_id is not None and card_id not in selected_ids
        }
        evidence_ids = {
            evidence_id
            for card in cards
            for evidence_id in card.evidence_ids
        } | {
            evidence_id
            for edge in selected_edges
            for evidence_id in edge.evidence_ids
        }
        evidence_by_id = {
            item.evidence_id: item for item in inherited.evidence
        }
        evidence = [
            {
                **evidence_by_id[evidence_id].model_dump(),
                "excerpt": self._evidence_excerpt(evidence_by_id[evidence_id]),
            }
            for evidence_id in sorted(evidence_ids)
            if evidence_id in evidence_by_id
        ]
        issue_payload = [
            {
                **item.model_dump(),
                "source_excerpts": [
                    " ".join(
                        block.markdown.replace("\n", " ")
                        for block in self.index.slice(
                            segment.start_block_id,
                            segment.end_block_id,
                        )
                    )
                    for segment in item.source_segments
                ],
            }
            for item in inherited.unresolved_issues
        ]
        return f"""
[STAGE: parent_integration_decision]
当前父节点：{parent.node_id}｜{parent.label}
父节点说明（低权威）：{parent.introduction}

路由议程：
{agenda.model_dump_json()}

父节点自有原文（父节点新增知识的直接依据）：
{format_blocks(owned_blocks) if owned_blocks else "（无）"}

展开的卡片：
{json.dumps([item.model_dump() for item in cards], ensure_ascii=False, separators=(",", ":"))}

展开卡片之间已有的边：
{json.dumps(
    [item.model_dump() for item in selected_edges],
    ensure_ascii=False,
    separators=(",", ":"),
)}

只用于理解已有边的相邻卡片：不得在任何输出操作中引用，尤其不能作为新边端点、
context_card_id、合并/修正/删除对象或 deferred_issues.card_ids：
{json.dumps(
    [
        {
            "card_id": card_by_id[card_id].card_id,
            "kind": card_by_id[card_id].kind,
            "title": card_by_id[card_id].title,
            "summary": card_by_id[card_id].summary,
        }
        for card_id in sorted(neighbor_ids)
    ],
    ensure_ascii=False,
    separators=(",", ":"),
)}

展开的来源依据：
{json.dumps(evidence, ensure_ascii=False, separators=(",", ":"))}

仍待处理的问题：
{json.dumps(
    issue_payload,
    ensure_ascii=False,
    separators=(",", ":"),
)}

只输出必要的增量操作。没有操作的卡片和边会自动继承。
""".strip()

    def _validate_agenda(
        self,
        agenda: ParentIntegrationAgenda,
        inherited: IntegratedSubgraph,
    ) -> ParentIntegrationAgenda:
        valid_ids = {card.card_id for card in inherited.cards}
        for group in agenda.candidate_groups:
            unknown = set(group.card_ids) - valid_ids
            if unknown:
                raise ValueError(
                    f"路由候选引用不存在的卡片：{', '.join(sorted(unknown))}"
                )
            if group.kind == "possible_duplicate" and len(group.card_ids) < 2:
                raise ValueError("possible_duplicate 至少需要两张卡片")
        return agenda

    def _validate_decision(
        self,
        decision: ParentIntegrationDecision,
        *,
        parent: RegionNode,
        inherited: IntegratedSubgraph,
        selected_ids: set[str],
        owned_blocks: tuple[ParsedBlock, ...],
    ) -> ParentIntegrationDecision:
        existing_evidence = {item.evidence_id for item in inherited.evidence}
        parent_evidence = _unique(
            [item.evidence_id for item in decision.source_evidence],
            "父节点 evidence_id",
        )
        available_evidence = existing_evidence | parent_evidence
        _unique(
            [item.card_id for item in decision.new_cards],
            "父节点 card_id",
        )
        detailed_edges = {
            edge.edge_id
            for edge in inherited.edges
            if (
                edge.from_card_id in selected_ids
                or edge.to_card_id in selected_ids
                or edge.context_card_id in selected_ids
            )
        }
        existing_issues = {item.issue_id for item in inherited.unresolved_issues}

        merged_ids: set[str] = set()
        for operation in decision.merge_cards:
            self._require_subset(operation.card_ids, selected_ids, "merge_cards")
            overlap = merged_ids & set(operation.card_ids)
            if overlap:
                raise ValueError(f"同一卡片不能重复合并：{', '.join(sorted(overlap))}")
            merged_ids.update(operation.card_ids)
            self._validate_definition(operation.replacement, available_evidence)
        revised_ids = _unique(
            [item.card_id for item in decision.revise_cards],
            "revise_cards.card_id",
        )
        removed_ids = _unique(
            [item.card_id for item in decision.remove_cards],
            "remove_cards.card_id",
        )
        self._require_subset(revised_ids | removed_ids, selected_ids, "卡片修改")
        conflicts = (
            (merged_ids & revised_ids)
            | (merged_ids & removed_ids)
            | (revised_ids & removed_ids)
        )
        if conflicts:
            raise ValueError(f"同一卡片存在冲突操作：{', '.join(sorted(conflicts))}")
        for operation in decision.revise_cards:
            self._validate_definition(operation.replacement, available_evidence)
        for operation in decision.remove_cards:
            self._validate_evidence_refs(operation.evidence_ids, available_evidence)
        for operation in decision.new_cards:
            self._validate_definition(operation.definition, available_evidence)

        card_kinds = {
            card.card_id: card.kind
            for card in inherited.cards
            if card.card_id in selected_ids
        }
        card_kinds.update(
            {
                operation.card_id: operation.definition.kind
                for operation in decision.new_cards
            }
        )
        for operation in decision.merge_cards:
            for card_id in operation.card_ids:
                card_kinds[card_id] = operation.replacement.kind
        for operation in decision.revise_cards:
            card_kinds[operation.card_id] = operation.replacement.kind
        for card_id in removed_ids:
            card_kinds.pop(card_id, None)
        available_cards = set(card_kinds)

        for operation in decision.add_edges:
            self._validate_edge(operation, card_kinds, available_evidence)
        for operation in decision.remove_edges:
            if operation.edge_id not in detailed_edges:
                raise ValueError(f"remove_edges 引用未展开的边：{operation.edge_id}")
            self._validate_evidence_refs(operation.evidence_ids, available_evidence)
        self._require_subset(
            decision.resolved_issue_ids,
            existing_issues,
            "resolved_issue_ids",
        )
        for issue in decision.deferred_issues:
            self._require_subset(issue.card_ids, available_cards, "deferred_issues")

        referenced_parent_evidence: set[str] = set()
        definitions = [
            *(item.definition for item in decision.new_cards),
            *(item.replacement for item in decision.merge_cards),
            *(item.replacement for item in decision.revise_cards),
        ]
        for definition in definitions:
            referenced_parent_evidence.update(
                set(definition.evidence_ids) & parent_evidence
            )
        for operation in [
            *decision.remove_cards,
            *decision.add_edges,
            *decision.remove_edges,
        ]:
            referenced_parent_evidence.update(
                set(operation.evidence_ids) & parent_evidence
            )
        if unused := parent_evidence - referenced_parent_evidence:
            raise ValueError(
                "父节点 source_evidence 未被任何实际卡片或边操作引用："
                f"{', '.join(sorted(unused))}；如果这些原文只提供结构或理解背景，"
                "请删除对应 source_evidence，并用 uncompiled_parent_segments 覆盖"
            )
        self._validate_parent_source_coverage(parent, decision, owned_blocks)
        return decision

    def _validate_parent_source_coverage(
        self,
        parent: RegionNode,
        decision: ParentIntegrationDecision,
        owned_blocks: tuple[ParsedBlock, ...],
    ) -> None:
        if not owned_blocks:
            if decision.source_evidence or decision.uncompiled_parent_segments:
                raise ValueError("父节点没有自有原文，不能生成父节点来源范围")
            return
        allowed = {self.index.position(block.block_id) for block in owned_blocks}
        covered: set[int] = set()
        for segment in [
            *decision.source_evidence,
            *decision.uncompiled_parent_segments,
        ]:
            left = self.index.position(segment.start_block_id)
            right = self.index.position(segment.end_block_id)
            positions = set(range(left, right + 1))
            if not positions <= allowed:
                raise ValueError(
                    f"父节点来源超出自有原文："
                    f"{segment.start_block_id} → {segment.end_block_id}"
                )
            covered.update(positions)
        missing = [
            block.block_id
            for block in owned_blocks
            if self.index.position(block.block_id) not in covered
        ]
        if missing:
            raise ValueError(
                f"父节点自有原文既无依据也无未编译说明：{', '.join(missing)}"
            )

    def _validate_definition(
        self,
        definition: IntegrationCardDefinition,
        available_evidence: set[str],
    ) -> None:
        self._validate_evidence_refs(definition.evidence_ids, available_evidence)

    def _validate_edge(
        self,
        edge: AddEdgeOperation,
        card_kinds: dict[str, str],
        available_evidence: set[str],
    ) -> None:
        refs = {edge.from_card_id, edge.to_card_id}
        if edge.context_card_id:
            refs.add(edge.context_card_id)
        self._require_subset(refs, set(card_kinds), edge.edge_id)
        if edge.from_card_id == edge.to_card_id:
            raise ValueError(f"{edge.edge_id} 不能形成自环")
        from_kind = card_kinds[edge.from_card_id]
        to_kind = card_kinds[edge.to_card_id]
        allowed_from, allowed_to = _RELATION_KIND_RULES[edge.relation_type]
        if from_kind not in allowed_from or to_kind not in allowed_to:
            raise ValueError(
                f"{edge.edge_id} 的 {edge.relation_type} 不允许 "
                f"{from_kind} → {to_kind}；起点允许 {', '.join(sorted(allowed_from))}，"
                f"终点允许 {', '.join(sorted(allowed_to))}。没有准确关系类型时请删除"
                "该边或写入 deferred_issues"
            )
        self._validate_evidence_refs(edge.evidence_ids, available_evidence)

    @staticmethod
    def _validate_evidence_refs(
        references: Iterable[str],
        available: set[str],
    ) -> None:
        unknown = set(references) - available
        if unknown:
            raise ValueError(f"引用不存在的依据：{', '.join(sorted(unknown))}")

    @staticmethod
    def _require_subset(
        values: Iterable[str],
        available: set[str],
        owner: str,
    ) -> None:
        unknown = set(values) - available
        if unknown:
            raise ValueError(f"{owner} 引用未展开项目：{', '.join(sorted(unknown))}")

    def _apply_decision(
        self,
        *,
        parent: RegionNode,
        inherited: IntegratedSubgraph,
        decision: ParentIntegrationDecision,
    ) -> IntegratedSubgraph:
        parent_evidence_map = {
            item.evidence_id: f"{parent.node_id}/{item.evidence_id}"
            for item in decision.source_evidence
        }

        def evidence_refs(values: Iterable[str]) -> list[str]:
            return _dedupe(parent_evidence_map.get(value, value) for value in values)

        evidence = [
            *inherited.evidence,
            *[
                IntegratedEvidence(
                    evidence_id=parent_evidence_map[item.evidence_id],
                    source_node_id=parent.node_id,
                    start_block_id=item.start_block_id,
                    end_block_id=item.end_block_id,
                    role=item.role,
                    note_markdown=item.note_markdown,
                )
                for item in decision.source_evidence
            ],
        ]
        cards = {item.card_id: item for item in inherited.cards}
        new_card_map = {
            item.card_id: f"{parent.node_id}/{item.card_id}"
            for item in decision.new_cards
        }
        for operation in decision.new_cards:
            definition = operation.definition
            card_id = new_card_map[operation.card_id]
            cards[card_id] = IntegratedCard(
                card_id=card_id,
                kind=definition.kind,
                title=definition.title,
                summary=definition.summary,
                content=definition.content,
                evidence_ids=evidence_refs(definition.evidence_ids),
                origin_card_ids=[card_id],
            )
        for operation in decision.revise_cards:
            previous = cards[operation.card_id]
            definition = operation.replacement
            cards[operation.card_id] = IntegratedCard(
                card_id=previous.card_id,
                kind=definition.kind,
                title=definition.title,
                summary=definition.summary,
                content=definition.content,
                evidence_ids=_dedupe(
                    [*previous.evidence_ids, *evidence_refs(definition.evidence_ids)]
                ),
                origin_card_ids=previous.origin_card_ids,
            )

        merged_to: dict[str, str] = {}
        for operation in decision.merge_cards:
            canonical_id = sorted(operation.card_ids)[0]
            sources = [cards[card_id] for card_id in operation.card_ids]
            definition = operation.replacement
            cards[canonical_id] = IntegratedCard(
                card_id=canonical_id,
                kind=definition.kind,
                title=definition.title,
                summary=definition.summary,
                content=definition.content,
                evidence_ids=_dedupe(
                    [
                        *(value for card in sources for value in card.evidence_ids),
                        *evidence_refs(definition.evidence_ids),
                    ]
                ),
                origin_card_ids=_dedupe(
                    value for card in sources for value in card.origin_card_ids
                ),
            )
            for card_id in operation.card_ids:
                merged_to[card_id] = canonical_id
                if card_id != canonical_id:
                    cards.pop(card_id)

        removed_cards = {item.card_id for item in decision.remove_cards}
        for card_id in removed_cards:
            cards.pop(card_id, None)

        def card_ref(value: str | None) -> str | None:
            if value is None:
                return None
            value = new_card_map.get(value, value)
            return merged_to.get(value, value)

        removed_edges = {item.edge_id for item in decision.remove_edges}
        edges: list[IntegratedEdge] = []
        for edge in inherited.edges:
            if edge.edge_id in removed_edges:
                continue
            from_id = card_ref(edge.from_card_id)
            to_id = card_ref(edge.to_card_id)
            context_id = card_ref(edge.context_card_id)
            if (
                from_id in removed_cards
                or to_id in removed_cards
                or context_id in removed_cards
                or from_id == to_id
            ):
                continue
            assert from_id is not None and to_id is not None
            edges.append(
                edge.model_copy(
                    update={
                        "from_card_id": from_id,
                        "to_card_id": to_id,
                        "context_card_id": context_id,
                    }
                )
            )
        for operation in decision.add_edges:
            from_id = card_ref(operation.from_card_id)
            to_id = card_ref(operation.to_card_id)
            context_id = card_ref(operation.context_card_id)
            assert from_id is not None and to_id is not None
            if from_id == to_id:
                continue
            edges.append(
                IntegratedEdge(
                    edge_id=f"{parent.node_id}/{operation.edge_id}",
                    from_card_id=from_id,
                    to_card_id=to_id,
                    context_card_id=context_id,
                    relation_type=operation.relation_type,
                    sequence=operation.sequence,
                    temporal_scope_markdown=operation.temporal_scope_markdown,
                    note_markdown=operation.note_markdown,
                    evidence_ids=evidence_refs(operation.evidence_ids),
                    origin_edge_ids=[f"{parent.node_id}/{operation.edge_id}"],
                )
            )
        edges = _dedupe_edges(edges)

        resolved = set(decision.resolved_issue_ids)
        issues = []
        for issue in inherited.unresolved_issues:
            if issue.issue_id in resolved:
                continue
            mapped_cards = [
                card_ref(card_id) for card_id in issue.card_ids
            ]
            issues.append(
                issue.model_copy(
                    update={
                        "card_ids": [
                            card_id
                            for card_id in _dedupe(mapped_cards)
                            if card_id is not None and card_id not in removed_cards
                        ]
                    }
                )
            )
        for issue in decision.deferred_issues:
            issues.append(
                IntegrationIssue(
                    issue_id=f"{parent.node_id}/{issue.issue_id}",
                    source_node_id=parent.node_id,
                    card_ids=[
                        value
                        for value in (
                            card_ref(card_id) for card_id in issue.card_ids
                        )
                        if value is not None
                    ],
                    source_segments=issue.source_segments,
                    description=issue.description,
                )
            )
        result = IntegratedSubgraph(
            cards=sorted(cards.values(), key=lambda item: item.card_id),
            edges=sorted(edges, key=lambda item: item.edge_id),
            evidence=evidence,
            unresolved_issues=issues,
        )
        _validate_integrated_subgraph(result)
        return result

    def _owned_blocks(self, node: RegionNode) -> tuple[ParsedBlock, ...]:
        positions: set[int] = set()
        for segment in node.owned_segments:
            left = self.index.position(segment.start_block_id)
            right = self.index.position(segment.end_block_id)
            positions.update(range(left, right + 1))
        return tuple(self.blocks[position] for position in sorted(positions))

    def _evidence_excerpt(self, evidence: IntegratedEvidence) -> str:
        text = " ".join(
            block.markdown.replace("\n", " ")
            for block in self.index.slice(
                evidence.start_block_id,
                evidence.end_block_id,
            )
        )
        return text if len(text) <= 400 else text[:397] + "..."

    def _snapshot(
        self,
        *,
        results: dict[str, ParentIntegrationResult],
        root_subgraph: IntegratedSubgraph | None,
        status: str,
    ) -> ParentIntegrationSnapshot:
        ordered = sorted(
            results.values(),
            key=lambda item: (-item.depth, item.node_id),
        )
        issues = [
            f"{item.node_id} {item.label}：{item.error}"
            for item in ordered
            if item.status != "integrated"
        ]
        return ParentIntegrationSnapshot(
            created_at=self.created_at,
            status=status,
            source=self.exploration.source,
            leaf_compilation_created_at=self.leaf_compilation.created_at,
            root_node_id=self.exploration.region_tree.root_node_id,
            parent_results=ordered,
            root_subgraph=root_subgraph,
            model_calls=sum(item.model_calls for item in ordered),
            issues=issues,
        )


def load_parent_integration_inputs(
    compilation_directory: Path,
) -> tuple[
    GlobalExplorationSnapshot,
    LeafCompilationSnapshot,
    tuple[ParsedBlock, ...],
]:
    directory = compilation_directory.expanduser().resolve()
    leaf_path = directory / "leaf-compilation.json"
    run_directory = directory.parent.parent
    if not leaf_path.is_file():
        raise ValueError("叶子编译目录缺少 leaf-compilation.json")
    exploration, blocks = load_exploration_inputs(run_directory)
    leaf = LeafCompilationSnapshot.model_validate_json(
        leaf_path.read_text(encoding="utf-8")
    )
    if leaf.source.sha256 != exploration.source.sha256:
        raise ValueError("叶子编译与全局勘探不是同一份文档")
    failed = [
        result
        for result in leaf.leaf_results
        if result.status != "compiled" or result.subgraph is None
    ]
    if failed:
        labels = ", ".join(f"{item.leaf_node_id} {item.label}" for item in failed)
        raise ValueError(f"叶子编译仍有失败节点，请重新编译后再整合：{labels}")
    return exploration, leaf, blocks


def create_parent_integration_directory(
    compilation_directory: Path,
) -> ParentIntegrationArtifactPaths:
    directory = (
        compilation_directory.expanduser().resolve()
        / "parent-integrations"
        / f"{datetime.now(UTC):%Y%m%dT%H%M%S%fZ}"
    )
    directory.mkdir(parents=True, exist_ok=False)
    model_streams = directory / "model-streams"
    model_streams.mkdir()
    return ParentIntegrationArtifactPaths(
        directory=directory,
        snapshot_json=directory / "parent-integration.json",
        report_markdown=directory / "parent-integration.md",
        working_json=directory / "parent-integration-working.json",
        model_streams=model_streams,
    )


def write_parent_integration_checkpoint(
    paths: ParentIntegrationArtifactPaths,
    snapshot: ParentIntegrationSnapshot,
) -> None:
    paths.working_json.write_text(snapshot.model_dump_json(indent=2), encoding="utf-8")


def write_parent_integration_artifacts(
    *,
    paths: ParentIntegrationArtifactPaths,
    snapshot: ParentIntegrationSnapshot,
) -> None:
    paths.snapshot_json.write_text(snapshot.model_dump_json(indent=2), encoding="utf-8")
    paths.report_markdown.write_text(_render_report(snapshot), encoding="utf-8")


def _render_report(snapshot: ParentIntegrationSnapshot) -> str:
    root = snapshot.root_subgraph
    lines = [
        "# 父节点逐层整合结果",
        "",
        f"> 状态：{snapshot.status}",
        f"> 父节点：{sum(item.status == 'integrated' for item in snapshot.parent_results)}/"
        f"{len(snapshot.parent_results)}",
        f"> 模型调用：{snapshot.model_calls}",
        f"> 根图卡片：{len(root.cards) if root else 0}",
        f"> 根图连线：{len(root.edges) if root else 0}",
        "",
    ]
    for result in snapshot.parent_results:
        lines.extend(
            [
                f"## {result.label}",
                "",
                (
                    f"`{result.node_id}`｜深度 {result.depth}｜{result.status}｜"
                    f"{result.input_card_count} → {result.output_card_count} 张卡片｜"
                    f"{result.output_edge_count} 条边｜{result.model_calls} 次调用"
                ),
                "",
            ]
        )
        if result.error:
            lines.extend([f"错误：{result.error}", ""])
            continue
        if result.agenda:
            lines.extend(["### 路由候选", ""])
            if not result.agenda.candidate_groups:
                lines.extend(["无。", ""])
            for group in result.agenda.candidate_groups:
                lines.append(
                    f"- `{group.kind}`：{', '.join(group.card_ids)}；{group.reason}"
                )
            if result.agenda.candidate_groups:
                lines.append("")
        if result.decision:
            decision = result.decision
            lines.extend(
                [
                    "### 增量裁决",
                    "",
                    f"- 新增卡片：{len(decision.new_cards)}",
                    f"- 合并组：{len(decision.merge_cards)}",
                    f"- 修正卡片：{len(decision.revise_cards)}",
                    f"- 删除卡片：{len(decision.remove_cards)}",
                    f"- 新增边：{len(decision.add_edges)}",
                    f"- 删除边：{len(decision.remove_edges)}",
                    f"- 新增未决项：{len(decision.deferred_issues)}",
                    "",
                ]
            )
    if root:
        lines.extend(["# 根节点候选记忆图", "", "## 卡片", ""])
        for card in root.cards:
            lines.append(
                f"- **{card.title}** (`{card.card_id}`，`{card.kind}`)：{card.summary}"
            )
        lines.extend(["", "## 连线", ""])
        for edge in root.edges:
            lines.append(
                f"- `{edge.from_card_id}` —{edge.relation_type}→ `{edge.to_card_id}`"
            )
        lines.extend(["", "## 仍未解决", ""])
        if not root.unresolved_issues:
            lines.append("无。")
        for issue in root.unresolved_issues:
            lines.append(f"- `{issue.issue_id}`：{issue.description}")
    return "\n".join(lines).rstrip() + "\n"


def _union_subgraphs(packages: list[IntegratedSubgraph]) -> IntegratedSubgraph:
    result = IntegratedSubgraph(
        cards=[item for package in packages for item in package.cards],
        edges=[item for package in packages for item in package.edges],
        evidence=[item for package in packages for item in package.evidence],
        unresolved_issues=[
            item for package in packages for item in package.unresolved_issues
        ],
    )
    _validate_integrated_subgraph(result)
    return result


def _validate_integrated_subgraph(graph: IntegratedSubgraph) -> None:
    card_ids = _unique([item.card_id for item in graph.cards], "整合卡片 ID")
    edge_ids = _unique([item.edge_id for item in graph.edges], "整合边 ID")
    evidence_ids = _unique(
        [item.evidence_id for item in graph.evidence],
        "整合来源 ID",
    )
    _unique([item.issue_id for item in graph.unresolved_issues], "整合问题 ID")
    del edge_ids
    for card in graph.cards:
        unknown = set(card.evidence_ids) - evidence_ids
        if unknown:
            raise ValueError(f"{card.card_id} 引用不存在的来源")
    for edge in graph.edges:
        refs = {edge.from_card_id, edge.to_card_id}
        if edge.context_card_id:
            refs.add(edge.context_card_id)
        if unknown := refs - card_ids:
            raise ValueError(f"{edge.edge_id} 引用不存在的卡片：{unknown}")
        if edge.from_card_id == edge.to_card_id:
            raise ValueError(f"{edge.edge_id} 不能形成自环")
        if unknown := set(edge.evidence_ids) - evidence_ids:
            raise ValueError(f"{edge.edge_id} 引用不存在的来源：{unknown}")


def _dedupe_edges(edges: list[IntegratedEdge]) -> list[IntegratedEdge]:
    by_key: dict[tuple, IntegratedEdge] = {}
    for edge in edges:
        key = (
            edge.from_card_id,
            edge.to_card_id,
            edge.context_card_id,
            edge.relation_type,
            edge.sequence,
            edge.temporal_scope_markdown,
        )
        if previous := by_key.get(key):
            by_key[key] = previous.model_copy(
                update={
                    "evidence_ids": _dedupe(
                        [*previous.evidence_ids, *edge.evidence_ids]
                    ),
                    "origin_edge_ids": _dedupe(
                        [*previous.origin_edge_ids, *edge.origin_edge_ids]
                    ),
                }
            )
        else:
            by_key[key] = edge
    return list(by_key.values())


def _json_object(raw: str) -> str:
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end < start:
        raise ValueError("模型输出中不存在 JSON 对象")
    return raw[start : end + 1]


def _unique(values: Iterable[str], name: str) -> set[str]:
    items = list(values)
    result = set(items)
    if len(result) != len(items):
        raise ValueError(f"{name} 不能重复")
    return result


def _dedupe(values: Iterable[str | None]) -> list:
    return list(dict.fromkeys(values))
