"""把 Source Assertion 物化为只引用当前 Global Object 的最终模板。"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from cold_start.global_resolution.artifacts import (
    SourceCompilationDataset,
    load_source_compilation,
    rebuild_registry,
)
from cold_start.global_resolution.models import (
    GLOBAL_RESOLUTION_POLICY_VERSION,
    ActiveGlobalObject,
    GlobalAssertionReferenceAtom,
    GlobalAssertionsArtifact,
    GlobalizedAssertion,
    GlobalResolutionArtifact,
    RegistryState,
    literal_reference_atom_id,
    reference_atom_id,
    source_fragment_key,
)
from cold_start.llm.base import ChatModel, commit_model_turn, reject_model_turn
from cold_start.llm.structured_output import ModelOutputError, normalize_json_document
from cold_start.progress import NullProgressReporter, ProgressReporter

GLOBAL_ASSERTIONS_FILENAME = "global-assertions.json"
LITERAL_SENSE_ROUTING_FILENAME = "literal-sense-routing.json"
FINALIZATION_POLICY_VERSION = "global-finalization-policy.v1"

_FRAGMENT_REFERENCE_PATTERN = re.compile(r"\{\{fragment:([^{}]+)\}\}")


@dataclass(frozen=True)
class _Replacement:
    atom_id: str | None
    source_start: int
    source_end: int
    source_text: str
    global_object_id: str | None


@dataclass(frozen=True)
class _LiteralOccurrence:
    occurrence_id: str
    assertion_id: str
    source_start: int
    source_end: int
    source_text: str
    owner_ids: tuple[str, ...]


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _LiteralSenseAssignment(_StrictModel):
    occurrence_id: str = Field(min_length=1)
    global_object_id: str | None = Field(default=None, min_length=1)


class _LiteralSenseRoutingPlan(_StrictModel):
    assignments: list[_LiteralSenseAssignment]

    @model_validator(mode="after")
    def validate_unique_occurrences(self) -> _LiteralSenseRoutingPlan:
        ids = [item.occurrence_id for item in self.assignments]
        if len(set(ids)) != len(ids):
            raise ValueError("Literal sense routing 不能重复 occurrence_id")
        return self


class _LiteralSenseRoutingCheckpoint(_StrictModel):
    schema_version: Literal["literal-sense-routing.v2"] = "literal-sense-routing.v2"
    finalization_policy_version: Literal["global-finalization-policy.v1"]
    source_semantics_schema_version: Literal["source-semantics-full.v10"]
    source_semantics_policy_version: str = Field(min_length=1)
    source_sha256: str = Field(min_length=1)
    registry_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    routes: dict[str, list[_LiteralSenseAssignment]] = Field(default_factory=dict)


LITERAL_SENSE_SYSTEM_PROMPT = """
你只负责把同一词面的每处 literal occurrence 路由到已经存在的候选 Global Object，不能创建或
修改 Object，也不能改写 Assertion。联合阅读候选的身份画像、当前 Assertion 和直接证据；只有
当前用法明确落入某个候选词义时选择其 ID，否则返回 null。逐项覆盖 schema 给出的 occurrence_id，
完成后立即提交 JSON。
""".strip()


def build_global_assertions_artifact(
    dataset: SourceCompilationDataset,
    state: RegistryState,
    *,
    literal_sense_routes: dict[str, str | None] | None = None,
) -> GlobalAssertionsArtifact:
    """在完整 Registry 上生成 Global Assertion；不修改 Source Semantic IR。"""
    if state.next_source_region_ordinal != len(dataset.regions):
        raise ValueError("Global Assertion finalization 只能处理完整 Global Registry")
    if state.source_sha256 != dataset.source_sha256:
        raise ValueError("Global Registry 不属于当前 Source Semantic")
    if state.source_node_ids != list(dataset.source_node_ids):
        raise ValueError("Global Registry 与 SourceRegion 顺序不一致")

    reference_owners: dict[str, str] = {}
    surface_owners: dict[str, set[str]] = {}
    fragment_owners: dict[tuple[str, str], set[str]] = {}
    for item in state.objects:
        for atom in item.reference_atoms:
            previous = reference_owners.setdefault(atom.atom_id, item.global_object_id)
            if previous != item.global_object_id:
                raise ValueError(f"reference atom {atom.atom_id} 有多个当前 owner")
        for atom in item.surface_atoms:
            surface_owners.setdefault(atom.surface_form, set()).add(item.global_object_id)
            fragment_owners.setdefault(
                (atom.source_node_id, atom.source_fragment_id), set()
            ).add(item.global_object_id)
    disposed_fragment_keys = set(state.rejected_fragment_keys) | set(
        state.deferred_fragment_keys
    )
    unexplained_references = {
        atom_id
        for atom_id, atom in dataset.reference_atoms.items()
        if atom_id not in reference_owners
        and source_fragment_key(atom.source_node_id, atom.source_fragment_id)
        not in disposed_fragment_keys
    }
    if unexplained_references:
        raise ValueError("完整 Global Registry 存在未处置的 source reference atoms")
    fragment_fallbacks = {
        (fragment.source_node_id, fragment.source_fragment_id): fragment.surface_atoms[
            0
        ].surface_form
        for region in dataset.regions
        for fragment in region.fragments
        if fragment.fragment_key in disposed_fragment_keys
    }

    unique_surface_owners = {
        surface: next(iter(owners))
        for surface, owners in surface_owners.items()
        if len(owners) == 1
    }
    surfaces_longest_first = sorted(
        surface_owners,
        key=lambda value: (-len(value), value),
    )

    finalized = []
    source_reference_count = 0
    literal_reference_count = 0
    semantic_link_count = 0
    for region in dataset.regions:
        for assertion in region.assertions:
            source = assertion.statement_template_markdown
            source_replacements = []
            placeholder_spans = []
            source_matches = (
                list(_FRAGMENT_REFERENCE_PATTERN.finditer(source))
                if assertion.kind == "grounded"
                else []
            )
            for source_ordinal, match in enumerate(source_matches):
                atom_id = reference_atom_id(
                    assertion.source_node_id,
                    assertion.source_claim_id,
                    source_ordinal,
                )
                owner = reference_owners.get(atom_id)
                if owner is None:
                    fragment_id = match.group(1)
                    fallback = fragment_fallbacks.get(
                        (assertion.source_node_id, fragment_id)
                    )
                    if fallback is None:
                        raise ValueError(
                            f"{assertion.assertion_id} 的 {atom_id} 没有当前 owner"
                        )
                    source_replacements.append(
                        _Replacement(
                            atom_id=None,
                            source_start=match.start(),
                            source_end=match.end(),
                            source_text=fallback,
                            global_object_id=None,
                        )
                    )
                    placeholder_spans.append((match.start(), match.end()))
                    continue
                source_replacements.append(
                    _Replacement(
                        atom_id=atom_id,
                        source_start=match.start(),
                        source_end=match.end(),
                        source_text=match.group(0),
                        global_object_id=owner,
                    )
                )
                placeholder_spans.append((match.start(), match.end()))

            literal_occurrences = (
                _literal_occurrences(
                    source,
                    assertion_id=assertion.assertion_id,
                    surfaces_longest_first=surfaces_longest_first,
                    surface_owners=surface_owners,
                    excluded_spans=placeholder_spans,
                )
                if assertion.kind == "grounded"
                else []
            )
            routed_literals = []
            for item in literal_occurrences:
                owner = unique_surface_owners.get(item.source_text)
                if owner is None and literal_sense_routes is not None:
                    owner = literal_sense_routes.get(item.occurrence_id)
                if owner is None:
                    continue
                if owner not in item.owner_ids:
                    raise ValueError(
                        f"{item.occurrence_id} 被路由到不拥有该 surface 的 Global Object"
                    )
                routed_literals.append((item, owner))
            literal_replacements = [
                _Replacement(
                    atom_id=literal_reference_atom_id(
                        assertion.source_node_id,
                        assertion.source_claim_id,
                        ordinal,
                    ),
                    source_start=item.source_start,
                    source_end=item.source_end,
                    source_text=item.source_text,
                    global_object_id=owner,
                )
                for ordinal, (item, owner) in enumerate(routed_literals)
            ]
            replacements = sorted(
                [*source_replacements, *literal_replacements],
                key=lambda item: item.source_start,
            )
            _validate_non_overlapping(replacements, assertion.assertion_id)
            global_template = _replace_with_global_objects(source, replacements)
            if "{{fragment:" in global_template:
                raise ValueError(f"{assertion.assertion_id} 仍包含 Source Fragment 引用")
            linked_global_object_ids = list(
                dict.fromkeys(
                    object_id
                    for fragment_id in assertion.semantic_fragment_ids
                    for object_id in sorted(
                        fragment_owners.get(
                            (assertion.source_node_id, fragment_id), set()
                        )
                    )
                )
            )
            finalized.append(
                GlobalizedAssertion(
                    assertion_id=assertion.assertion_id,
                    kind=assertion.kind,
                    global_statement_template_markdown=global_template,
                    reference_atoms=[
                        GlobalAssertionReferenceAtom(
                            atom_id=item.atom_id,
                            ordinal=ordinal,
                            global_object_id=item.global_object_id,
                            source_start=item.source_start,
                            source_end=item.source_end,
                            source_text=item.source_text,
                        )
                        for ordinal, item in enumerate(
                            item
                            for item in replacements
                            if item.atom_id is not None
                            and item.global_object_id is not None
                        )
                    ],
                    linked_global_object_ids=linked_global_object_ids,
                )
            )
            source_reference_count += sum(
                item.global_object_id is not None for item in source_replacements
            )
            literal_reference_count += len(literal_replacements)
            semantic_link_count += len(linked_global_object_ids)

    return GlobalAssertionsArtifact(
        created_at=datetime.now(UTC),
        finalization_policy_version=FINALIZATION_POLICY_VERSION,
        source_semantics_schema_version=dataset.snapshot.schema_version,
        source_semantics_policy_version=dataset.snapshot.policy_version,
        global_resolution_schema_version="global-resolution.v6",
        global_resolution_policy_version=GLOBAL_RESOLUTION_POLICY_VERSION,
        source_sha256=dataset.source_sha256,
        source_node_ids=list(dataset.source_node_ids),
        assertions=finalized,
        total_assertions=len(finalized),
        total_source_reference_atoms=source_reference_count,
        total_literal_reference_atoms=literal_reference_count,
        total_reference_atoms=source_reference_count + literal_reference_count,
        total_semantic_object_links=semantic_link_count,
    )


def write_global_assertions_artifact(
    directory: Path,
    artifact: GlobalAssertionsArtifact,
) -> Path:
    path = directory.expanduser().resolve() / GLOBAL_ASSERTIONS_FILENAME
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(artifact.model_dump_json(indent=2), encoding="utf-8")
    temporary.replace(path)
    return path


async def resolve_ambiguous_literal_senses(
    *,
    model: ChatModel,
    dataset: SourceCompilationDataset,
    state: RegistryState,
    directory: Path,
    progress: ProgressReporter | None = None,
) -> dict[str, str | None]:
    """只为一词多义的 literal mention 调用模型，并按词面保存 checkpoint。"""
    reporter = progress or NullProgressReporter()
    surface_owners = _surface_owners(state)
    ambiguous = _ambiguous_occurrences(dataset, surface_owners)
    if not ambiguous:
        return {}

    fingerprint = _registry_fingerprint(state)
    checkpoint_path = directory / LITERAL_SENSE_ROUTING_FILENAME
    checkpoint = _load_literal_sense_checkpoint(
        checkpoint_path,
        source_semantics_schema_version=dataset.snapshot.schema_version,
        source_semantics_policy_version=dataset.snapshot.policy_version,
        source_sha256=dataset.source_sha256,
        registry_fingerprint=fingerprint,
    )
    routes_by_surface = dict(checkpoint.routes) if checkpoint is not None else {}
    object_by_id = state.object_by_id()
    for ordinal, surface in enumerate(sorted(ambiguous), start=1):
        occurrences = ambiguous[surface]
        cached = routes_by_surface.get(surface)
        if cached is not None and _valid_literal_assignments(cached, occurrences):
            reporter.report(
                "歧义分流",
                f"复用 {ordinal}/{len(ambiguous)}：{surface}（{len(occurrences)} 处）",
            )
            continue
        reporter.report(
            "歧义分流",
            f"判断 {ordinal}/{len(ambiguous)}：{surface}（{len(occurrences)} 处）",
        )
        routes_by_surface[surface] = await _decide_literal_senses(
            model=model,
            dataset=dataset,
            surface=surface,
            occurrences=occurrences,
            candidates=[object_by_id[item] for item in occurrences[0].owner_ids],
        )
        _write_literal_sense_checkpoint(
            checkpoint_path,
            _LiteralSenseRoutingCheckpoint(
                finalization_policy_version=FINALIZATION_POLICY_VERSION,
                source_semantics_schema_version=dataset.snapshot.schema_version,
                source_semantics_policy_version=dataset.snapshot.policy_version,
                source_sha256=dataset.source_sha256,
                registry_fingerprint=fingerprint,
                routes=routes_by_surface,
            ),
        )

    return {
        assignment.occurrence_id: assignment.global_object_id
        for assignments in routes_by_surface.values()
        for assignment in assignments
    }


def load_literal_sense_routes(
    *,
    dataset: SourceCompilationDataset,
    state: RegistryState,
    directory: Path,
) -> dict[str, str | None]:
    """加载与当前 Source/Registry 完全一致的歧义分流结果。"""
    checkpoint = _load_literal_sense_checkpoint(
        directory.expanduser().resolve() / LITERAL_SENSE_ROUTING_FILENAME,
        source_semantics_schema_version=dataset.snapshot.schema_version,
        source_semantics_policy_version=dataset.snapshot.policy_version,
        source_sha256=dataset.source_sha256,
        registry_fingerprint=_registry_fingerprint(state),
    )
    if checkpoint is None:
        return {}
    return {
        assignment.occurrence_id: assignment.global_object_id
        for assignments in checkpoint.routes.values()
        for assignment in assignments
    }


async def _decide_literal_senses(
    *,
    model: ChatModel,
    dataset: SourceCompilationDataset,
    surface: str,
    occurrences: list[_LiteralOccurrence],
    candidates: list[ActiveGlobalObject],
) -> list[_LiteralSenseAssignment]:
    assignments: list[_LiteralSenseAssignment] = []
    chunk_size = 40
    chunks = [
        occurrences[index : index + chunk_size]
        for index in range(0, len(occurrences), chunk_size)
    ]
    for chunk_ordinal, chunk in enumerate(chunks, start=1):
        expected_ids = {item.occurrence_id for item in chunk}
        allowed_object_ids = set(chunk[0].owner_ids)
        prompt = _literal_sense_prompt(
            dataset=dataset,
            surface=surface,
            occurrences=chunk,
            candidates=candidates,
        )
        last_error: ValueError | None = None
        for attempt in range(1, 3):
            retry_note = (
                "\n上一轮未通过协议校验："
                + _compact_error(last_error)
                + "。只修复 JSON 和覆盖范围，不要遗漏或新增 occurrence_id。"
                if last_error is not None
                else ""
            )
            turn = await model.complete_turn(
                messages=[
                    {
                        "role": "system",
                        "content": LITERAL_SENSE_SYSTEM_PROMPT + retry_note,
                    },
                    {"role": "user", "content": prompt},
                ],
                request_label=(
                    f"歧义词面·{surface}·{chunk_ordinal}/{len(chunks)}"
                    + ("·retry" if attempt == 2 else "")
                ),
                thinking="enabled",
            )
            try:
                if turn.tool_calls or not turn.content:
                    raise ValueError("模型没有返回 JSON 正文")
                plan = _LiteralSenseRoutingPlan.model_validate_json(
                    normalize_json_document(turn.content)
                )
                if {item.occurrence_id for item in plan.assignments} != expected_ids:
                    raise ValueError("assignments 必须完整且仅覆盖本批 occurrence_id")
                if {
                    item.global_object_id
                    for item in plan.assignments
                    if item.global_object_id is not None
                } - allowed_object_ids:
                    raise ValueError("assignment 选择了候选列表之外的 Global Object")
            except ValueError as error:
                reject_model_turn(model, turn)
                last_error = error
                continue
            commit_model_turn(model, turn)
            assignments.extend(plan.assignments)
            break
        else:
            assert last_error is not None
            raise ModelOutputError(
                f"词面“{surface}”的语义分流连续失败：{_compact_error(last_error)}"
            ) from last_error
    return assignments


def _literal_sense_prompt(
    *,
    dataset: SourceCompilationDataset,
    surface: str,
    occurrences: list[_LiteralOccurrence],
    candidates: list[ActiveGlobalObject],
) -> str:
    payload = {
        "surface": surface,
        "candidate_senses": [_literal_candidate_payload(item) for item in candidates],
        "occurrences": [
            {
                "occurrence_id": item.occurrence_id,
                "assertion_id": item.assertion_id,
                "statement_template_markdown": dataset.assertions[
                    item.assertion_id
                ].statement_template_markdown,
                "supporting_blocks": [
                    {
                        "source_block_id": block.source_block_id,
                        "markdown": _truncate(block.markdown, 800),
                    }
                    for block in dataset.assertions[item.assertion_id].supporting_blocks[:2]
                ],
            }
            for item in occurrences
        ],
        "output_schema": _LiteralSenseRoutingPlan.model_json_schema(),
    }
    return (
        "请逐项分流以下同词面 occurrence。每个 occurrence_id 必须且只能出现一次；"
        "global_object_id 只能取 candidate_senses 中的 ID 或 null。\n"
        + json.dumps(payload, ensure_ascii=False, indent=2)
    )


def _literal_candidate_payload(item: ActiveGlobalObject) -> dict[str, object]:
    return {
        "global_object_id": item.global_object_id,
        "canonical_name": item.canonical_name,
        "surface_forms": list(
            dict.fromkeys(atom.surface_form for atom in item.surface_atoms)
        )[:12],
        "evidence_assertions": [
            {
                "assertion_id": assertion.assertion_id,
                "statement_template_markdown": _truncate(
                    assertion.statement_template_markdown, 700
                ),
                "supporting_blocks": [
                    _truncate(block.markdown, 500)
                    for block in assertion.supporting_blocks[:1]
                ],
            }
            for assertion in item.assertions[:8]
        ],
    }


def finalize_existing_global_resolution(
    path: Path,
) -> tuple[Path, GlobalAssertionsArtifact]:
    """为已完成的 Global Resolution 补生成 Global Assertions，无需重跑模型。"""
    resolved = path.expanduser().resolve()
    resolution_path = resolved / "global-resolution.json" if resolved.is_dir() else resolved
    if not resolution_path.is_file() or resolution_path.name != "global-resolution.json":
        raise ValueError("--resolution 必须指向 Global Resolution 目录或 global-resolution.json")
    resolution = GlobalResolutionArtifact.model_validate_json(
        resolution_path.read_text(encoding="utf-8")
    )
    source_path = _find_upward(resolution_path.parent, "source-semantics-full.json")
    dataset = load_source_compilation(source_path)
    if resolution.resolution_policy_version != GLOBAL_RESOLUTION_POLICY_VERSION:
        raise ValueError("Global Resolution 身份裁决策略版本不一致")
    if resolution.source_semantics_schema_version != dataset.snapshot.schema_version:
        raise ValueError("Global Resolution 与 Source Semantic schema 不一致")
    if resolution.source_semantics_policy_version != dataset.snapshot.policy_version:
        raise ValueError("Global Resolution 与 Source Semantic policy 不一致")
    if resolution.source_sha256 != dataset.source_sha256:
        raise ValueError("Global Resolution 与 Source Semantic SHA256 不一致")
    if resolution.source_node_ids != list(dataset.source_node_ids):
        raise ValueError("Global Resolution 与 SourceRegion 顺序不一致")
    if resolution.source_region_count != len(dataset.regions):
        raise ValueError("Global Resolution 未覆盖全部 SourceRegion")
    state = rebuild_registry(
        resolution.global_objects,
        dataset,
        next_source_region_ordinal=len(dataset.regions),
        rejected_fragment_keys=resolution.rejected_fragment_keys,
        deferred_fragment_keys=resolution.deferred_fragment_keys,
    )
    artifact = build_global_assertions_artifact(
        dataset,
        state,
        literal_sense_routes=load_literal_sense_routes(
            dataset=dataset,
            state=state,
            directory=resolution_path.parent,
        ),
    )
    output = write_global_assertions_artifact(resolution_path.parent, artifact)
    return output, artifact


def _literal_candidates(
    source: str,
    *,
    surfaces_longest_first: list[str],
    surface_owners: dict[str, str],
    excluded_spans: list[tuple[int, int]],
) -> list[_Replacement]:
    occurrences = _literal_occurrences(
        source,
        assertion_id="legacy",
        surfaces_longest_first=surfaces_longest_first,
        surface_owners={surface: {owner} for surface, owner in surface_owners.items()},
        excluded_spans=excluded_spans,
    )
    return [
        _Replacement(
            atom_id="",
            source_start=item.source_start,
            source_end=item.source_end,
            source_text=item.source_text,
            global_object_id=item.owner_ids[0],
        )
        for item in occurrences
    ]


def _surface_owners(state: RegistryState) -> dict[str, set[str]]:
    owners: dict[str, set[str]] = {}
    for item in state.objects:
        for atom in item.surface_atoms:
            owners.setdefault(atom.surface_form, set()).add(item.global_object_id)
    return owners


def _ambiguous_occurrences(
    dataset: SourceCompilationDataset,
    surface_owners: dict[str, set[str]],
) -> dict[str, list[_LiteralOccurrence]]:
    surfaces_longest_first = sorted(
        surface_owners,
        key=lambda value: (-len(value), value),
    )
    result: dict[str, list[_LiteralOccurrence]] = {}
    for region in dataset.regions:
        for assertion in region.assertions:
            if assertion.kind != "grounded":
                continue
            excluded_spans = [
                (match.start(), match.end())
                for match in _FRAGMENT_REFERENCE_PATTERN.finditer(
                    assertion.statement_template_markdown
                )
            ]
            for occurrence in _literal_occurrences(
                assertion.statement_template_markdown,
                assertion_id=assertion.assertion_id,
                surfaces_longest_first=surfaces_longest_first,
                surface_owners=surface_owners,
                excluded_spans=excluded_spans,
            ):
                if len(occurrence.owner_ids) > 1:
                    result.setdefault(occurrence.source_text, []).append(occurrence)
    return result


def _valid_literal_assignments(
    assignments: list[_LiteralSenseAssignment],
    occurrences: list[_LiteralOccurrence],
) -> bool:
    occurrence_by_id = {item.occurrence_id: item for item in occurrences}
    if {item.occurrence_id for item in assignments} != set(occurrence_by_id):
        return False
    return all(
        item.global_object_id is None
        or item.global_object_id in occurrence_by_id[item.occurrence_id].owner_ids
        for item in assignments
    )


def _registry_fingerprint(state: RegistryState) -> str:
    payload = [
        {
            "global_object_id": item.global_object_id,
            "canonical_name": item.canonical_name,
            "surface_atom_ids": [atom.atom_id for atom in item.surface_atoms],
            "reference_atom_ids": [atom.atom_id for atom in item.reference_atoms],
        }
        for item in sorted(state.objects, key=lambda value: value.global_object_key)
    ]
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()


def _load_literal_sense_checkpoint(
    path: Path,
    *,
    source_semantics_schema_version: str,
    source_semantics_policy_version: str,
    source_sha256: str,
    registry_fingerprint: str,
) -> _LiteralSenseRoutingCheckpoint | None:
    if not path.is_file():
        return None
    try:
        checkpoint = _LiteralSenseRoutingCheckpoint.model_validate_json(
            path.read_text(encoding="utf-8")
        )
    except ValueError:
        return None
    if (
        checkpoint.finalization_policy_version != FINALIZATION_POLICY_VERSION
        or checkpoint.source_semantics_schema_version != source_semantics_schema_version
        or checkpoint.source_semantics_policy_version != source_semantics_policy_version
        or checkpoint.source_sha256 != source_sha256
        or checkpoint.registry_fingerprint != registry_fingerprint
    ):
        return None
    return checkpoint


def _write_literal_sense_checkpoint(
    path: Path,
    checkpoint: _LiteralSenseRoutingCheckpoint,
) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(checkpoint.model_dump_json(indent=2), encoding="utf-8")
    temporary.replace(path)


def _truncate(value: str, limit: int) -> str:
    return value if len(value) <= limit else value[: limit - 1].rstrip() + "…"


def _compact_error(error: Exception) -> str:
    return re.sub(r"\s+", " ", str(error)).strip()[:500] or type(error).__name__


def _literal_occurrences(
    source: str,
    *,
    assertion_id: str,
    surfaces_longest_first: list[str],
    surface_owners: dict[str, set[str]],
    excluded_spans: list[tuple[int, int]],
) -> list[_LiteralOccurrence]:
    candidates = []
    for surface in surfaces_longest_first:
        start = source.find(surface)
        while start >= 0:
            end = start + len(surface)
            if not _overlaps(start, end, excluded_spans):
                candidates.append(
                    _LiteralOccurrence(
                        occurrence_id=_literal_occurrence_id(
                            assertion_id,
                            start,
                            end,
                            surface,
                        ),
                        assertion_id=assertion_id,
                        source_start=start,
                        source_end=end,
                        source_text=surface,
                        owner_ids=tuple(sorted(surface_owners[surface])),
                    )
                )
            start = source.find(surface, start + 1)

    selected = []
    occupied = list(excluded_spans)
    for item in sorted(
        candidates,
        key=lambda value: (
            -(value.source_end - value.source_start),
            value.source_start,
            value.source_text,
            value.owner_ids,
        ),
    ):
        if _overlaps(item.source_start, item.source_end, occupied):
            continue
        selected.append(item)
        occupied.append((item.source_start, item.source_end))
    return sorted(selected, key=lambda item: item.source_start)


def _literal_occurrence_id(
    assertion_id: str,
    source_start: int,
    source_end: int,
    source_text: str,
) -> str:
    suffix = hashlib.sha256(source_text.encode("utf-8")).hexdigest()[:12]
    return f"literal:{assertion_id}:{source_start}:{source_end}:{suffix}"


def _replace_with_global_objects(source: str, replacements: list[_Replacement]) -> str:
    parts = []
    cursor = 0
    for item in replacements:
        parts.append(source[cursor : item.source_start])
        parts.append(
            f"{{{{object:{item.global_object_id}}}}}"
            if item.global_object_id is not None
            else item.source_text
        )
        cursor = item.source_end
    parts.append(source[cursor:])
    return "".join(parts)


def _validate_non_overlapping(replacements: list[_Replacement], assertion_id: str) -> None:
    previous_end = 0
    atom_ids = set()
    for item in replacements:
        if item.source_start < previous_end:
            raise ValueError(f"{assertion_id} 的 Global Object references 发生重叠")
        if item.atom_id is not None and item.atom_id in atom_ids:
            raise ValueError(f"{assertion_id} 重复 reference atom {item.atom_id}")
        previous_end = item.source_end
        if item.atom_id is not None:
            atom_ids.add(item.atom_id)


def _overlaps(start: int, end: int, spans: list[tuple[int, int]]) -> bool:
    return any(start < span_end and end > span_start for span_start, span_end in spans)


def _find_upward(start: Path, name: str) -> Path:
    for directory in (start, *start.parents):
        candidate = directory / name
        if candidate.is_file():
            return candidate
    raise ValueError(f"从 {start} 向上找不到 {name}")


__all__ = [
    "GLOBAL_ASSERTIONS_FILENAME",
    "LITERAL_SENSE_ROUTING_FILENAME",
    "build_global_assertions_artifact",
    "finalize_existing_global_resolution",
    "load_literal_sense_routes",
    "resolve_ambiguous_literal_senses",
    "write_global_assertions_artifact",
]
