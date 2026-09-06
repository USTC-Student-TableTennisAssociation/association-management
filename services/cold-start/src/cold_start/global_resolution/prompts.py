"""SourceRegion 级 Global Object 身份对齐提示词。"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

GLOBAL_IDENTITY_SYSTEM_PROMPT = """
你负责把当前 SourceRegion 的局部 Fragment 对齐到稳定的 Global Object。只裁决 Objecthood、
词义和 identity；Assertion 内容已经冻结。

先独立判断每个 Fragment 是否需要跨命题维持长期身份，再处理分类和 identity。Fragment 的存在、
出现次数和 identity_mode_hint 都不证明 Objecthood；reject/defer 只取消 Object 提升，原 Assertion
事实会完整保留。候选只用于检索，不证明 identity。

Objecthood 成立后再把 identity_mode_hint 作为可纠正的证据模式：named_person 需要直接身份依据；
role_type 比较角色语义与组织作用域；entity_type 比较类别的实际用法；named_entity 比较名称与来源
关系；undetermined 根据当前证据选择合适模式。仅作为其他对象的属性、状态、情绪、评价或程度出现
的内容不需要长期身份。

只处理当前 Region 引入的必要变化。语义相关、共同出现或名称相似都不等于同一 Object。
Objecthood 成立且证据足够时 attach；Objecthood 成立但没有匹配身份时 create；不需要长期身份时
reject；Objecthood 或词义仍不清楚时 defer；只有多个 Fragment 或已有 Object 必须共同调整时使用
联合计划。

联合计划中的 create/attach 只分配 incoming atoms；merge/split 才重分配
source_global_object_ids 所列已有 Object 的全部 atoms。所有 operation 基于同一旧 Registry
快照。当前 Region 的 incoming atoms，以及被 merge/split 的已有 atoms，都必须各出现一次。
reference atom 按 Assertion 中的实际指称分配；结构细节服从输出 JSON Schema。

候选不足以证明同一身份，不能反向证明 incoming 是 Object。只有当前证据先独立证明其长期身份时
才 create；Objecthood 不成立时 reject，证据不足时 defer。

同一 surface form 可以对应多个长期 Object；reference atom 必须按 Assertion 中的实际指称分配。

当前证据足够时直接提交。只有结论取决于同一名称在本来源其他 Region 的用法时，才调用
inspect_source_fragment_usage；频次只提供语境，不直接决定保留、合并或拒绝。

已有 target 使用输入中的 global_object_id；新 target 的 canonical_name 选自所属 surface atom。

输出严格合法的 JSON 正文，不要 Markdown fence，不要输出 JSON 之外的解释。JSON 字符串内
不得出现未转义的 ASCII 双引号 "；描述名称时优先使用中文引号“”，否则必须写成 \\"。
""".strip()


_FRAGMENT_IDENTITY_CORE_PROMPT = """
你只裁决一个 source-local Fragment。先独立判断它是否需要跨命题维持长期 Object 身份，再判断
词义和全局 identity。Fragment 的存在、出现次数、候选数量和 identity_mode_hint 都不证明
Objecthood；reject/defer 只取消 Object 提升，原 Assertion 事实仍完整保留。

Objecthood 成立且同一性证据充分时 attach；Objecthood 成立但没有匹配身份时 create；不需要长期
身份时 reject；证据不足时 defer；必须联合其他 Fragment 或重构已有 Object 时 joint。候选相似度
只用于召回。只有结论确实依赖其他 Region 的用法时才调用 inspect_source_fragment_usage。完成后
立即提交符合 Schema 的 JSON。
""".strip()

_IDENTITY_MODE_PROMPTS = {
    "named_person": (
        "若 Objecthood 成立，上游建议按具体人物检查。姓名、称谓、组织或时间相容只用于召回；"
        "attach 需要明确名称映射、"
        "稳定标识或其他能够排除同名歧义的直接证据。"
    ),
    "role_type": (
        "若 Objecthood 成立，上游建议按角色类型检查。按角色语义与组织作用域判断 identity；"
        "不要求人物身份凭据。"
    ),
    "entity_type": (
        "若 Objecthood 成立，上游建议按可复用类别检查。按当前命题中的实际用法判断词义；"
        "该提示本身不证明它是类别。"
    ),
    "named_entity": (
        "若 Objecthood 成立，上游建议按具名实例或稳定对象检查。按名称证据、语义位置与来源关系"
        "判断 identity。"
    ),
    "undetermined": (
        "上游无法确定身份模式。依据当前 Assertion、原文及必要的跨 Region 用法，"
        "独立判断 Objecthood；"
        "成立后再选择合适的身份标准。"
    ),
}


OBJECT_ADMISSION_SYSTEM_PROMPT = """
你是 provisional Global Object 发布前的 Objecthood 准入闸门。只复审 Runtime 标记的低证据
Object，不重写 Assertion，也不按出现次数自动裁决。demote/defer 只取消节点提升，事实原文仍保留。

