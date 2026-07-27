"""区域树提示词。"""

from __future__ import annotations

import json

from cold_start.document.blocks import format_blocks, render_heading_outline
from cold_start.document.models import ParsedBlock
from cold_start.region_tree.models import (
    ParentPartitionError,
    RegionDecisionOutput,
    RegionNode,
    RepairDecisionOutput,
    StructureIssue,
)

REGION_TREE_SYSTEM_PROMPT = """
你在为后续处理建立连续原文区域树，不是在提取记忆、评价内容价值或建立知识图谱。
节点既可以拥有直接孩子，也可以保留不应下放给任何孩子的原文。节点介绍只是低权威
上下文；只有带 block_id 的原文才是后续处理的证据。

每次只处理当前区域，只能返回：
- stop：当前区域可以整体交给下一阶段；
- split：只输出当前区域的一层直接孩子；
- parent_partition_error：直接父节点切断了内容或跳过了有意义的中间区域。

split 时，孩子只覆盖真正属于孩子的连续原文，可以在开头、中间或结尾留下空隙。
所有未被孩子覆盖的块自动成为当前节点直接拥有的原文。章节标题、统领全部孩子的
引言、孩子之间的承接文字和全节总结通常应留给当前节点，不能为了完整覆盖而塞进
第一个孩子，也不要为纯父标题额外制造孩子。孩子必须按原文顺序、互不重叠并位于
当前范围内。若只有一个孩子，当前节点必须同时留下自有原文，禁止无变化的单孩子
切分。一次严禁输出多层子树。

owned_source_role 描述当前节点直接拥有的原文：
- content_source：其中存在任何事实、定义、原则、时间、条件、判断、经验、定位或
  其他可供后续理解和编译的陈述；
- structural_context：全部只是标题、编号、目录、导航、装饰或排版标识，没有任何
  独立陈述；
- null：仅用于 split 且孩子完整覆盖当前区域，当前节点没有直接拥有的原文。

“承担引入作用”不等于 structural_context。只要引言包含实质陈述，就必须标为
content_source。stop 时当前节点拥有完整区域，因此 owned_source_role 不能为 null。

必须依次判断：
1. 检查当前节点和连续兄弟是否暴露了父分割错误；
2. 识别应由当前节点自己保留的标题、引言、承接或总结；
3. 识别其余原文中可以独立处理的直接组成部分；
4. 决定 stop 或 split，并填写当前节点自有原文的角色。

父节点会保留孩子的共同归属和顺序，因此同属工作流、清单、论证或知识体系不是停止
切分的理由。只有切分会拆开同一事实的条件与结论、规则与限制或例外、操作与必要
说明、或者必须合读的观点与证据时，才保护耦合。显式标题是边界证据，但不能机械
决定切分。篇幅短、块数少、同属一章或笼统的“整体连贯”不能单独作为 stop 理由。

introduction 只简短说明整个节点是什么，不提取记忆或评价重要性。工具结果仅用于
核对当前区域之外的边界或关联，不能并入当前节点。最终只输出符合 JSON Schema 的
JSON。
""".strip()


def root_region_prompt(
    *,
    title: str,
    blocks: tuple[ParsedBlock, ...],
) -> str:
    return f"""
[STAGE: region_tree_root]
这是完整文档的第一次结构判断，不能返回 parent_partition_error。只输出文档的直接
宏观组成部分；文档级标题或总引言可以留给根节点自己拥有。不要跳过真实存在的部分、
章节或附录层级。

标题：{title}

标题速览：
{render_heading_outline(blocks)}

完整原文：
{format_blocks(blocks)}

JSON Schema：
{_schema()}
""".strip()


def region_prompt(
    *,
    document_context: str,
    node: RegionNode,
    lineage: list[RegionNode],
    siblings: list[RegionNode],
    current_blocks: tuple[ParsedBlock, ...],
    before_blocks: tuple[ParsedBlock, ...],
    after_blocks: tuple[ParsedBlock, ...],
) -> str:
    ancestors = "\n".join(
        f"- {item.node_id}｜{item.label}：{item.introduction}" for item in lineage
    )
    sibling_text = "\n".join(
        f"- {item.node_id}｜{item.label}｜{item.start_block_id}～{item.end_block_id}："
        f"{item.introduction}"
        for item in siblings
    )
    return f"""
[STAGE: region_tree_node]
只判断节点 {node.node_id} 的下一步。

文档背景：{document_context}

根节点到直接父节点：
{ancestors or "（当前是根节点）"}

当前兄弟：
{sibling_text}

当前节点：{node.label}｜{node.start_block_id}～{node.end_block_id}
当前介绍：{node.introduction}

当前标题：
{render_heading_outline(current_blocks)}

前方紧邻原文（只供边界检查）：
{format_blocks(before_blocks) if before_blocks else "（文档开头）"}

当前区域完整原文：
{format_blocks(current_blocks)}

后方紧邻原文（只供边界检查）：
{format_blocks(after_blocks) if after_blocks else "（文档结尾）"}

当前区域已经完整给出，严禁调用工具重复搜索其中的文字或 block_id。只有确实需要查看
当前区域之外的内容时才调用工具。若问题属于父节点，引用连续兄弟 node_id 返回
parent_partition_error；一般不确定性不能算父分割错误。

JSON Schema：
{_schema()}
""".strip()


