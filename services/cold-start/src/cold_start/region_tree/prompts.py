"""区域树提示词。"""

from __future__ import annotations

import json

from cold_start.document.blocks import format_blocks, render_heading_outline
from cold_start.document.models import ParsedBlock
from cold_start.region_tree.models import (
    ParentPartitionError,
    RegionDecisionOutput,
    RegionNode,
)

REGION_TREE_SYSTEM_PROMPT = """
你在为后续记忆编译建立连续原文区域树，不是在提取记忆或建立知识图谱。

每次只处理当前区域，只能返回：
- stop：当前区域已经适合整体交给后续记忆编译；
- split：只给出当前区域的一层直接孩子；
- parent_partition_error：直接父节点切断了上下文，或跳过了有意义的中间连续区域。

只有当前区域内部已经没有两个可独立阅读、独立形成记忆的连续部分，或者继续切分会
割裂同一流程、论证、清单、表格或连续叙事时，才能 stop。主题相同、同属一章或篇幅
不长，都不足以说明它应该 stop。

切分不要求孩子大小、语义类型或抽象程度一致。核心是不能跳过对后续阅读有用的中间
整体，也不能切断强耦合内容。若部分标题或分隔页统领后续多个章节，应保留这个中间
层，不能把分隔页塞进第一个章节后直接输出更下层章节。一个无法与相邻内容组成更小
整体的独立命题可以单独成为孩子。

孩子必须使用给定 block_id，按原文顺序无重叠、无遗漏地覆盖当前区域。一次严禁输出
多层子树。父节点只负责产生孩子，不能替孩子判断是否结束；每个孩子之后都会独立
接受 stop/split 判断。introduction 只简短说明这段原文是什么，不提取知识或评价
重要性。工具结果仅供核对，不能并入当前区域。最终只输出符合 JSON Schema 的 JSON。
""".strip()


def root_region_prompt(
    *,
    title: str,
    document_context: str,
    blocks: tuple[ParsedBlock, ...],
) -> str:
    return f"""
[STAGE: region_tree_root]
这是完整文档的第一次切分，不能返回 parent_partition_error，只能输出直接孩子。
优先保留文档显式的部分层级、前言和附录边界；不要为了得到整齐的若干大块而跳过
真实存在的中间部分。

标题：{title}
背景：{document_context}

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
{ancestors}

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

当前区域完整原文已经在提示词中，严禁调用工具重复读取当前节点或当前区域内部块。
只有需要查看当前区域之外的内容时才调用工具。若问题真正属于父节点，引用连续兄弟
node_id 返回 parent_partition_error；一般不确定性不能算父分割错误。

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
孩子发现父节点 {parent.node_id} 的切分有误。请重新输出 stop 或一层直接孩子；不能再次
返回 parent_partition_error。这是唯一一次自动重切机会。

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


def repair_decision_prompt(
    *,
    invalid_output: str,
    error: str,
) -> str:
    return (
        f"上一次输出未形成可用判断：{error}\n"
        f"上一次正式输出：{invalid_output}\n"
        "请基于本对话已有的当前区域和工具结果，只输出修正后的完整 JSON。"
    )


def _schema() -> str:
    return json.dumps(
        RegionDecisionOutput.model_json_schema(),
        ensure_ascii=False,
        separators=(",", ":"),
    )
