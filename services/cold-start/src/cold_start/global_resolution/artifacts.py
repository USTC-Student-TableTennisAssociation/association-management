"""读取不可变 Source IR，并保存本地 Global Resolver 当前状态。"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from cold_start.compilation.source_semantics import FullSourceSemanticSnapshot
from cold_start.document.models import ParsedBlock
from cold_start.global_resolution.models import (
    ActiveGlobalObject,
    AssertionEvidence,
    GlobalResolutionArtifact,
    GlobalResolutionWorking,
    ReferenceAtom,
    RegistryState,
    SourceBlockEvidence,
    SourceFragmentDossier,
    SourceRegionDossier,
    StoredGlobalObject,
    SurfaceAtom,
    assertion_key,
    reference_atom_id,
    surface_atom_id,
)

_FRAGMENT_REFERENCE_PATTERN = re.compile(r"\{\{fragment:([^{}]+)\}\}")


@dataclass(frozen=True)
class SourceCompilationDataset:
    directory: Path
    snapshot: FullSourceSemanticSnapshot
    regions: tuple[SourceRegionDossier, ...]
    assertions: dict[str, AssertionEvidence]
    surface_atoms: dict[str, SurfaceAtom]
    reference_atoms: dict[str, ReferenceAtom]

    @property
    def source_sha256(self) -> str:
        return self.snapshot.source.sha256

    @property
    def source_node_ids(self) -> tuple[str, ...]:
        return tuple(self.snapshot.source_node_ids)


@dataclass(frozen=True)
class GlobalResolutionPaths:
    directory: Path
    model_streams: Path
    working_json: Path
    artifact_json: Path


def load_source_compilation(
    path: Path,
    *,
    allow_partial: bool = False,
) -> SourceCompilationDataset:
    resolved = path.expanduser().resolve()
    snapshot_path = resolved / "source-semantics-full.json" if resolved.is_dir() else resolved
    directory = snapshot_path.parent
    if not snapshot_path.is_file():
        raise ValueError("--compilation 必须指向完整来源语义目录或 source-semantics-full.json")
    snapshot = FullSourceSemanticSnapshot.model_validate_json(
        snapshot_path.read_text(encoding="utf-8")
    )
    compiled_ids = [item.region_node_id for item in snapshot.sources]
    expected_ids = (
        snapshot.source_node_ids[: len(compiled_ids)] if allow_partial else snapshot.source_node_ids
    )
    if compiled_ids != expected_ids:
        label = "可用前缀" if allow_partial else "sources"
        raise ValueError(f"source-semantics-full.json 的 {label} 顺序与 source_node_ids 不一致")

    blocks_path = _find_upward(directory, "parsed-blocks.json")
    raw_blocks = json.loads(blocks_path.read_text(encoding="utf-8"))
    blocks = tuple(ParsedBlock.model_validate(item) for item in raw_blocks)
    if len(blocks) != snapshot.source.block_count:
        raise ValueError("parsed-blocks.json 与 Source Semantic 的 block_count 不一致")
    block_by_id = {item.block_id: item for item in blocks}
    if len(block_by_id) != len(blocks):
        raise ValueError("parsed-blocks.json 包含重复 block_id")

    assertions: dict[str, AssertionEvidence] = {}
    surface_atoms: dict[str, SurfaceAtom] = {}
    reference_atoms: dict[str, ReferenceAtom] = {}
    regions = []
    for source in snapshot.sources:
        source_blocks = []
        for block_id in source.source_block_ids:
            block = block_by_id.get(block_id)
            if block is None:
                raise ValueError(f"{source.region_node_id} 找不到 SourceBlock：{block_id}")
            source_blocks.append(block)
        evidence_by_claim: dict[str, AssertionEvidence] = {}
        references_by_fragment: dict[str, list[ReferenceAtom]] = {}
        for assertion in source.assertions:
            key = assertion_key(source.region_node_id, assertion.claim_id)
            supporting_blocks = []
            for block_id in assertion.supporting_block_ids:
                block = block_by_id.get(block_id)
                if block is None:
                    raise ValueError(f"{key} 找不到 supporting block：{block_id}")
                supporting_blocks.append(
                    SourceBlockEvidence(
                        source_block_id=block.block_id,
                        markdown=block.markdown,
                    )
                )
            evidence = AssertionEvidence(
                assertion_id=key,
                source_node_id=source.region_node_id,
                source_claim_id=assertion.claim_id,
                kind=assertion.kind,
                statement_template_markdown=assertion.statement_template_markdown,
                semantic_fragment_ids=assertion.semantic_fragment_ids,
                context_dependent=assertion.context_dependent,
                supporting_blocks=supporting_blocks,
            )
            assertions[key] = evidence
            evidence_by_claim[assertion.claim_id] = evidence
            for ordinal, match in enumerate(
                _FRAGMENT_REFERENCE_PATTERN.finditer(assertion.statement_template_markdown)
            ):
                source_fragment_id = match.group(1)
                atom = ReferenceAtom(
                    atom_id=reference_atom_id(
                        source.region_node_id,
                        assertion.claim_id,
                        ordinal,
                    ),
                    source_node_id=source.region_node_id,
                    source_claim_id=assertion.claim_id,
                    source_fragment_id=source_fragment_id,
                    ordinal=ordinal,
                )
                reference_atoms[atom.atom_id] = atom
                references_by_fragment.setdefault(source_fragment_id, []).append(atom)

        known_fragment_ids = {item.fragment_id for item in source.object_fragments}
        unknown_references = set(references_by_fragment) - known_fragment_ids
        if unknown_references:
            raise ValueError(
                f"{source.region_node_id} Assertion 引用了未知 Fragment："
                + "、".join(sorted(unknown_references))
            )
        unknown_semantic_links = {
            fragment_id
            for assertion in source.assertions
            for fragment_id in assertion.semantic_fragment_ids
        } - known_fragment_ids
        if unknown_semantic_links:
            raise ValueError(
                f"{source.region_node_id} Reference Assertion 引用未知 Fragment："
                + "、".join(sorted(unknown_semantic_links))
            )
        fragments = []
        for fragment in source.object_fragments:
            fragment_surfaces = []
            for ordinal, surface_form in enumerate(fragment.surface_forms):
                atom = SurfaceAtom(
                    atom_id=surface_atom_id(
                        source.region_node_id,
                        fragment.fragment_id,
                        ordinal,
                    ),
                    source_node_id=source.region_node_id,
                    source_fragment_id=fragment.fragment_id,
                    ordinal=ordinal,
                    surface_form=surface_form,
                )
                surface_atoms[atom.atom_id] = atom
                fragment_surfaces.append(atom)
            fragment_references = references_by_fragment.get(fragment.fragment_id, [])
            fragment_assertion_ids = list(
                dict.fromkeys(
                    assertion_key(item.source_node_id, item.source_claim_id)
                    for item in fragment_references
                )
            )
            fragments.append(
                SourceFragmentDossier(
                    source_node_id=source.region_node_id,
                    source_fragment_id=fragment.fragment_id,
                    surface_atoms=fragment_surfaces,
                    reference_atoms=fragment_references,
                    assertions=[assertions[item] for item in fragment_assertion_ids],
                )
            )
        regions.append(
            SourceRegionDossier(
                source_node_id=source.region_node_id,
                region_label=source.label,
                lineage_node_ids=source.lineage_node_ids,
                fragments=fragments,
                assertions=[evidence_by_claim[item.claim_id] for item in source.assertions],
                context_markdown="\n\n".join(
                    f"[{block.block_id}]\n{block.markdown}" for block in source_blocks
                ),
            )
        )

    if len(surface_atoms) != snapshot.total_surface_forms:
        raise ValueError("Source Semantic total_surface_forms 与实际 atom 数量不一致")
    return SourceCompilationDataset(
        directory=directory,
        snapshot=snapshot,
        regions=tuple(regions),
        assertions=assertions,
        surface_atoms=surface_atoms,
        reference_atoms=reference_atoms,
    )


def create_global_resolution_paths(compilation_directory: Path) -> GlobalResolutionPaths:
    directory = (
        compilation_directory.expanduser().resolve()
        / "global-resolutions"
        / f"{datetime.now(UTC):%Y%m%dT%H%M%S%fZ}-full"
    )
    directory.mkdir(parents=True, exist_ok=False)
    model_streams = directory / "model-streams"
    model_streams.mkdir()
    return _paths(directory)


def open_global_resolution_paths(directory: Path) -> GlobalResolutionPaths:
    paths = _paths(directory.expanduser().resolve())
    if not paths.directory.is_dir() or not paths.model_streams.is_dir():
        raise ValueError("--resume 必须指向包含 model-streams 的 Global Resolution 目录")
    if not paths.working_json.is_file():
        raise ValueError("Global Resolution 恢复目录缺少 working.json")
    if paths.artifact_json.exists():
        raise ValueError("该 Global Resolution 已经完成，不需要恢复")
    return paths


def load_working_registry(
    paths: GlobalResolutionPaths,
    dataset: SourceCompilationDataset,
) -> RegistryState:
    working = GlobalResolutionWorking.model_validate_json(
        paths.working_json.read_text(encoding="utf-8")
    )
    _validate_source_identity(
        schema_version=working.source_semantics_schema_version,
        source_sha256=working.source_sha256,
        source_node_ids=working.source_node_ids,
        dataset=dataset,
    )
    return rebuild_registry(
        working.global_objects,
        dataset,
        next_source_region_ordinal=working.next_source_region_ordinal,
    )


def initial_registry(dataset: SourceCompilationDataset) -> RegistryState:
    return RegistryState(
        source_sha256=dataset.source_sha256,
        source_node_ids=list(dataset.source_node_ids),
    )


def write_working_registry(
    paths: GlobalResolutionPaths,
    dataset: SourceCompilationDataset,
    state: RegistryState,
) -> None:
    working = GlobalResolutionWorking(
        source_semantics_schema_version=dataset.snapshot.schema_version,
        source_sha256=dataset.source_sha256,
        source_node_ids=list(dataset.source_node_ids),
        next_source_region_ordinal=state.next_source_region_ordinal,
        global_objects=store_registry(state),
    )
    _atomic_write(paths.working_json, working.model_dump_json(indent=2))


def write_final_artifact(
    paths: GlobalResolutionPaths,
    dataset: SourceCompilationDataset,
    state: RegistryState,
) -> GlobalResolutionArtifact:
    if state.next_source_region_ordinal != len(dataset.regions):
        raise ValueError("Global Resolution 尚未处理完全部 SourceRegion")
    _validate_registry_cursor(state, dataset)
    artifact = GlobalResolutionArtifact(
        created_at=datetime.now(UTC),
        source_semantics_schema_version=dataset.snapshot.schema_version,
        source_sha256=dataset.source_sha256,
        source_node_ids=list(dataset.source_node_ids),
        source_region_count=len(dataset.regions),
        global_objects=store_registry(state),
        total_surface_atoms=len(dataset.surface_atoms),
        total_reference_atoms=len(dataset.reference_atoms),
    )
    _atomic_write(paths.artifact_json, artifact.model_dump_json(indent=2))
    return artifact


def store_registry(state: RegistryState) -> list[StoredGlobalObject]:
    return [
        StoredGlobalObject(
            global_object_id=item.global_object_id,
            global_object_key=item.global_object_key,
            canonical_name=item.canonical_name,
            surface_atom_ids=[atom.atom_id for atom in item.surface_atoms],
            reference_atom_ids=[atom.atom_id for atom in item.reference_atoms],
        )
        for item in sorted(state.objects, key=lambda value: value.global_object_key)
    ]


def rebuild_registry(
    stored: list[StoredGlobalObject],
    dataset: SourceCompilationDataset,
    *,
    next_source_region_ordinal: int,
) -> RegistryState:
    objects = []
    for item in stored:
        try:
            surfaces = [dataset.surface_atoms[atom_id] for atom_id in item.surface_atom_ids]
            references = [dataset.reference_atoms[atom_id] for atom_id in item.reference_atom_ids]
        except KeyError as error:
            raise ValueError(
                f"Global Resolution 引用了未知 Source atom：{error.args[0]}"
            ) from error
        if not surfaces:
            raise ValueError("Global Object 必须至少拥有一个 surface atom")
        if item.canonical_name not in {atom.surface_form for atom in surfaces}:
            raise ValueError("Global Object canonical_name 必须来自当前 surface atom")
        assertion_ids = list(
            dict.fromkeys(
                assertion_key(atom.source_node_id, atom.source_claim_id) for atom in references
            )
        )
        objects.append(
            ActiveGlobalObject(
                global_object_id=item.global_object_id,
                global_object_key=item.global_object_key,
                canonical_name=item.canonical_name,
                surface_atoms=surfaces,
                reference_atoms=references,
                assertions=[dataset.assertions[item_id] for item_id in assertion_ids],
            )
        )
    state = RegistryState(
        source_sha256=dataset.source_sha256,
        source_node_ids=list(dataset.source_node_ids),
        next_source_region_ordinal=next_source_region_ordinal,
        objects=objects,
    )
    _validate_registry_cursor(state, dataset)
    return state


def _validate_registry_cursor(
    state: RegistryState,
    dataset: SourceCompilationDataset,
) -> None:
    processed = dataset.regions[: state.next_source_region_ordinal]
    expected_surfaces = {atom.atom_id for region in processed for atom in region.surface_atoms}
    expected_references = {atom.atom_id for region in processed for atom in region.reference_atoms}
    actual_surfaces = {atom.atom_id for item in state.objects for atom in item.surface_atoms}
    actual_references = {atom.atom_id for item in state.objects for atom in item.reference_atoms}
    if actual_surfaces != expected_surfaces or actual_references != expected_references:
        raise ValueError("Global Registry 当前 atom 归属与 SourceRegion cursor 不一致")


def _validate_source_identity(
    *,
    schema_version: str,
    source_sha256: str,
    source_node_ids: list[str],
    dataset: SourceCompilationDataset,
) -> None:
    if schema_version != dataset.snapshot.schema_version:
        raise ValueError("working.json 与 Source Semantic schema 不一致")
    if source_sha256 != dataset.source_sha256:
        raise ValueError("working.json 与 Source Semantic SHA256 不一致")
    if source_node_ids != list(dataset.source_node_ids):
        raise ValueError("working.json 与 SourceRegion 顺序不一致")


def _find_upward(start: Path, name: str) -> Path:
    for directory in (start, *start.parents):
        candidate = directory / name
        if candidate.is_file():
            return candidate
    raise ValueError(f"从 {start} 向上找不到 {name}")


def _atomic_write(path: Path, content: str) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(path)


def _paths(directory: Path) -> GlobalResolutionPaths:
    return GlobalResolutionPaths(
        directory=directory,
        model_streams=directory / "model-streams",
        working_json=directory / "working.json",
        artifact_json=directory / "global-resolution.json",
    )


__all__ = [
    "GlobalResolutionPaths",
    "SourceCompilationDataset",
    "create_global_resolution_paths",
    "initial_registry",
    "load_source_compilation",
    "load_working_registry",
    "open_global_resolution_paths",
    "rebuild_registry",
    "store_registry",
    "write_final_artifact",
    "write_working_registry",
]