当跨命题维持“同一个对象或同一种业务类型”的身份，能够承载稳定属性、关系、规则或生命周期时
admit。若内容在现有证据中仅作为其他对象的属性、状态、情绪、评价、程度或临时描述出现，则
demote。证据不足以可靠判断时 defer。完成后立即提交符合 Schema 的 JSON。
""".strip()


def fragment_identity_system_prompt(identity_mode_hint: str) -> str:
    mode_prompt = _IDENTITY_MODE_PROMPTS.get(identity_mode_hint)
    if mode_prompt is None:
        raise ValueError(f"未知 identity_mode_hint：{identity_mode_hint}")
    return f"{_FRAGMENT_IDENTITY_CORE_PROMPT}\n\n{mode_prompt}"


def fragment_identity_alignment_prompt(
    *,
    fragment: Mapping[str, Any],
    peer_fragments: Sequence[Mapping[str, Any]],
    candidates: Sequence[Mapping[str, Any]],
    decision_schema: Mapping[str, Any],
) -> str:
    """序列化一个 Fragment 的紧凑、可独立裁决上下文。"""

    payload = {
        "fragment": fragment,
        "peer_fragments": list(peer_fragments),
        "candidate_global_objects": list(candidates),
    }
    return (
        "请先给出 objecthood，再裁决当前 Fragment。普通结果直接 create/attach/reject/defer；"
        "只有共指、词义拆分或"
        "已有 Object merge/split 无法独立处理时才选择 joint。\n\n"
        "输入：\n"
        f"{json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}\n\n"
        "输出必须满足以下 JSON Schema：\n"
        f"{json.dumps(decision_schema, ensure_ascii=False, separators=(',', ':'))}"
    )


def region_identity_alignment_prompt(
    *,
    incoming: Mapping[str, Any],
    candidate_ids_by_fragment: Mapping[str, Sequence[str]],
    candidates: Sequence[Mapping[str, Any]],
    decision_schema: Mapping[str, Any],
    source_usage_by_fragment: Mapping[str, Mapping[str, Any]] | None = None,
) -> str:
    """序列化一个 SourceRegion 的完整、有限身份对齐上下文。"""

    payload = {
        "incoming_source_region": incoming,
        "candidate_ids_by_fragment": {
            key: list(value) for key, value in candidate_ids_by_fragment.items()
        },
        "candidate_global_objects": list(candidates),
    }
    if source_usage_by_fragment:
        payload["inspected_source_usage_by_fragment"] = dict(source_usage_by_fragment)
    return (
        "请对下面整个 SourceRegion 做一次全局身份对齐。先独立判断 Objecthood；没有候选不能作为"
        "create 的理由。Objecthood 成立且没有匹配身份时 create；不需要长期身份时 reject，证据"
        "不足时 defer。operations 是同一"
        "旧 Registry 上的声明式联合计划。\n\n"
        "输入：\n"
        f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n\n"
        "输出必须满足以下 JSON Schema：\n"
        f"{json.dumps(decision_schema, ensure_ascii=False, indent=2)}"
    )


def object_admission_prompt(
    *,
    provisional_object: Mapping[str, Any],
    decision_schema: Mapping[str, Any],
) -> str:
    return (
        "请独立复审下面的 provisional Object。统计量只说明为何触发复审，不是删除或保留阈值。\n\n"
        "输入：\n"
        f"{json.dumps(provisional_object, ensure_ascii=False, separators=(',', ':'))}\n\n"
        "输出必须满足以下 JSON Schema：\n"
        f"{json.dumps(decision_schema, ensure_ascii=False, separators=(',', ':'))}"
    )


__all__ = [
    "GLOBAL_IDENTITY_SYSTEM_PROMPT",
    "OBJECT_ADMISSION_SYSTEM_PROMPT",
    "fragment_identity_alignment_prompt",
    "fragment_identity_system_prompt",
    "object_admission_prompt",
    "region_identity_alignment_prompt",
]
