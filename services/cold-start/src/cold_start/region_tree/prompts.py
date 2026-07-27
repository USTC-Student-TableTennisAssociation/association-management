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
    TreeAudit,
    TreeAuditIssue,
)

REGION_TREE_SYSTEM_PROMPT = """
你在为后续处理建立连续原文区域树，不是在提取记忆、评价内容价值或建立知识图谱。
叶子是可以整体交给下一阶段处理的最小完整原文区域。“最小”不表示字数最少，而是
内部不再包含两个可以分别处理、又不会破坏必要关系的直接组成部分。

每次只处理当前区域，只能返回：
- stop：当前区域已经是最小完整处理区域；
- split：只给出当前区域的一层直接孩子；
- parent_partition_error：直接父节点切断了上下文，或跳过了有意义的中间连续区域。

必须依次判断：
1. 先检查当前节点与相邻兄弟之间是否存在父分割错误；
2. 再识别当前区域内部承担不同表达任务的直接组成部分；
3. 判断分开处理是否会割裂同一流程、论证、清单、表格、证据关系或连续叙事；
4. 决定 stop 或 split；
5. 只有 stop 后，才判断叶子是 content_source 还是 structural_context。

切分不要求孩子大小、语义类型或抽象程度一致。核心是不能跳过对后续阅读有用的中间
整体，也不能切断强耦合内容。若部分标题或分隔页统领后续多个章节，应保留这个中间
层，不能把分隔页塞进第一个章节后直接输出更下层章节。一个无法与相邻内容组成更小
整体的独立命题可以单独成为孩子。

content_source 表示原文主要在陈述内容，应交给后续阶段阅读，但不表示一定形成记忆。
structural_context 表示原文主要负责标识、导航、分组、引入或承接其他内容，不应独立
编译。目录通常是 structural_context；前言、附录、历史记录和名单必须根据实际表达
判断，不能按位置机械分类。若结构文字和正文可以分开，继续切分；确实无法分开时，
整体作为 content_source。

显式标题是边界证据，但不能机械决定切分。选择 stop 时，如果区域内存在多个显式
标题，reason 必须说明分开会破坏什么必要关系。篇幅短、只有一页、块数少、同属一章
或笼统的“整体连贯”都不能作为 stop 的理由。

孩子必须使用给定 block_id，按原文顺序无重叠、无遗漏地覆盖当前区域。一次严禁输出
多层子树。父节点只负责产生孩子，不能替孩子判断是否结束；每个孩子之后都会独立
接受 stop/split 判断。introduction 只简短说明这段原文是什么，不提取知识或评价
重要性。工具结果仅供核对，不能并入当前区域。最终只输出符合 JSON Schema 的 JSON。
""".strip()


def root_region_prompt(
    *,
    title: str,
    blocks: tuple[ParsedBlock, ...],
) -> str:
    return f"""
[STAGE: region_tree_root]
这是完整文档的第一次结构判断，不能返回 parent_partition_error。若文档存在多个
直接宏观区域，只输出这一层孩子；只有整份文档本身就是一个不可再分的完整处理区域时
才能 stop。
优先保留文档显式的部分层级、前言和附录边界；不要为了得到整齐的若干大块而跳过
真实存在的中间部分。

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

作答前严格遵守系统提示词中的判断顺序。先决定结构是否结束；只有决定 stop 后才填写
leaf_role，不要用角色判断反推是否停止。

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
        f"上一次输出未形成可用结构化判断：{error}\n"
        f"上一次正式输出：{invalid_output}\n"
        "请基于本对话已有的当前区域和工具结果，只输出修正后的完整 JSON。"
    )


TREE_AUDIT_SYSTEM_PROMPT = """
你负责校准已经完成的连续原文区域树，只检查结构边界和叶子角色的一致性，不重新分析
文档内容，不提取记忆，也不要求叶子大小、深度或语义类型整齐。

