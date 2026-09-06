"""逐个 SourceRegion 更新本地 Global Registry。"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Mapping, Sequence
from uuid import NAMESPACE_URL, uuid5

from cold_start.global_resolution.artifacts import (
    GlobalResolutionPaths,
    SourceCompilationDataset,
    write_final_artifact,
    write_working_registry,
)
from cold_start.global_resolution.finalization import (
    build_global_assertions_artifact,
    resolve_ambiguous_literal_senses,
    write_global_assertions_artifact,
)
from cold_start.global_resolution.models import (
    ActiveGlobalObject,
    AssertionEvidence,
    FragmentDisposition,
    FragmentIdentityDecision,
    ObjectAdmissionDecision,
    ObjectAdmissionRecord,
    RegionIntegrationPlan,
    RegionResolutionOperation,
    RegistryState,
    ResolutionGroup,
    ResolutionTarget,
    SourceFragmentDossier,
    SourceRegionDossier,
    SurfaceAtom,
    ValidatedRegionPlan,
    assertion_key,
    source_fragment_key,
    validate_region_integration_plan,
)
from cold_start.global_resolution.prompts import (
    GLOBAL_IDENTITY_SYSTEM_PROMPT,
    OBJECT_ADMISSION_SYSTEM_PROMPT,
    fragment_identity_alignment_prompt,
    fragment_identity_system_prompt,
    object_admission_prompt,
    region_identity_alignment_prompt,
)
from cold_start.global_resolution.retrieval import GlobalObjectCandidateRetriever
from cold_start.llm.base import ChatModel, commit_model_turn, reject_model_turn
from cold_start.llm.openai_compatible import ModelRepetitionError
from cold_start.llm.structured_output import (
    ModelJsonSyntaxError,
    ModelOutputError,
    normalize_json_document,
)
from cold_start.progress import NullProgressReporter, ProgressReporter

_MAX_USAGE_TOOL_CALLS_PER_REGION = 4
_DEFAULT_MAX_PARALLEL_FRAGMENT_DECISIONS = 18
_DEFAULT_MAX_PARALLEL_ADMISSION_REVIEWS = 18


def _fragment_usage_tool(incoming: SourceRegionDossier) -> tuple[dict[str, object], ...]:
    return (
        {
            "type": "function",
            "function": {
                "name": "inspect_source_fragment_usage",
                "description": (
                    "仅当当前 Region 不足以判断一个 Fragment 的 Objecthood、词义或 identity 时，"
                    "查看其 surface forms 在当前整份来源其他 Region 中的精确字面分布与代表语境。"
                    "频次不是保留、拒绝或合并阈值。"
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "fragment_key": {
                            "type": "string",
                            "enum": [item.fragment_key for item in incoming.fragments],
                        }
                    },
                    "required": ["fragment_key"],
                    "additionalProperties": False,
                },
            },
        },
    )


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
        max_parallel_fragments: int = _DEFAULT_MAX_PARALLEL_FRAGMENT_DECISIONS,
        enable_admission_review: bool = True,
        max_parallel_admissions: int = _DEFAULT_MAX_PARALLEL_ADMISSION_REVIEWS,
    ) -> None:
        if state.source_sha256 != dataset.source_sha256:
            raise ValueError("Global Registry 不属于当前 Source Semantic")
        if state.source_node_ids != list(dataset.source_node_ids):
            raise ValueError("Global Registry 与 SourceRegion 顺序不一致")
        if max_parallel_fragments < 1:
            raise ValueError("max_parallel_fragments 必须大于 0")
        if max_parallel_admissions < 1:
            raise ValueError("max_parallel_admissions 必须大于 0")
        self.model = model
        self.dataset = dataset
        self.paths = paths
        self.state = state
        self.retriever = retriever
        self.progress = progress or NullProgressReporter()
        self.max_parallel_fragments = max_parallel_fragments
        self.enable_admission_review = enable_admission_review
        self.max_parallel_admissions = max_parallel_admissions

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
                self.state = await self._write_completed_artifacts(self.state)
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
            actions = "/".join(
                [*(item.action for item in validated.operations)]
                + (["reject"] if validated.rejected_fragment_keys else [])
                + (["defer"] if validated.deferred_fragment_keys else [])
            )
            self.progress.report(
                label,
                f"完成 {actions}；Global Objects {len(state.objects)}",
            )

        self.state = state
        if final and state.next_source_region_ordinal == len(self.dataset.regions):
            if state.next_source_region_ordinal != len(state.source_node_ids):
                raise ValueError("完整 Global Resolution 仍有未就绪的 SourceRegion")
            state = await self._write_completed_artifacts(state)
            self.state = state
        return state

    async def _write_completed_artifacts(self, state: RegistryState) -> RegistryState:
        if self.enable_admission_review:
            state = await self._review_low_evidence_objects(state)
        literal_sense_routes = await resolve_ambiguous_literal_senses(
            model=self.model,
            dataset=self.dataset,
            state=state,
            directory=self.paths.directory,
            progress=self.progress,
        )
        global_assertions = build_global_assertions_artifact(
            self.dataset,
            state,
            literal_sense_routes=literal_sense_routes,
        )
        write_final_artifact(self.paths, self.dataset, state)
        output = write_global_assertions_artifact(self.paths.directory, global_assertions)
        self.progress.report(
            "全局命题",
            f"{global_assertions.total_assertions} 条 Assertion；"
            f"新增 {global_assertions.total_literal_reference_atoms} 个字符串 reference atom；"
            f"{output}",
        )
        return state

    async def _review_low_evidence_objects(self, state: RegistryState) -> RegistryState:
        reviewed_ids = {item.global_object_id for item in state.admission_records}
        pending = [
            item
            for item in state.objects
            if item.global_object_id not in reviewed_ids
            and _needs_admission_review(item, self.dataset)
        ]
        if not pending:
            self.progress.report("对象准入", "没有新的低证据 Object 需要复审")
            return state

        self.progress.report(
            "对象准入",
            f"发布前复审 {len(pending)} 个低证据 provisional Object",
        )
        semaphore = asyncio.Semaphore(self.max_parallel_admissions)

        async def review_one(
            item: ActiveGlobalObject,
        ) -> tuple[ActiveGlobalObject, ObjectAdmissionDecision]:
            async with semaphore:
                label = f"对象准入·{item.global_object_key}"
                self.progress.report(label, f"复审：{item.canonical_name}")
                decision = await self._decide_object_admission(item, request_label=label)
                self.progress.report(label, f"完成：{decision.action}")
                return item, decision

        tasks = [asyncio.create_task(review_one(item)) for item in pending]
        current = state
        try:
            for completed in asyncio.as_completed(tasks):
                item, decision = await completed
                current = _apply_admission_decision(
                    current,
                    item,
                    decision,
                )
                write_working_registry(self.paths, self.dataset, current)
        except BaseException:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise
        admitted = sum(
            item.action == "admit" for item in current.admission_records
            if item.global_object_id in {value.global_object_id for value in pending}
        )
        self.progress.report(
            "对象准入",
            f"复审完成：准入 {admitted}，降级/暂缓 {len(pending) - admitted}",
        )
        return current

    async def _decide_object_admission(
        self,
        item: ActiveGlobalObject,
        *,
        request_label: str,
    ) -> ObjectAdmissionDecision:
        payload = _object_admission_payload(item, self.dataset)
        last_error: Exception | None = None
        last_content: str | None = None
        for attempt in range(1, 3):
            retry_note = ""
            if last_error is not None:
                retry_note = (
                    "\n\n上一轮输出未通过准入协议校验："
                    + _short_error(last_error)
                    + "。保留 Objecthood 判断，只修复 JSON。"
                )
            messages: list[Mapping[str, object]] = [
                {
                    "role": "system",
                    "content": OBJECT_ADMISSION_SYSTEM_PROMPT + retry_note,
                },
                {
                    "role": "user",
                    "content": object_admission_prompt(
                        provisional_object=payload,
                        decision_schema=ObjectAdmissionDecision.model_json_schema(),
                    ),
                },
            ]
            if last_content is not None:
                messages.extend(
                    [
                        {"role": "assistant", "content": last_content},
                        {"role": "user", "content": "只输出修复后的完整 JSON 正文。"},
                    ]
                )
            try:
                turn = await self.model.complete_turn(
                    messages=messages,
                    request_label=(
                        request_label
                        if attempt == 1
                        else f"{request_label}·clean-retry"
                    ),
                    thinking="enabled",
                )
                try:
                    if turn.tool_calls or not turn.content:
                        raise ValueError("模型没有返回 Object admission JSON 正文")
                    last_content = turn.content
                    decision = ObjectAdmissionDecision.model_validate_json(
                        normalize_json_document(turn.content)
                    )
                    if decision.global_object_id != item.global_object_id:
                        raise ValueError("Object admission 返回了错误的 global_object_id")
                except Exception:
                    reject_model_turn(self.model, turn)
                    raise
                commit_model_turn(self.model, turn)
                return decision
            except (ModelRepetitionError, ValueError) as error:
                last_error = error
        assert last_error is not None
        raise ModelOutputError(
            "Object admission 连续失败：" + _short_error(last_error)
        ) from last_error

    async def _decide(
        self,
        *,
        incoming: SourceRegionDossier,
        candidates_by_fragment: Mapping[str, Sequence[ActiveGlobalObject]],
        registry: RegistryState,
        request_label: str,
    ) -> RegionIntegrationPlan:
        """先并行裁决独立 Fragment，只把身份耦合项交给 Region 联合计划。"""

        semaphore = asyncio.Semaphore(self.max_parallel_fragments)

        async def decide_one(fragment: SourceFragmentDossier) -> FragmentIdentityDecision:
            async with semaphore:
                label = f"{request_label}·{fragment.source_fragment_id}"
                self.progress.report(label, "开始独立身份裁决")
                decision = await self._decide_fragment(
                    incoming=incoming,
                    fragment=fragment,
                    candidates=candidates_by_fragment[fragment.fragment_key],
                    request_label=label,
                )
                self.progress.report(label, f"完成：{decision.action}")
                return decision

        tasks = [asyncio.create_task(decide_one(item)) for item in incoming.fragments]
        try:
            decisions = await asyncio.gather(*tasks)
        except BaseException:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise
        joint_keys = _joint_fragment_keys(decisions, incoming)
        simple_plan = _plan_from_fragment_decisions(
            decisions=decisions,
            incoming=incoming,
            excluded_fragment_keys=joint_keys,
        )
        joint_plan: RegionIntegrationPlan | None = None
        if joint_keys:
            joint_incoming = _subregion(incoming, joint_keys)
            self.progress.report(
                request_label,
                f"{len(joint_keys)} 个 Fragment 需要联合裁决",
            )
            joint_plan = await self._decide_region(
                incoming=joint_incoming,
                candidates_by_fragment={key: candidates_by_fragment[key] for key in joint_keys},
                registry=registry,
                request_label=f"{request_label}·joint",
            )

        combined = RegionIntegrationPlan(
            operations=[
                *simple_plan.operations,
                *(joint_plan.operations if joint_plan is not None else []),
            ],
            dispositions=[
                *simple_plan.dispositions,
                *(joint_plan.dispositions if joint_plan is not None else []),
            ],
        )
        try:
            validate_region_integration_plan(
                combined,
                incoming=incoming,
                registry=registry,
                candidates_by_fragment=candidates_by_fragment,
            )
        except ValueError as error:
            self.progress.report(
                request_label,
                "独立裁决产生跨组冲突，回退完整 Region 联合裁决：" + _short_error(error),
            )
            return await self._decide_region(
                incoming=incoming,
                candidates_by_fragment=candidates_by_fragment,
                registry=registry,
                request_label=f"{request_label}·full-fallback",
            )
        return combined

    async def _decide_fragment(
        self,
        *,
        incoming: SourceRegionDossier,
        fragment: SourceFragmentDossier,
        candidates: Sequence[ActiveGlobalObject],
        request_label: str,
    ) -> FragmentIdentityDecision:
        fragment_payload = fragment_decision_prompt_payload(incoming, fragment)
        peers_payload = peer_fragments_prompt_payload(incoming, fragment.fragment_key)
        candidates_payload = [
            candidate_summary_prompt_payload(
                item,
                include_representative_assertions=index < 2,
            )
            for index, item in enumerate(candidates)
        ]
        fragment_region = _subregion(incoming, {fragment.fragment_key})
        last_error: Exception | None = None
        last_content: str | None = None
        for attempt in range(1, 3):
            retry_note = ""
            if last_error is not None:
                retry_note = (
                    "\n\n上一轮输出未通过 Fragment 协议校验："
                    + _short_error(last_error)
                    + "。只修复 JSON 或 action 字段，不要无故改变身份判断。"
                )
                self.progress.report(request_label, "Fragment 协议失败，进行一次 clean retry")
            messages: list[Mapping[str, object]] = [
                {
                    "role": "system",
                    "content": fragment_identity_system_prompt(
                        fragment.identity_mode_hint
                    )
                    + retry_note,
                },
                {
                    "role": "user",
                    "content": fragment_identity_alignment_prompt(
                        fragment=fragment_payload,
                        peer_fragments=peers_payload,
                        candidates=candidates_payload,
                        decision_schema=FragmentIdentityDecision.model_json_schema(),
                    ),
                },
            ]
            if last_content is not None:
                messages.extend(
                    [
                        {"role": "assistant", "content": last_content},
                        {
                            "role": "user",
                            "content": "保留可读的身份选择，只输出修复后的完整 JSON 正文。",
                        },
                    ]
                )
            tool_round_available = True
            try:
                while True:
                    turn = await self.model.complete_turn(
                        messages=messages,
                        tools=(
                            _fragment_usage_tool(fragment_region)
                            if tool_round_available
                            else ()
                        ),
                        tool_choice="auto" if tool_round_available else None,
                        request_label=(
                            request_label
                            if attempt == 1
                            else f"{request_label}·clean-retry"
                        ),
                        thinking="enabled",
                    )
                    if not turn.tool_calls:
                        break
                    messages.append(turn.as_assistant_message())
                    for ordinal, call in enumerate(turn.tool_calls):
                        if ordinal >= 1:
                            result = "当前 Fragment 的来源证据已查询，请直接提交 JSON。"
                        elif call.name != "inspect_source_fragment_usage":
                            result = f"未知工具：{call.name}"
                        else:
                            try:
                                arguments = json.loads(call.arguments)
                                if arguments.get("fragment_key") != fragment.fragment_key:
                                    raise ValueError("fragment_key 必须是当前 Fragment")
                                evidence = source_fragment_usage_payload(
                                    self.dataset,
                                    fragment,
                                    current_source_node_id=incoming.source_node_id,
                                )
                                result = json.dumps(evidence, ensure_ascii=False)
                            except Exception as error:
                                result = f"工具调用失败：{_short_error(error)}"
                        messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": call.id,
                                "content": result,
                            }
                        )
                    commit_model_turn(self.model, turn)
                    tool_round_available = False
                try:
                    if turn.tool_calls or not turn.content:
                        raise ValueError("模型没有返回 Fragment JSON 正文")
                    last_content = turn.content
                    decision = FragmentIdentityDecision.model_validate_json(
                        normalize_json_document(turn.content)
                    )
                    _validate_fragment_decision(
                        decision,
                        fragment=fragment,
                        region=incoming,
                        candidates=candidates,
                    )
                except Exception:
                    reject_model_turn(self.model, turn)
                    raise
                commit_model_turn(self.model, turn)
                return decision
            except (ModelRepetitionError, ValueError) as error:
                last_error = error
        assert last_error is not None
        raise ModelOutputError(
            "Fragment 身份裁决连续失败：" + _short_error(last_error)
        ) from last_error

    async def _decide_region(
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
        incoming_payload = region_prompt_payload(incoming)
        candidate_ids_payload = {
            fragment_key: [item.global_object_id for item in candidates]
            for fragment_key, candidates in candidates_by_fragment.items()
        }
        candidates_payload = [
            candidate_prompt_payload(item)
            for item in sorted(
                candidate_by_id.values(),
                key=lambda value: value.global_object_key,
            )
        ]
        fragment_by_key = {item.fragment_key: item for item in incoming.fragments}
        inspected_usage: dict[str, dict[str, object]] = {}
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
                user_prompt = region_identity_alignment_prompt(
                    incoming=incoming_payload,
                    candidate_ids_by_fragment=candidate_ids_payload,
                    candidates=candidates_payload,
                    decision_schema=RegionIntegrationPlan.model_json_schema(),
                    source_usage_by_fragment=inspected_usage,
                )
                messages: list[Mapping[str, object]] = [
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
                tool_round_available = True
                while True:
                    turn = await self.model.complete_turn(
                        messages=messages,
                        tools=(
                            _fragment_usage_tool(incoming)
                            if tool_round_available
                            else ()
                        ),
                        tool_choice="auto" if tool_round_available else None,
                        request_label=(
                            request_label if attempt == 1 else f"{request_label}·clean-retry"
                        ),
                        thinking="enabled",
                    )
                    if not turn.tool_calls:
                        break
                    messages.append(turn.as_assistant_message())
                    for ordinal, call in enumerate(turn.tool_calls):
                        if ordinal >= _MAX_USAGE_TOOL_CALLS_PER_REGION:
                            result = "本轮来源证据查询数量已达上限，请使用已有证据直接提交 JSON。"
                        elif call.name != "inspect_source_fragment_usage":
                            result = f"未知工具：{call.name}"
                        else:
                            try:
                                arguments = json.loads(call.arguments)
                                fragment_key = (
                                    arguments.get("fragment_key")
                                    if isinstance(arguments, dict)
                                    else None
                                )
                                fragment = (
                                    fragment_by_key.get(fragment_key)
                                    if isinstance(fragment_key, str)
                                    else None
                                )
                                if fragment is None:
                                    raise ValueError("fragment_key 必须来自当前 Region")
                                evidence = source_fragment_usage_payload(
                                    self.dataset,
                                    fragment,
                                    current_source_node_id=incoming.source_node_id,
                                )
                                inspected_usage[fragment.fragment_key] = evidence
                                result = json.dumps(evidence, ensure_ascii=False)
                            except Exception as error:
                                result = f"工具调用失败：{_short_error(error)}"
                        messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": call.id,
                                "content": result,
                            }
                        )
                    commit_model_turn(self.model, turn)
                    tool_round_available = False
                try:
                    if turn.tool_calls or not turn.content:
                        raise ValueError("模型没有返回 JSON 正文")
                    last_content = turn.content
                    plan = RegionIntegrationPlan.model_validate_json(
                        normalize_json_document(turn.content)
                    )
                    validate_region_integration_plan(
                        plan,
                        incoming=incoming,
                        registry=registry,
                        candidates_by_fragment=candidates_by_fragment,
                    )
                except Exception:
                    reject_model_turn(self.model, turn)
                    raise
                commit_model_turn(self.model, turn)
                return plan
            except (ModelRepetitionError, ValueError) as error:
                last_error = error
        assert last_error is not None
        raise ModelOutputError(
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
    fragment_by_key = {
        fragment.fragment_key: fragment
        for region in dataset.regions
        for fragment in region.fragments
    }

    def assertions_for_surfaces(surface_atoms: Sequence[SurfaceAtom]) -> list[str]:
        result = []
        for atom in surface_atoms:
            fragment = fragment_by_key.get(
                source_fragment_key(atom.source_node_id, atom.source_fragment_id)
            )
            if fragment is not None:
                result.extend(assertion.assertion_id for assertion in fragment.assertions)
        return result
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
            surfaces = [*target.surface_atoms, *group.surface_atoms]
            references = [*target.reference_atoms, *group.reference_atoms]
            assertion_ids = list(
                dict.fromkeys(
                    [
                        assertion_key(atom.source_node_id, atom.source_claim_id)
                        for atom in references
                    ]
                    + assertions_for_surfaces(surfaces)
                )
            )
            objects[target_id] = target.model_copy(
                update={
                    "surface_atoms": surfaces,
                    "reference_atoms": references,
                    "assertions": [dataset.assertions[item] for item in assertion_ids],
                }
            )
    return RegistryState(
        source_sha256=state.source_sha256,
        source_node_ids=state.source_node_ids,
        next_source_region_ordinal=state.next_source_region_ordinal + 1,
        objects=sorted(objects.values(), key=lambda item: item.global_object_key),
        rejected_fragment_keys=[
            *state.rejected_fragment_keys,
            *plan.rejected_fragment_keys,
        ],
        deferred_fragment_keys=[
            *state.deferred_fragment_keys,
            *plan.deferred_fragment_keys,
        ],
        admission_records=state.admission_records,
    )


def _object_fragment_keys(item: ActiveGlobalObject) -> list[str]:
    return sorted(
        {
            source_fragment_key(atom.source_node_id, atom.source_fragment_id)
            for atom in item.surface_atoms
        }
    )


def _fragment_hints_by_key(
    dataset: SourceCompilationDataset,
) -> dict[str, str]:
    return {
        fragment.fragment_key: fragment.identity_mode_hint
        for region in dataset.regions
        for fragment in region.fragments
    }


def _admission_review_triggers(
    item: ActiveGlobalObject,
    dataset: SourceCompilationDataset,
) -> list[str]:
    fragment_keys = _object_fragment_keys(item)
    hints = _fragment_hints_by_key(dataset)
    source_region_count = len({atom.source_node_id for atom in item.surface_atoms})
    assertion_count = len({assertion.assertion_id for assertion in item.assertions})
    triggers = []
    if source_region_count <= 1:
        triggers.append("single_source_region")
    if assertion_count <= 1:
        triggers.append("at_most_one_assertion")
    if any(hints.get(key) == "undetermined" for key in fragment_keys):
        triggers.append("undetermined_identity_mode")
    return triggers


def _needs_admission_review(
    item: ActiveGlobalObject,
    dataset: SourceCompilationDataset,
) -> bool:
    return bool(_admission_review_triggers(item, dataset))


def _object_admission_payload(
    item: ActiveGlobalObject,
    dataset: SourceCompilationDataset,
) -> dict[str, object]:
    fragment_keys = _object_fragment_keys(item)
    hints = _fragment_hints_by_key(dataset)
    source_region_ids = sorted({atom.source_node_id for atom in item.surface_atoms})
    assertions = sorted(item.assertions, key=lambda value: value.assertion_id)
    return {
        "global_object_id": item.global_object_id,
        "canonical_name": item.canonical_name,
        "surface_forms": list(dict.fromkeys(atom.surface_form for atom in item.surface_atoms)),
        "fragment_keys": fragment_keys,
        "identity_mode_hints": sorted({hints[key] for key in fragment_keys}),
        "review_triggers": _admission_review_triggers(item, dataset),
        "evidence_summary": {
            "source_region_count": len(source_region_ids),
            "assertion_count": len(assertions),
            "reference_count": len(item.reference_atoms),
        },
        "source_region_ids": source_region_ids,
        "assertions": [
            {
                "assertion_id": assertion.assertion_id,
                "statement_template_markdown": assertion.statement_template_markdown,
                "supporting_blocks": [
                    {
                        "source_block_id": block.source_block_id,
                        "markdown": block.markdown,
                    }
                    for block in assertion.supporting_blocks
                ],
            }
            for assertion in assertions
        ],
    }


def _apply_admission_decision(
    state: RegistryState,
    item: ActiveGlobalObject,
    decision: ObjectAdmissionDecision,
) -> RegistryState:
    if decision.global_object_id != item.global_object_id:
        raise ValueError("Object admission decision 不属于当前 provisional Object")
    if item.global_object_id not in state.object_by_id():
        raise ValueError("Object admission decision 引用了不存在的 provisional Object")
    fragment_keys = _object_fragment_keys(item)
    source_region_count = len({atom.source_node_id for atom in item.surface_atoms})
    record = ObjectAdmissionRecord(
        global_object_id=item.global_object_id,
        canonical_name=item.canonical_name,
        fragment_keys=fragment_keys,
        source_region_count=source_region_count,
        assertion_count=len({value.assertion_id for value in item.assertions}),
        action=decision.action,
        reason=decision.reason,
    )
    objects = state.objects
    rejected = state.rejected_fragment_keys
    deferred = state.deferred_fragment_keys
    if decision.action != "admit":
        objects = [
            value for value in state.objects
            if value.global_object_id != item.global_object_id
        ]
        if decision.action == "demote":
            rejected = [*rejected, *fragment_keys]
        else:
            deferred = [*deferred, *fragment_keys]
    return RegistryState(
        source_sha256=state.source_sha256,
        source_node_ids=state.source_node_ids,
        next_source_region_ordinal=state.next_source_region_ordinal,
        objects=objects,
        rejected_fragment_keys=list(dict.fromkeys(rejected)),
        deferred_fragment_keys=list(dict.fromkeys(deferred)),
        admission_records=[*state.admission_records, record],
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
        "identity_mode_hint": incoming.identity_mode_hint,
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


def fragment_decision_prompt_payload(
    region: SourceRegionDossier,
    fragment: SourceFragmentDossier,
) -> dict[str, object]:
    """模型裁决视图不携带事务 Atom 清单，只提供当前 Fragment 的局部证据。"""

    surface_forms = list(dict.fromkeys(item.surface_form for item in fragment.surface_atoms))
    return {
        "fragment_key": fragment.fragment_key,
        "source_fragment_id": fragment.source_fragment_id,
        "identity_mode_hint": fragment.identity_mode_hint,
        "surface_forms": surface_forms,
        "reference_count": len(fragment.reference_atoms),
        "region": {
            "source_node_id": region.source_node_id,
            "region_label": region.region_label,
            "lineage_node_ids": region.lineage_node_ids,
        },
        "related_assertions": [
            _assertion_prompt_payload(item, max_blocks=1, max_block_chars=500)
            for item in fragment.assertions
        ],
        "source_context_excerpt": _matching_excerpt(
            region.context_markdown,
            surface_forms,
            limit=1_200,
        ),
    }


def peer_fragments_prompt_payload(
    region: SourceRegionDossier,
    current_fragment_key: str,
) -> list[dict[str, object]]:
    """只暴露与当前 Fragment 共享 Assertion 的 peers，避免重复整区名称清单。"""

    current = next(item for item in region.fragments if item.fragment_key == current_fragment_key)
    related_templates = "\n".join(
        item.statement_template_markdown for item in current.assertions
    )
    return [
        {
            "fragment_key": item.fragment_key,
            "source_fragment_id": item.source_fragment_id,
            "identity_mode_hint": item.identity_mode_hint,
            "surface_forms": list(
                dict.fromkeys(atom.surface_form for atom in item.surface_atoms)
            ),
        }
        for item in region.fragments
        if item.fragment_key != current_fragment_key
        and f"{{{{fragment:{item.source_fragment_id}}}}}" in related_templates
    ]


def candidate_summary_prompt_payload(
    item: ActiveGlobalObject,
    *,
    include_representative_assertions: bool = True,
) -> dict[str, object]:
    """候选的判定摘要；完整 Atom 历史只在 joint merge/split 回退中发送。"""

    assertions: list[AssertionEvidence] = []
    if include_representative_assertions:
        assertions.extend(item.assertions[:1])
        for assertion in item.assertions[-1:]:
            if assertion.assertion_id not in {value.assertion_id for value in assertions}:
                assertions.append(assertion)
    source_regions = {
        atom.source_node_id for atom in [*item.surface_atoms, *item.reference_atoms]
    }
    return {
        "global_object_id": item.global_object_id,
        "canonical_name": item.canonical_name,
        "aliases": list(dict.fromkeys(atom.surface_form for atom in item.surface_atoms))[:8],
        "evidence_summary": {
            "source_region_count": len(source_regions),
            "surface_atom_count": len(item.surface_atoms),
            "reference_atom_count": len(item.reference_atoms),
        },
        "representative_assertions": [
            {
                "assertion_id": assertion.assertion_id,
                "statement_template_markdown": _truncate(
                    assertion.statement_template_markdown,
                    240,
                ),
            }
            for assertion in assertions
        ],
        "evidence_is_summary": True,
    }


def _validate_fragment_decision(
    decision: FragmentIdentityDecision,
    *,
    fragment: SourceFragmentDossier,
    region: SourceRegionDossier,
    candidates: Sequence[ActiveGlobalObject],
) -> None:
    if decision.fragment_key != fragment.fragment_key:
        raise ValueError("Fragment decision 的 fragment_key 与当前 Fragment 不一致")
    candidate_ids = {item.global_object_id for item in candidates}
    if (
        decision.action == "attach"
        and decision.target_global_object_id not in candidate_ids
    ):
        raise ValueError("Fragment attach 引用了未召回的 Global Object")
    surface_forms = {item.surface_form for item in fragment.surface_atoms}
    if decision.action == "create" and decision.canonical_name not in surface_forms:
        raise ValueError("Fragment create 的 canonical_name 必须来自当前 surface forms")
    peer_keys = {
        item.fragment_key
        for item in region.fragments
        if item.fragment_key != fragment.fragment_key
    }
    if set(decision.joint_fragment_keys) - peer_keys:
        raise ValueError("Fragment joint 引用了当前 Region 之外的 peer Fragment")


def _joint_fragment_keys(
    decisions: Sequence[FragmentIdentityDecision],
    incoming: SourceRegionDossier,
) -> set[str]:
    """汇集模型声明的耦合项，并捕获相同词面却给出不同身份的冲突。"""

    joint = {
        key
        for decision in decisions
        if decision.action == "joint"
        for key in [decision.fragment_key, *decision.joint_fragment_keys]
    }
    fragments = {item.fragment_key: item for item in incoming.fragments}
    active = [item for item in decisions if item.action in {"create", "attach"}]
    for index, left in enumerate(active):
        left_surfaces = {
            atom.surface_form.strip().casefold()
            for atom in fragments[left.fragment_key].surface_atoms
        }
        left_target = (
            "existing",
            left.target_global_object_id,
        ) if left.action == "attach" else ("new", left.canonical_name)
        for right in active[index + 1 :]:
            right_surfaces = {
                atom.surface_form.strip().casefold()
                for atom in fragments[right.fragment_key].surface_atoms
            }
            right_target = (
                "existing",
                right.target_global_object_id,
            ) if right.action == "attach" else ("new", right.canonical_name)
            same_new_name = (
                left.action == right.action == "create"
                and left.canonical_name is not None
                and right.canonical_name is not None
                and left.canonical_name.strip().casefold()
                == right.canonical_name.strip().casefold()
            )
            if (left_surfaces & right_surfaces or same_new_name) and left_target != right_target:
                joint.update((left.fragment_key, right.fragment_key))
    return joint


def _plan_from_fragment_decisions(
    *,
    decisions: Sequence[FragmentIdentityDecision],
    incoming: SourceRegionDossier,
    excluded_fragment_keys: set[str],
) -> RegionIntegrationPlan:
    """把普通 Fragment 决策确定性展开成现有 Region 原子事务协议。"""

    fragment_by_key = {item.fragment_key: item for item in incoming.fragments}
    operations: list[RegionResolutionOperation] = []
    dispositions: list[FragmentDisposition] = []
    attach_groups: dict[str, list[SourceFragmentDossier]] = {}
    for decision in decisions:
        if decision.fragment_key in excluded_fragment_keys:
            continue
        fragment = fragment_by_key[decision.fragment_key]
        if decision.action == "attach":
            assert decision.target_global_object_id is not None
            attach_groups.setdefault(decision.target_global_object_id, []).append(fragment)
        elif decision.action == "create":
            assert decision.canonical_name is not None
            operations.append(
                RegionResolutionOperation(
                    action="create",
                    groups=[
                        ResolutionGroup(
                            target=ResolutionTarget(
                                kind="new",
                                canonical_name=decision.canonical_name,
                            ),
                            surface_atom_ids=[item.atom_id for item in fragment.surface_atoms],
                            reference_atom_ids=[
                                item.atom_id for item in fragment.reference_atoms
                            ],
                        )
                    ],
                )
            )
        elif decision.action in {"reject", "defer"}:
            dispositions.append(
                FragmentDisposition(
                    action=decision.action,
                    fragment_keys=[decision.fragment_key],
                    reason=decision.reason,
                )
            )
        else:
            raise ValueError("joint Fragment 未从普通计划中排除")
    for target_id, fragments in attach_groups.items():
        operations.append(
            RegionResolutionOperation(
                action="attach",
                groups=[
                    ResolutionGroup(
                        target=ResolutionTarget(
                            kind="existing",
                            global_object_id=target_id,
                        ),
                        surface_atom_ids=[
                            atom.atom_id
                            for fragment in fragments
                            for atom in fragment.surface_atoms
                        ],
                        reference_atom_ids=[
                            atom.atom_id
                            for fragment in fragments
                            for atom in fragment.reference_atoms
                        ],
                    )
                ],
            )
        )
    return RegionIntegrationPlan.model_construct(
        operations=operations,
        dispositions=dispositions,
    )


def _subregion(
    incoming: SourceRegionDossier,
    fragment_keys: set[str],
) -> SourceRegionDossier:
    fragments = [item for item in incoming.fragments if item.fragment_key in fragment_keys]
    if not fragments:
        raise ValueError("联合裁决至少需要一个 Fragment")
    assertion_ids = {
        assertion.assertion_id for fragment in fragments for assertion in fragment.assertions
    }
    return incoming.model_copy(
        update={
            "fragments": fragments,
            "assertions": [
                item for item in incoming.assertions if item.assertion_id in assertion_ids
            ],
        }
    )


def source_fragment_usage_payload(
    dataset: SourceCompilationDataset,
    fragment: SourceFragmentDossier,
    *,
    current_source_node_id: str,
    max_contexts: int = 6,
) -> dict[str, object]:
    """按需返回当前完整来源中的精确字面分布，不把频次解释成语义结论。"""

    surface_forms = list(dict.fromkeys(atom.surface_form for atom in fragment.surface_atoms))
    exact_occurrences = []
    for surface_form in surface_forms:
        matching_regions = [
            region
            for region in dataset.regions
            if surface_form in region.context_markdown
        ]
        exact_occurrences.append(
            {
                "surface_form": surface_form,
                "occurrence_count": sum(
                    region.context_markdown.count(surface_form) for region in matching_regions
                ),
                "region_count": len(matching_regions),
            }
        )

    matching_contexts = []
    ordered_regions = sorted(
        dataset.regions,
        key=lambda region: region.source_node_id == current_source_node_id,
    )
    for region in ordered_regions:
        matched = [item for item in surface_forms if item in region.context_markdown]
        if not matched:
            continue
        matching_contexts.append(
            {
                "source_node_id": region.source_node_id,
                "region_label": region.region_label,
                "is_current_region": region.source_node_id == current_source_node_id,
                "matched_surface_forms": matched,
                "context_excerpt": _matching_excerpt(region.context_markdown, matched),
            }
        )
        if len(matching_contexts) >= max_contexts:
            break

    return {
        "scope": "current_source_all_regions",
        "coverage": "complete",
        "fragment_key": fragment.fragment_key,
        "exact_occurrences": exact_occurrences,
        "representative_contexts": matching_contexts,
        "interpretation_boundary": (
            "精确字面频次与语境只用于辅助判断；低频不等于拒绝，高频不等于保留或同一身份。"
        ),
    }


def _matching_excerpt(value: str, surface_forms: Sequence[str], limit: int = 800) -> str:
    positions = [value.find(item) for item in surface_forms if value.find(item) >= 0]
    if not positions:
        return _truncate(value, limit)
    center = min(positions)
    start = max(0, center - limit // 3)
    end = min(len(value), start + limit)
    if end - start < limit:
        start = max(0, end - limit)
    prefix = "…" if start else ""
    suffix = "…" if end < len(value) else ""
    return prefix + value[start:end].strip() + suffix


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
        isinstance(error, ModelJsonSyntaxError)
        or "json_invalid" in compact_error
        or "Invalid JSON:" in compact_error
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
        payload = json.loads(normalize_json_document(previous_content))
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
            "global-resolution.v6",
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
    "candidate_summary_prompt_payload",
    "fragment_decision_prompt_payload",
    "fragment_prompt_payload",
    "peer_fragments_prompt_payload",
    "region_prompt_payload",
]