def reconsider_parent_prompt(
    *,
    document_context: str,
    parent: RegionNode,
    lineage: list[RegionNode],
    old_children: list[RegionNode],
    parent_blocks: tuple[ParsedBlock, ...],
    reported_errors: list[tuple[str, ParentPartitionError]],
) -> str:
    children = "\n".join(
        f"- {item.node_id}｜{item.label}｜{item.start_block_id}～{item.end_block_id}"
        for item in old_children
    )
    errors = "\n".join(
        f"- {node_id}：{error.problem_kind}；{error.reason}"
        for node_id, error in reported_errors
    )
    ancestors = "\n".join(f"- {item.label}：{item.introduction}" for item in lineage)
    return f"""
[STAGE: region_tree_parent_reconsideration]
孩子发现父节点 {parent.node_id} 的切分有误。重新输出 stop 或一层直接孩子，不能再次
返回 parent_partition_error。这是唯一一次自动重切机会。父标题、全局引言等原文应
由父节点自己保留，不要为了覆盖原文而创建纯标题孩子。

背景：{document_context}
祖先：{ancestors or "（根节点）"}
父节点：{parent.label}：{parent.introduction}

旧孩子：
{children}

反馈：
{errors}

父区域完整原文：
{format_blocks(parent_blocks)}

JSON Schema：
{_schema()}
""".strip()


STRUCTURE_REPAIR_SYSTEM_PROMPT = """
你在复核程序通过显式编号发现的局部标题层级问题，不做全树校准，不提取记忆。
若问题成立，返回 split，只重建目标节点的一层孩子，并允许目标节点直接拥有统领
孩子的标题和引言；若编号来自解析错误或现有结构已经正确，返回 keep。也可以在目标
确实不应继续分区时返回 stop。遵守区域树的原文归属、角色和单层切分规则。只输出
符合 JSON Schema 的 JSON。
""".strip()


def structure_repair_prompt(
    *,
    document_context: str,
    node: RegionNode,
    lineage: list[RegionNode],
    siblings: list[RegionNode],
    current_subtree: str,
    current_blocks: tuple[ParsedBlock, ...],
    before_blocks: tuple[ParsedBlock, ...],
    after_blocks: tuple[ParsedBlock, ...],
    issues: list[StructureIssue],
) -> str:
    ancestors = "\n".join(
        f"- {item.node_id}｜{item.label}：{item.introduction}" for item in lineage
    )
    sibling_text = "\n".join(
        f"- {item.node_id}｜{item.label}｜{item.start_block_id}～{item.end_block_id}："
        f"{item.introduction}"
        for item in siblings
    )
    issue_text = "\n".join(f"- {item.reason}" for item in issues)
    return f"""
[STAGE: region_tree_structure_repair]
只复核子树 {node.node_id}。

文档背景：{document_context}
祖先：{ancestors or "（当前是根节点）"}
当前兄弟：
{sibling_text}

程序发现的标题层级问题：
{issue_text}

旧子树：
{current_subtree}

目标区域完整原文：
{format_blocks(current_blocks)}

相邻原文：
{format_blocks(before_blocks + after_blocks) if before_blocks or after_blocks else "（无）"}

若重切，父级标题和统领全部孩子的引言应留给当前节点直接拥有。不要创建纯标题孩子。

JSON Schema：
{json.dumps(RepairDecisionOutput.model_json_schema(), ensure_ascii=False, separators=(",", ":"))}
""".strip()


def repair_decision_prompt(
    *,
    invalid_output: str,
    error: str,
) -> str:
    return (
        f"上一次输出未形成可用结构化判断：{error}\n"
        f"上一次正式输出：{invalid_output}\n"
        "请基于本对话已有内容，只输出修正后的完整 JSON。"
    )


def _schema() -> str:
    return json.dumps(
        RegionDecisionOutput.model_json_schema(),
        ensure_ascii=False,
        separators=(",", ":"),
    )
