"""整树编译使用的确定性基础记忆操作。"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping

from cold_start.compilation.models import (
    Assertion,
    MemoryObject,
    MemoryPackage,
    MissingObjectDiscoveryOutput,
    MissingObjectReviewOutput,
    ParentIntegrationDecision,
    render_statement,
    rewrite_object_references,
)


def rebase_package(package: MemoryPackage, node_id: str) -> MemoryPackage:
    """给局部临时 ID 增加来源节点前缀，避免整树合并时冲突。"""

    object_map = {item.object_id: f"{node_id}/{item.object_id}" for item in package.objects}
    evidence_map = {
        item.evidence_id: f"{node_id}/{item.evidence_id}" for item in package.evidence
    }
    return MemoryPackage(
        objects=[
            item.model_copy(
                update={
                    "object_id": object_map[item.object_id],
                }
            )
            for item in package.objects
        ],
        assertions=[
            item.model_copy(
                update={
                    "assertion_id": f"{node_id}/{item.assertion_id}",
                    "statement_template_markdown": rewrite_object_references(
                        item.statement_template_markdown,
                        object_map,
                    ),
                    "holder_object_id": (
                        object_map[item.holder_object_id]
                        if item.holder_object_id
                        else None
                    ),
                    "evidence_ids": [evidence_map[value] for value in item.evidence_ids],
                }
            )
            for item in package.assertions
        ],
        evidence=[
            item.model_copy(update={"evidence_id": evidence_map[item.evidence_id]})
            for item in package.evidence
        ],
    )


def union_packages(packages: Iterable[MemoryPackage]) -> MemoryPackage:
    """无损拼接已经具有全树唯一 ID 的基础记忆包。"""

    values = list(packages)
    return MemoryPackage(
        objects=[item for package in values for item in package.objects],
        assertions=[item for package in values for item in package.assertions],
        evidence=[item for package in values for item in package.evidence],
    )


def apply_parent_decision(
    package: MemoryPackage,
    decision: ParentIntegrationDecision,
) -> MemoryPackage:
    """应用父节点的合并和纠正操作；没有操作时原样返回。"""

    object_ids = {item.object_id for item in package.objects}
    object_groups = _validate_groups(
        [item.object_ids for item in decision.object_merges],
        object_ids,
        "对象合并",
    )
    object_mapping: dict[str, str] = {}
    object_replacements: dict[str, MemoryObject] = {}
    objects_by_id = {item.object_id: item for item in package.objects}
    for operation, group in zip(decision.object_merges, object_groups, strict=True):
        if operation.preferred_object_id not in group:
            raise ValueError("对象合并的 preferred_object_id 必须位于 object_ids 中")
        preferred = objects_by_id[operation.preferred_object_id]
        members = [objects_by_id[value] for value in group]
        aliases = _unique(
            [
                alias
                for item in members
                for alias in [item.label, *item.aliases]
                if alias != preferred.label
            ]
        )
        object_replacements[preferred.object_id] = preferred.model_copy(
            update={"aliases": aliases}
        )
        object_mapping.update({value: preferred.object_id for value in group})

    objects = _replace_objects(package.objects, object_mapping, object_replacements)
    assertions = [
        item.model_copy(
            update={
                "statement_template_markdown": rewrite_object_references(
                    item.statement_template_markdown,
                    object_mapping,
                ),
                "holder_object_id": (
                    object_mapping.get(item.holder_object_id, item.holder_object_id)
                    if item.holder_object_id
                    else None
                ),
            }
        )
        for item in package.assertions
    ]

    assertion_ids = {item.assertion_id for item in assertions}
    assertion_groups = _validate_groups(
        [item.assertion_ids for item in decision.assertion_merges],
        assertion_ids,
        "叙述合并",
    )
    assertion_mapping: dict[str, str] = {}
    assertion_replacements: dict[str, Assertion] = {}
    assertions_by_id = {item.assertion_id: item for item in assertions}
    for operation, group in zip(decision.assertion_merges, assertion_groups, strict=True):
        if operation.preferred_assertion_id not in group:
            raise ValueError("叙述合并的 preferred_assertion_id 必须位于 assertion_ids 中")
        preferred = assertions_by_id[operation.preferred_assertion_id]
        members = [assertions_by_id[value] for value in group]
        referenced_sets = {frozenset(item.referenced_object_ids) for item in members}
        if len(referenced_sets) != 1:
            raise ValueError("叙述合并只能合并引用相同对象的叙述")
        temporal_scopes = {item.temporal_scope.model_dump_json() for item in members}
        if len(temporal_scopes) != 1:
            raise ValueError("叙述合并只能合并结构化时间相同的叙述")
        assertion_replacements[preferred.assertion_id] = preferred.model_copy(
            update={
                "evidence_ids": _unique(
                    evidence_id
                    for item in members
                    for evidence_id in item.evidence_ids
                ),
            }
        )
        assertion_mapping.update({value: preferred.assertion_id for value in group})

    assertions = _replace_assertions(
        assertions,
        assertion_mapping,
        assertion_replacements,
    )
    assertions_by_id = {item.assertion_id: item for item in assertions}
    for revision in decision.assertion_revisions:
        assertion_id = assertion_mapping.get(revision.assertion_id, revision.assertion_id)
        if assertion_id not in assertions_by_id:
            raise ValueError(f"叙述纠正引用了不存在的 ID：{revision.assertion_id}")
        statement_template = rewrite_object_references(
            revision.statement_template_markdown,
            object_mapping,
        )
        revised = Assertion(
            assertion_id=assertion_id,
            mode=revision.mode,
            statement_template_markdown=statement_template,
            holder_object_id=(
                object_mapping.get(revision.holder_object_id, revision.holder_object_id)
                if revision.holder_object_id
                else None
            ),
            temporal_scope=revision.temporal_scope,
            temporal_basis_markdown=revision.temporal_basis_markdown,
            uncertainty_markdown=revision.uncertainty_markdown,
            evidence_ids=assertions_by_id[assertion_id].evidence_ids,
        )
        missing = set(revised.referenced_object_ids) - {
            item.object_id for item in objects
        }
        if missing:
            raise ValueError(f"叙述纠正引用了不存在的对象：{', '.join(sorted(missing))}")
        if revised.holder_object_id and revised.holder_object_id not in {
            item.object_id for item in objects
        }:
            raise ValueError(
                f"叙述纠正引用了不存在的观点持有者：{revised.holder_object_id}"
            )
        assertions_by_id[assertion_id] = revised
    assertions = [assertions_by_id[item.assertion_id] for item in assertions]

    return MemoryPackage(
        objects=objects,
        assertions=assertions,
        evidence=package.evidence,
    )


def apply_missing_object_reviews(
    package: MemoryPackage,
    discovery: MissingObjectDiscoveryOutput,
    review: MissingObjectReviewOutput,
    *,
    node_id: str,
    evidence_text_by_id: Mapping[str, str],
) -> tuple[MemoryPackage, list[str]]:
    """只把独立复查接受的缺失 Object 写入包，并原位补全 Assertion 引用。"""

    candidates = {item.candidate_id: item for item in discovery.candidates}
    decisions = {item.candidate_id: item for item in review.decisions}
    if set(decisions) != set(candidates):
        missing = set(candidates) - set(decisions)
        unknown = set(decisions) - set(candidates)
        details = []
        if missing:
            details.append("未复查：" + ", ".join(sorted(missing)))
        if unknown:
            details.append("未知候选：" + ", ".join(sorted(unknown)))
        raise ValueError("缺失 Object 复查必须逐项覆盖候选；" + "；".join(details))

    assertions_by_id = {item.assertion_id: item for item in package.assertions}
    evidence_ids = {item.evidence_id for item in package.evidence}
    objects = list(package.objects)
    created_object_ids: list[str] = []
    known_names = {
        name.casefold()
        for item in objects
        for name in [item.label, *item.aliases]
    }

    for candidate in discovery.candidates:
        _require_subset(
            candidate.supporting_assertion_ids,
            set(assertions_by_id),
            f"{candidate.candidate_id} 的 supporting_assertion_ids",
        )
        _require_subset(
            candidate.proof_evidence_ids,
            evidence_ids,
            f"{candidate.candidate_id} 的 proof_evidence_ids",
        )
        candidate_assertion_evidence = {
            evidence_id
            for assertion_id in candidate.supporting_assertion_ids
            for evidence_id in assertions_by_id[assertion_id].evidence_ids
        }
        _require_subset(
            candidate.proof_evidence_ids,
            candidate_assertion_evidence,
            f"{candidate.candidate_id} 的桥接 Evidence",
        )

        decision = decisions[candidate.candidate_id]
        if decision.verdict != "accept":
            continue
        assert decision.confirmed_label is not None
        if decision.confirmed_label != candidate.proposed_label:
            raise ValueError(
                f"{candidate.candidate_id} 的复查不得改写 proposed_label"
            )
        if not set(decision.confirmed_aliases) <= set(candidate.proposed_aliases):
            raise ValueError(
                f"{candidate.candidate_id} 的复查不得新增发现阶段没有的 alias"
            )
        new_names = {
            value.casefold()
            for value in [decision.confirmed_label, *decision.confirmed_aliases]
        }
        if new_names & known_names:
            raise ValueError(
                f"{candidate.candidate_id} 的 Object 已存在：{decision.confirmed_label}"
            )
        candidate_bindings = {
            (item.assertion_id, item.literal_surface) for item in candidate.bindings
        }
        confirmed_bindings = {
            (item.assertion_id, item.literal_surface)
            for item in decision.confirmed_bindings
        }
        if not confirmed_bindings <= candidate_bindings:
            raise ValueError(
                f"{candidate.candidate_id} 的复查绑定超出发现阶段候选"
            )
        _require_subset(
            decision.confirmed_evidence_ids,
            set(candidate.proof_evidence_ids),
            f"{candidate.candidate_id} 的 confirmed_evidence_ids",
        )
        normalized_label = _compact_text(decision.confirmed_label)
        if not any(
            normalized_label in _compact_text(evidence_text_by_id[evidence_id])
            for evidence_id in decision.confirmed_evidence_ids
        ):
            raise ValueError(
                f"{candidate.candidate_id} 的 confirmed_label 未出现在复查 Evidence 原文中"
            )

        object_id = _next_object_id(objects, node_id)
        new_object = MemoryObject(
            object_id=object_id,
            label=decision.confirmed_label,
            aliases=decision.confirmed_aliases,
        )
        before_objects = {item.object_id: item for item in objects}
        objects.append(new_object)
        after_objects = {item.object_id: item for item in objects}
        for binding in decision.confirmed_bindings:
            assertion = assertions_by_id.get(binding.assertion_id)
            if assertion is None:
                raise ValueError(
                    f"{candidate.candidate_id} 绑定了不存在的 Assertion："
                    f"{binding.assertion_id}"
                )
            before_rendered = render_statement(assertion, before_objects)
            template = _replace_literal_outside_references(
                assertion.statement_template_markdown,
                binding.literal_surface,
                f"{{{{object:{object_id}}}}}",
            )
            if template == assertion.statement_template_markdown:
                raise ValueError(
                    f"{candidate.candidate_id} 的字面绑定未出现在 Assertion："
                    f"{binding.assertion_id}"
                )
            revised = assertion.model_copy(
                update={"statement_template_markdown": template}
            )
            if render_statement(revised, after_objects) != before_rendered:
                raise ValueError(
                    f"{candidate.candidate_id} 的绑定改变了 Assertion 可见正文"
                )
            assertions_by_id[binding.assertion_id] = revised

        known_names.add(decision.confirmed_label.casefold())
        known_names.update(value.casefold() for value in decision.confirmed_aliases)
        created_object_ids.append(object_id)

    return (
        MemoryPackage(
            objects=objects,
            assertions=[assertions_by_id[item.assertion_id] for item in package.assertions],
            evidence=package.evidence,
        ),
        created_object_ids,
    )


def _validate_groups(
    groups: list[list[str]],
    known_ids: set[str],
    label: str,
) -> list[list[str]]:
    seen: set[str] = set()
    normalized: list[list[str]] = []
    for values in groups:
        group = _unique(values)
        if len(group) < 2:
            raise ValueError(f"{label}至少需要两个不同 ID")
        missing = set(group) - known_ids
        if missing:
            raise ValueError(f"{label}引用了不存在的 ID：{', '.join(sorted(missing))}")
        overlap = set(group) & seen
        if overlap:
            raise ValueError(f"{label}的分组发生重叠：{', '.join(sorted(overlap))}")
        seen.update(group)
        normalized.append(group)
    return normalized


def _replace_objects(
    objects: list[MemoryObject],
    mapping: Mapping[str, str],
    replacements: Mapping[str, MemoryObject],
) -> list[MemoryObject]:
    result: list[MemoryObject] = []
    inserted: set[str] = set()
    for item in objects:
        target = mapping.get(item.object_id, item.object_id)
        if target in inserted:
            continue
        result.append(replacements.get(target, item))
        inserted.add(target)
    return result


def _replace_assertions(
    assertions: list[Assertion],
    mapping: Mapping[str, str],
    replacements: Mapping[str, Assertion],
) -> list[Assertion]:
    result: list[Assertion] = []
    inserted: set[str] = set()
    for item in assertions:
        target = mapping.get(item.assertion_id, item.assertion_id)
        if target in inserted:
            continue
        result.append(replacements.get(target, item))
        inserted.add(target)
    return result


def _unique(values: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(values))


def _require_subset(values: Iterable[str], known: set[str], label: str) -> None:
    missing = set(values) - known
    if missing:
        raise ValueError(f"{label} 引用了不存在的 ID：{', '.join(sorted(missing))}")


def _next_object_id(objects: list[MemoryObject], node_id: str) -> str:
    prefix = f"{node_id}/obj-"
    indexes = [
        int(item.object_id.removeprefix(prefix))
        for item in objects
        if item.object_id.startswith(prefix)
        and item.object_id.removeprefix(prefix).isdigit()
    ]
    return f"{prefix}{max(indexes, default=0) + 1}"


def _replace_literal_outside_references(template: str, literal: str, replacement: str) -> str:
    parts = re.split(r"(\{\{object:[^{}]+\}\})", template)
    return "".join(
        part if part.startswith("{{object:") else part.replace(literal, replacement)
        for part in parts
    )


def _compact_text(value: str) -> str:
    return "".join(value.split()).casefold()
