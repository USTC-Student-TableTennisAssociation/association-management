"""逐个 SourceRegion 更新本地 Global Registry。"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from uuid import NAMESPACE_URL, uuid5

from cold_start.compilation.source_semantics import normalize_json_fence
from cold_start.global_resolution.artifacts import (
    GlobalResolutionPaths,
    SourceCompilationDataset,
    write_final_artifact,
    write_working_registry,
)
from cold_start.global_resolution.finalization import (
    build_global_assertions_artifact,
    write_global_assertions_artifact,
)
from cold_start.global_resolution.models import (
    ActiveGlobalObject,
    AssertionEvidence,
    RegionIntegrationPlan,
    RegistryState,
    SourceFragmentDossier,
    SourceRegionDossier,
    ValidatedRegionPlan,
    assertion_key,
    validate_region_integration_plan,
)
from cold_start.global_resolution.prompts import (
    GLOBAL_IDENTITY_SYSTEM_PROMPT,
    region_identity_alignment_prompt,
)
from cold_start.global_resolution.retrieval import GlobalObjectCandidateRetriever
from cold_start.llm.base import ChatModel
from cold_start.llm.openai_compatible import ModelRepetitionError
from cold_start.progress import NullProgressReporter, ProgressReporter


class GlobalObjectResolverRunner:
    def __init__(
        self,
        *,
        model: ChatModel,
        dataset: SourceCompilationDataset,
        paths: GlobalResolutionPaths,
        state: RegistryState,
        retriever: GlobalObjectCandidateRetriever,
        progress: ProgressReporter | None = None,
    ) -> None:
        if state.source_sha256 != dataset.source_sha256:
            raise ValueError("Global Registry 不属于当前 Source Semantic")
        if state.source_node_ids != list(dataset.source_node_ids):
            raise ValueError("Global Registry 与 SourceRegion 顺序不一致")
        self.model = model
        self.dataset = dataset
        self.paths = paths
        self.state = state
        self.retriever = retriever
        self.progress = progress or NullProgressReporter()

    async def run_all(
        self,
        *,
        stop_after: int | None = None,
        final: bool = True,
    ) -> RegistryState:
        start = self.state.next_source_region_ordinal
        if start == len(self.dataset.regions):
            if final:
                if start != len(self.state.source_node_ids):
                    raise ValueError("完整 Global Resolution 仍有未就绪的 SourceRegion")
                self.progress.report("全局对象", "当前 Global Resolution 已完成")
                self._write_completed_artifacts(self.state)
            return self.state
        limit = len(self.dataset.regions)
        if stop_after is not None:
            if stop_after < 1:
                raise ValueError("stop_after 必须大于 0")
            limit = min(limit, start + stop_after)

        state = self.state
        for sequence in range(start, limit):
            incoming = self.dataset.regions[sequence]
            label = f"全局对象·{incoming.source_node_id}"
            self.progress.report(
                label,
                f"开始 {sequence + 1}/{len(self.dataset.regions)}："
                f"{len(incoming.fragments)} 个 Fragment",
            )
            if not incoming.fragments:
                state = state.model_copy(update={"next_source_region_ordinal": sequence + 1})
                write_working_registry(self.paths, self.dataset, state)
                self.progress.report(label, "当前 SourceRegion 没有 Fragment，直接推进 checkpoint")
                continue

            candidates_by_fragment: dict[str, list[ActiveGlobalObject]] = {}
            for fragment in incoming.fragments:
                candidates = await self.retriever.retrieve(
                    fragment,
                    state,
                    region_label=incoming.region_label,
                    context_markdown=incoming.context_markdown,
                )
                candidates_by_fragment[fragment.fragment_key] = candidates
                self.progress.report(
                    label,
                    f"{fragment.source_fragment_id} 召回 {len(candidates)} 个候选",
                )
            plan = await self._decide(
                incoming=incoming,
                candidates_by_fragment=candidates_by_fragment,
                registry=state,
                request_label=label,
            )
            validated = validate_region_integration_plan(
                plan,
                incoming=incoming,
                registry=state,
                candidates_by_fragment=candidates_by_fragment,
            )
            state = apply_region_plan(
                plan=validated,
                state=state,
                dataset=self.dataset,
                sequence=sequence,
            )
            write_working_registry(self.paths, self.dataset, state)
            actions = "/".join(item.action for item in validated.operations)
            self.progress.report(
                label,
                f"完成 {actions}；Global Objects {len(state.objects)}",
            )

        self.state = state
        if final and state.next_source_region_ordinal == len(self.dataset.regions):
            if state.next_source_region_ordinal != len(state.source_node_ids):
                raise ValueError("完整 Global Resolution 仍有未就绪的 SourceRegion")
            self._write_completed_artifacts(state)
        return state

    def _write_completed_artifacts(self, state: RegistryState) -> None:
        global_assertions = build_global_assertions_artifact(self.dataset, state)
        write_final_artifact(self.paths, self.dataset, state)
        output = write_global_assertions_artifact(self.paths.directory, global_assertions)
        self.progress.report(
            "全局命题",
            f"{global_assertions.total_assertions} 条 Assertion；"
            f"新增 {global_assertions.total_literal_reference_atoms} 个字符串 reference atom；"
            f"{output}",
        )

    async def _decide(
        self,
        *,
        incoming: SourceRegionDossier,
        candidates_by_fragment: Mapping[str, Sequence[ActiveGlobalObject]],
        registry: RegistryState,
        request_label: str,
    ) -> RegionIntegrationPlan:
        candidate_by_id = {
            item.global_object_id: item
            for candidates in candidates_by_fragment.values()
            for item in candidates
        }
        user_prompt = region_identity_alignment_prompt(
            incoming=region_prompt_payload(incoming),
            candidate_ids_by_fragment={
                fragment_key: [item.global_object_id for item in candidates]
                for fragment_key, candidates in candidates_by_fragment.items()
            },
            candidates=[
                candidate_prompt_payload(item)
                for item in sorted(
                    candidate_by_id.values(),
                    key=lambda value: value.global_object_key,
                )
            ],
            decision_schema=RegionIntegrationPlan.model_json_schema(),
        )
        last_error: Exception | None = None
        last_content: str | None = None
        for attempt in range(1, 3):
            retry_note = ""
            repair_request: str | None = None
            if last_error is not None:
                retry_instruction, repair_request = _retry_instruction(
                    error=last_error,
                    previous_content=last_content,
                    incoming=incoming,
                    registry=registry,
                    candidates_by_fragment=candidates_by_fragment,
                )
                retry_note = "\n\n" + retry_instruction
                self.progress.report(request_label, "协议失败，进行一次 clean retry")
            try:
                messages: list[dict[str, str]] = [
                    {
                        "role": "system",
                        "content": GLOBAL_IDENTITY_SYSTEM_PROMPT + retry_note,
                    },
                    {"role": "user", "content": user_prompt},
                ]
                if repair_request is not None and last_content is not None:
                    messages.extend(
                        [
                            {"role": "assistant", "content": last_content},
                            {
                                "role": "user",
                                "content": repair_request,
                            },
                        ]
                    )
                turn = await self.model.complete_turn(
                    messages=messages,
                    request_label=(
                        request_label if attempt == 1 else f"{request_label}·clean-retry"
                    ),
                    thinking="enabled",
                )
                if turn.tool_calls or not turn.content:
                    raise ValueError("模型没有返回 JSON 正文")
                last_content = turn.content
                plan = RegionIntegrationPlan.model_validate_json(normalize_json_fence(turn.content))
                validate_region_integration_plan(
                    plan,
                    incoming=incoming,
                    registry=registry,
                    candidates_by_fragment=candidates_by_fragment,
                )
                return plan
            except (ModelRepetitionError, ValueError) as error:
                last_error = error
        assert last_error is not None
        raise ValueError(
            "SourceRegion 身份对齐连续失败：" + _short_error(last_error)
        ) from last_error


def apply_region_plan(
    *,
    plan: ValidatedRegionPlan,
    state: RegistryState,
    dataset: SourceCompilationDataset,
    sequence: int,
) -> RegistryState:
    if sequence != state.next_source_region_ordinal:
        raise ValueError("RegistryState cursor 与待处理 SourceRegion 不一致")
    if state.source_node_ids[sequence] != plan.incoming.source_node_id:
        raise ValueError("integration plan 不属于当前 SourceRegion")

    objects = state.object_by_id()
    target_ids: dict[tuple[int, int], str] = {}
    for operation_index, operation in enumerate(plan.operations):
        source_ids = {item.global_object_id for item in operation.source_objects}
        surviving_source_ids = {
            group.existing_target.global_object_id
            for group in operation.groups
            if group.existing_target is not None
        } & source_ids
        for source_id in source_ids - surviving_source_ids:
            objects.pop(source_id)
        for source_id in surviving_source_ids:
            objects[source_id] = objects[source_id].model_copy(
                update={"surface_atoms": [], "reference_atoms": [], "assertions": []}
            )

        for group_index, group in enumerate(operation.groups):
            position = (operation_index, group_index)
            if group.existing_target is not None:
                target_ids[position] = group.existing_target.global_object_id
                continue
            object_id = _new_global_object_id(
                state=state,
                source_object_ids=source_ids,
                surface_atom_ids=[item.atom_id for item in group.surface_atoms],
            )
            target_ids[position] = object_id
            objects[object_id] = ActiveGlobalObject(
                global_object_id=object_id,
                global_object_key=f"global-{sequence + 1:06d}-{object_id}",
                canonical_name=group.target.canonical_name or "",
            )

    for operation_index, operation in enumerate(plan.operations):
        for group_index, group in enumerate(operation.groups):
            target_id = target_ids[(operation_index, group_index)]
            target = objects[target_id]
            references = [*target.reference_atoms, *group.reference_atoms]
            assertion_ids = list(
                dict.fromkeys(
                    assertion_key(atom.source_node_id, atom.source_claim_id) for atom in references
                )
            )
            objects[target_id] = target.model_copy(
                update={
                    "surface_atoms": [*target.surface_atoms, *group.surface_atoms],
                    "reference_atoms": references,
                    "assertions": [dataset.assertions[item] for item in assertion_ids],
                }
            )
    return RegistryState(
        source_sha256=state.source_sha256,
        source_node_ids=state.source_node_ids,
        next_source_region_ordinal=state.next_source_region_ordinal + 1,
        objects=sorted(objects.values(), key=lambda item: item.global_object_key),
    )


def region_prompt_payload(incoming: SourceRegionDossier) -> dict[str, object]:
    return {
        "source_node_id": incoming.source_node_id,
        "region_label": incoming.region_label,
        "lineage_node_ids": incoming.lineage_node_ids,
        "fragments": [fragment_prompt_payload(item) for item in incoming.fragments],
        "assertions": [_assertion_prompt_payload(item) for item in incoming.assertions],
        "source_context_markdown": _truncate(incoming.context_markdown, 20_000),
    }


def fragment_prompt_payload(incoming: SourceFragmentDossier) -> dict[str, object]:
    return {
        "fragment_key": incoming.fragment_key,
        "source_fragment_id": incoming.source_fragment_id,
        "surface_atoms": [
            {"atom_id": item.atom_id, "surface_form": item.surface_form}
            for item in incoming.surface_atoms
        ],
        "reference_atoms": [
            {
                "atom_id": item.atom_id,
                "assertion_id": assertion_key(item.source_node_id, item.source_claim_id),
            }
            for item in incoming.reference_atoms
        ],
    }


def candidate_prompt_payload(item: ActiveGlobalObject) -> dict[str, object]:
    assertion_by_id = {value.assertion_id: value for value in item.assertions}
    return {
        "global_object_id": item.global_object_id,
        "global_object_key": item.global_object_key,
        "canonical_name": item.canonical_name,
        "surface_atoms": [
            {"atom_id": atom.atom_id, "surface_form": atom.surface_form}
            for atom in item.surface_atoms
        ],
        "reference_atoms": [
            {
                "atom_id": atom.atom_id,
                "assertion_id": assertion_key(atom.source_node_id, atom.source_claim_id),
                "statement_template_markdown": _truncate(
                    assertion_by_id[
                        assertion_key(atom.source_node_id, atom.source_claim_id)
                    ].statement_template_markdown,
                    800,
                ),
            }
            for atom in item.reference_atoms
        ],
        "detailed_assertions": [
            _assertion_prompt_payload(value, max_blocks=2, max_block_chars=1_000)
            for value in item.assertions[:8]
        ],
    }


def _assertion_prompt_payload(
    assertion: AssertionEvidence,
    *,
    max_blocks: int | None = None,
    max_block_chars: int = 2_000,
) -> dict[str, object]:
    blocks = assertion.supporting_blocks[:max_blocks] if max_blocks else assertion.supporting_blocks
    return {
        "assertion_id": assertion.assertion_id,
        "source_claim_id": assertion.source_claim_id,
        "statement_template_markdown": assertion.statement_template_markdown,
        "context_dependent": assertion.context_dependent,
        "supporting_blocks": [
            {
                "source_block_id": block.source_block_id,
                "markdown": _truncate(block.markdown, max_block_chars),
            }
            for block in blocks
        ],
    }


def _truncate(value: str, limit: int) -> str:
    return value if len(value) <= limit else value[: limit - 1].rstrip() + "…"


def _short_error(error: Exception) -> str:
    return re.sub(r"\s+", " ", str(error)).strip()[:500] or type(error).__name__


def _retry_instruction(
    *,
    error: Exception,
    previous_content: str | None,
    incoming: SourceRegionDossier,
    registry: RegistryState,
    candidates_by_fragment: Mapping[str, Sequence[ActiveGlobalObject]],
) -> tuple[str, str | None]:
    shape_retry = _operation_shape_retry(
        error=error,
        previous_content=previous_content,
        incoming=incoming,
        registry=registry,
        candidates_by_fragment=candidates_by_fragment,
    )
    if shape_retry is not None:
        note, preserve_identity = shape_retry
        return (
            note,
            (
                "以上一轮 JSON 为基础，只修复 system message 指出的"
                "结构 invariant。保持每个 group 原有的 identity action、target 选择和"
                "incoming atom 分配，不要重新判断 identity。"
                "输出修复后的完整 JSON 正文。"
                if preserve_identity
                else None
            ),
        )
    json_retry = _json_syntax_retry(error=error, previous_content=previous_content)
    if json_retry is not None:
        return json_retry
    return (
        "上一次 JSON 未通过协议校验："
        f"{_short_error(error)}。请仅修复该协议问题并重新提交完整 JSON；"
        "只有错误本身否定了 identity target 时才重新判断 identity。",
        None,
    )


def _json_syntax_retry(
    *,
    error: Exception,
    previous_content: str | None,
) -> tuple[str, str] | None:
    compact_error = re.sub(r"\s+", " ", str(error)).strip()
    if previous_content is None or not (
        "json_invalid" in compact_error or "Invalid JSON:" in compact_error
    ):
        return None
    match = re.search(r"Invalid JSON: (.+?) \[type=json_invalid", compact_error)
    detail = match.group(1) if match else _short_error(error)
    return (
        "上一轮输出无法解析为 JSON："
        f"{detail}。这首先是序列化协议错误，不单独否定其中可读的 identity 选择。"
        "请以上一轮输出为草稿：修复未转义双引号、逗号和括号等 JSON 语法；"
        "字符串内优先使用中文引号“”；并重新检查 operation 结构：只有 split 可以"
        "包含多个 groups，create、attach、merge 必须每个 operation 恰好一个 group。"
        "不要重新判断 identity。",
        "以上一轮原始输出为草稿，保留其中可读的 identity targets 和 atom 分配。"
        "只修复 JSON 序列化与 operation 结构：不得使用未转义的 ASCII 双引号；"
        "只有 split 可以多 group；如有多个 create 或 attach groups，把它们拆成多个"
        "独立 operations。不要重新判断 identity。输出修复后的完整严格 JSON 正文。",
    )


def _operation_shape_retry(
    *,
    error: Exception,
    previous_content: str | None,
    incoming: SourceRegionDossier,
    registry: RegistryState,
    candidates_by_fragment: Mapping[str, Sequence[ActiveGlobalObject]],
) -> tuple[str, bool] | None:
    if previous_content is None or "的 source/group/target 结构不合法" not in str(error):
        return None
    try:
        payload = json.loads(normalize_json_fence(previous_content))
    except (TypeError, ValueError):
        return None
    if not isinstance(payload, dict) or not isinstance(payload.get("operations"), list):
        return None

    violations: list[str] = []
    repairable_structure = True
    changed = False
    repaired_operations: list[object] = []
    for index, raw_operation in enumerate(payload["operations"]):
        if not isinstance(raw_operation, dict):
            repairable_structure = False
            repaired_operations.append(raw_operation)
            continue
        action = raw_operation.get("action")
        sources = raw_operation.get("source_global_object_ids", [])
        source_list = sources if isinstance(sources, list) else []
        groups = raw_operation.get("groups")
        group_list = groups if isinstance(groups, list) else []
        target = (
            group_list[0].get("target") if group_list and isinstance(group_list[0], dict) else None
        )
        target_kind = target.get("kind") if isinstance(target, dict) else None
        target_id = target.get("global_object_id") if isinstance(target, dict) else None
        location = f"operations[{index}]"

        if action in {"create", "attach"}:
            if sources != []:
                violations.append(
                    f"{location} 是 {action}，但 source_global_object_ids 非空；"
                    f"{action} 的 source_global_object_ids 必须为 []"
                )
                raw_operation["source_global_object_ids"] = []
                changed = True
            expected_kind = "new" if action == "create" else "existing"
            target_kinds = [
                group.get("target", {}).get("kind")
                if isinstance(group, dict) and isinstance(group.get("target"), dict)
                else None
                for group in group_list
            ]
            if not group_list:
                violations.append(f"{location} 的 {action} 必须恰好包含一个 group")
                repairable_structure = False
                repaired_operations.append(raw_operation)
            elif any(kind != expected_kind for kind in target_kinds):
                violations.append(f"{location} 的 {action} target.kind 必须为 {expected_kind}")
                repairable_structure = False
                repaired_operations.append(raw_operation)
            elif len(group_list) > 1:
                violations.append(
                    f"{location} 的 {action} 不能把 {len(group_list)} 个 groups 批量放在一个"
                    f" operation；必须拆成 {len(group_list)} 个独立 {action} operations"
                )
                repaired_operations.extend(
                    [{**raw_operation, "groups": [group]} for group in group_list]
                )
                changed = True
            else:
                repaired_operations.append(raw_operation)
        elif action == "merge":
            merge_invalid = False
            if len(source_list) < 2:
                violations.append(f"{location} 的 merge 必须列出至少两个 source_global_object_ids")
                merge_invalid = True
            if len(group_list) != 1 or target_kind != "existing" or target_id not in source_list:
                violations.append(
                    f"{location} 的 merge 必须只有一个 existing group，且 target 必须是 source 之一"
                )
                merge_invalid = True
            if merge_invalid:
                repairable_structure = False
            repaired_operations.append(raw_operation)
        elif action == "split":
            split_invalid = False
            if len(group_list) < 2:
                violations.append(f"{location} 的 split 必须至少包含两个 groups")
                split_invalid = True
            if not isinstance(sources, list) or len(source_list) > 1:
                violations.append(f"{location} 的 split 最多列出一个需要拆分重构的 source Object")
                split_invalid = True
            if split_invalid:
                repairable_structure = False
            repaired_operations.append(raw_operation)
        else:
            repairable_structure = False
            repaired_operations.append(raw_operation)

    if not violations:
        return None
    payload["operations"] = repaired_operations

    preserve_identity = False
    if changed and repairable_structure:
        try:
            repaired = RegionIntegrationPlan.model_validate(payload)
            validate_region_integration_plan(
                repaired,
                incoming=incoming,
                registry=registry,
                candidates_by_fragment=candidates_by_fragment,
            )
            preserve_identity = True
        except ValueError:
            preserve_identity = False

    details = "；".join(violations)
    if preserve_identity:
        return (
            "上一次 JSON 的 identity action、target 选择和 incoming atom 分配已通过"
            "完整现有校验，identity 判断本身无需改变。它只违反了以下结构 invariant："
            f"{details}。请以上一轮 JSON 为基础，只做列出的结构修复："
            "create/attach 的 source_global_object_ids 必须为 []，多个 create/attach groups 必须"
            "拆成多个独立 operations；attach 的已有 target 只保留在 group.target，"
            "不要重新输出 target 已拥有的旧 atoms，不要重新判断 identity。",
            True,
        )
    return (
        f"上一次 JSON 违反了以下结构 invariant：{details}。"
        "请仅修复列出的协议结构问题并输出完整 JSON；"
        "对未被错误否定的 identity target 不要重新判断。",
        False,
    )


def _new_global_object_id(
    *,
    state: RegistryState,
    source_object_ids: set[str],
    surface_atom_ids: list[str],
) -> str:
    """Keep new UUIDs stable when the same source atoms receive the same plan again."""
    if not surface_atom_ids:
        raise ValueError("new Global Object 必须拥有 surface atom")
    seed = "\n".join(
        [
            "global-resolution.v3",
            state.source_sha256,
            ",".join(sorted(source_object_ids)),
            ",".join(sorted(surface_atom_ids)),
        ]
    )
    return str(uuid5(NAMESPACE_URL, seed))


__all__ = [
    "GlobalObjectResolverRunner",
    "apply_region_plan",
    "candidate_prompt_payload",
    "fragment_prompt_payload",
    "region_prompt_payload",
]