只报告明确问题：
- under_split：一个叶子仍含多个可分别处理且不强耦合的直接区域；
- over_split：相邻区域割裂了必须共同处理的流程、论证、清单、表格或证据关系；
- missing_intermediate：若干相邻节点之间跳过了有意义的共同中间层；
- boundary_mismatch：标题、引言、分隔内容或正文落入错误区域；
- leaf_role_mismatch：content_source 与 structural_context 明显标反。

篇幅、页数、块数和不同深度只能帮助定位，不能单独构成问题。显式标题是边界证据，
也不是自动切分规则。最多报告八个最明确、修复范围不重复的问题；target_node_id 必须
指向能够独立重做的最小子树根节点。没有明确问题时输出空 issues。证据不足时保留
现状。只输出符合 JSON Schema 的 JSON。
""".strip()


def tree_audit_prompt(
    *,
    document_context: str,
    tree_outline: str,
) -> str:
    return f"""
[STAGE: region_tree_audit]
请从全树视角检查局部判断是否使用了相同的边界标准。不要直接设计新树，只指出需要
重新判断的最小子树范围。不同大小的叶子可以完全合理。

文档背景：
{document_context}

当前区域树：
{tree_outline}

JSON Schema：
{json.dumps(TreeAudit.model_json_schema(), ensure_ascii=False, separators=(",", ":"))}
""".strip()


REGION_REPAIR_SYSTEM_PROMPT = """
你在依据一次全树校准，对一个连续原文子树进行定点复核。校准意见只是需要检查的
假设，不是必须接受的结论。你仍然不能提取记忆或评价内容价值。

只能返回：
- keep：旧子树结构和叶子角色正确，保持不变；
- stop：目标区域应整体成为叶子，并填写 leaf_role；
- split：替换目标区域的旧子树，只输出一层直接孩子。

仍然遵守最小完整处理区域、强耦合保护、不得跳过中间层、孩子连续完整覆盖以及一次
禁止输出多层子树等规则。不同孩子无需大小一致。只输出符合 JSON Schema 的 JSON。
""".strip()


def repair_region_prompt(
    *,
    document_context: str,
    node: RegionNode,
    lineage: list[RegionNode],
    siblings: list[RegionNode],
    current_subtree: str,
    current_blocks: tuple[ParsedBlock, ...],
    before_blocks: tuple[ParsedBlock, ...],
    after_blocks: tuple[ParsedBlock, ...],
    issues: list[TreeAuditIssue],
) -> str:
    ancestors = "\n".join(
        f"- {item.node_id}｜{item.label}：{item.introduction}" for item in lineage
    )
    sibling_text = "\n".join(
        f"- {item.node_id}｜{item.label}｜{item.start_block_id}～{item.end_block_id}："
        f"{item.introduction}"
        for item in siblings
    )
    issue_text = "\n".join(
        f"- {item.kind}：{item.reason}" for item in issues
    )
    return f"""
[STAGE: region_tree_repair]
只复核子树 {node.node_id}。

文档背景：{document_context}

根节点到直接父节点：
{ancestors or "（当前是根节点）"}

当前兄弟：
{sibling_text}

校准意见：
{issue_text}

旧子树：
{current_subtree}

当前标题：
{render_heading_outline(current_blocks)}

前方紧邻原文（只供边界检查）：
{format_blocks(before_blocks) if before_blocks else "（文档开头）"}

目标区域完整原文：
{format_blocks(current_blocks)}

后方紧邻原文（只供边界检查）：
{format_blocks(after_blocks) if after_blocks else "（文档结尾）"}

目标区域完整原文已经给出，不得调用工具重复读取内部内容。只有必须核对区域外原文时
才调用工具。若校准意见不成立，返回 keep 并明确说明必要关系；不要为了响应校准而
强行改树。

JSON Schema：
{json.dumps(RepairDecisionOutput.model_json_schema(), ensure_ascii=False, separators=(",", ":"))}
""".strip()


def _schema() -> str:
    return json.dumps(
        RegionDecisionOutput.model_json_schema(),
        ensure_ascii=False,
        separators=(",", ":"),
    )
