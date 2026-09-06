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

REGION_BOUNDARY_RULES = """
叶子是后续一次局部语义编译所需的最小连续原文区域，不是事实或 Object。

除去父节点应保留的统领文字后，如果存在两个或更多可以独立理解和编译的连续部分，选择
split。独立意味着每个部分自身足以确定主体、字段含义、共同条件和内部关系。

如果表头与表体、主体与短项、规则与条件/例外、同一实践的情境/做法/结果等必须共同阅读，
选择 stop。格式边界本身不决定切分；完整的同级内容也不能被当作父节点空隙跳过。
""".strip()


REGION_TREE_SYSTEM_PROMPT = f"""
你只负责把连续 Source Blocks 组织成后续语义编译所需的 Region Tree。节点表达上下文边界，
不表达知识、Object 类型或内容价值；只有带 block_id 的原文是证据。

每次只判断当前区域的一层：
- stop：当前区域可以整体交给下一阶段；
- split：只输出当前区域的一层直接孩子；
- parent_partition_error：移动完整原文块或增加中间节点可以修复的父节点错误。

解析错误写入 source_issues，同时按现有完整 block 做正确的 stop/split。只有重新分配完整 block
或增加中间节点能修复的问题才是 parent_partition_error。

split 的孩子必须连续、按原文顺序、互不重叠，只覆盖真正属于自己的 blocks。未覆盖 blocks
由当前节点保留，通常包括父标题、全局引言、承接和总结。只输出直接孩子；单孩子切分必须
确实把一部分实质原文留在父节点。

owned_source_role 只描述当前节点自己保留的 blocks：有实质陈述用 content_source；只有标题、
目录或排版标识用 structural_context；孩子完整覆盖、父节点没有 blocks 时用 null。stop 不能用
null，含实质说明的引言属于 content_source。

统一边界标准：
{REGION_BOUNDARY_RULES}

introduction 只说明节点内容范围。工具只用于核对区域之外的边界。输出符合 JSON Schema。
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
parent_partition_error；只有重新分配完整 block 或增加中间节点能够解决时才属于父
分割错误。编号异常、跨页残片、同一 block 混入多节内容应记录在 source_issues，
不能要求父节点重切。

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


STRUCTURE_REPAIR_SYSTEM_PROMPT = f"""
你只复核程序标出的局部标题层级问题，判断当前完整原文块是否已经属于语义正确的节点。
归属正确时返回 keep，并把编号、跨页或解析异常记入 source_issues；归属确实错误时返回
split，目标不应继续分区时返回 stop。沿用区域树的连续归属与单层切分规则，不提取知识。

复核时沿用同一叶子停止条件：
{REGION_BOUNDARY_RULES}
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

旧子树（只列真实树节点；原文中的标题不会在这里伪装成孩子）：
{current_subtree}

目标区域完整原文：
{format_blocks(current_blocks)}

相邻原文：
{format_blocks(before_blocks + after_blocks) if before_blocks or after_blocks else "（无）"}

若异常编号已经处在语义正确的节点内，返回 keep 并记录 source_issues。若重切，父级
标题和统领全部孩子的引言应留给当前节点直接拥有。不要创建纯标题孩子。

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
