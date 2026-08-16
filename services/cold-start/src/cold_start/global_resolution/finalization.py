"""把 Source Assertion 物化为只引用当前 Global Object 的最终模板。"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from cold_start.global_resolution.artifacts import (
    SourceCompilationDataset,
    load_source_compilation,
    rebuild_registry,
)
from cold_start.global_resolution.models import (
    GlobalAssertionReferenceAtom,
    GlobalAssertionsArtifact,
    GlobalizedAssertion,
    GlobalResolutionArtifact,
    RegistryState,
    literal_reference_atom_id,
    reference_atom_id,
)

GLOBAL_ASSERTIONS_FILENAME = "global-assertions.json"

_FRAGMENT_REFERENCE_PATTERN = re.compile(r"\{\{fragment:([^{}]+)\}\}")


@dataclass(frozen=True)
class _Replacement:
    atom_id: str
    source_start: int
    source_end: int
    source_text: str
    global_object_id: str


def build_global_assertions_artifact(
    dataset: SourceCompilationDataset,
    state: RegistryState,
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
    if set(reference_owners) != set(dataset.reference_atoms):
        raise ValueError("完整 Global Registry 未覆盖全部 source reference atoms")

    unique_surface_owners = {
        surface: next(iter(owners))
        for surface, owners in surface_owners.items()
        if len(owners) == 1
    }
    surfaces_longest_first = sorted(
        unique_surface_owners,
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
                    raise ValueError(f"{assertion.assertion_id} 的 {atom_id} 没有当前 owner")
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

            literal_candidates = (
                _literal_candidates(
                    source,
                    surfaces_longest_first=surfaces_longest_first,
                    surface_owners=unique_surface_owners,
                    excluded_spans=placeholder_spans,
                )
                if assertion.kind == "grounded"
                else []
            )
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
                    global_object_id=item.global_object_id,
                )
                for ordinal, item in enumerate(literal_candidates)
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
            if assertion.kind == "reference" and not linked_global_object_ids:
                raise ValueError(
                    f"{assertion.assertion_id} 的 semantic Fragment 没有当前 Global Object owner"
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
                        for ordinal, item in enumerate(replacements)
                    ],
                    linked_global_object_ids=linked_global_object_ids,
                )
            )
            source_reference_count += len(source_replacements)
            literal_reference_count += len(literal_replacements)
            semantic_link_count += len(linked_global_object_ids)

    return GlobalAssertionsArtifact(
        created_at=datetime.now(UTC),
        source_semantics_schema_version=dataset.snapshot.schema_version,
        global_resolution_schema_version="global-resolution.v3",
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
    if resolution.source_semantics_schema_version != dataset.snapshot.schema_version:
        raise ValueError("Global Resolution 与 Source Semantic schema 不一致")
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
    )
    artifact = build_global_assertions_artifact(dataset, state)
    output = write_global_assertions_artifact(resolution_path.parent, artifact)
    return output, artifact


def _literal_candidates(
    source: str,
    *,
    surfaces_longest_first: list[str],
    surface_owners: dict[str, str],
    excluded_spans: list[tuple[int, int]],
) -> list[_Replacement]:
    candidates = []
    for surface in surfaces_longest_first:
        start = source.find(surface)
        while start >= 0:
            end = start + len(surface)
            if not _overlaps(start, end, excluded_spans):
                candidates.append(
                    _Replacement(
                        atom_id="",
                        source_start=start,
                        source_end=end,
                        source_text=surface,
                        global_object_id=surface_owners[surface],
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
            value.global_object_id,
        ),
    ):
        if _overlaps(item.source_start, item.source_end, occupied):
            continue
        selected.append(item)
        occupied.append((item.source_start, item.source_end))
    return sorted(selected, key=lambda item: item.source_start)


def _replace_with_global_objects(source: str, replacements: list[_Replacement]) -> str:
    parts = []
    cursor = 0
    for item in replacements:
        parts.append(source[cursor : item.source_start])
        parts.append(f"{{{{object:{item.global_object_id}}}}}")
        cursor = item.source_end
    parts.append(source[cursor:])
    return "".join(parts)


def _validate_non_overlapping(replacements: list[_Replacement], assertion_id: str) -> None:
    previous_end = 0
    atom_ids = set()
    for item in replacements:
        if item.source_start < previous_end:
            raise ValueError(f"{assertion_id} 的 Global Object references 发生重叠")
        if item.atom_id in atom_ids:
            raise ValueError(f"{assertion_id} 重复 reference atom {item.atom_id}")
        previous_end = item.source_end
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
    "build_global_assertions_artifact",
    "finalize_existing_global_resolution",
    "write_global_assertions_artifact",
]
