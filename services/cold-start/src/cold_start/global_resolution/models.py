"""SourceRegion 级 Global Object 对齐协议与当前 Registry 校验。"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, model_validator

ResolutionAction = Literal["create", "attach", "merge", "split"]
ResolutionTargetKind = Literal["existing", "new"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SourceBlockEvidence(StrictModel):
    source_block_id: str = Field(min_length=1)
    markdown: str = Field(min_length=1, max_length=50_000)


class AssertionEvidence(StrictModel):
    assertion_id: str = Field(min_length=1)
    source_node_id: str = Field(min_length=1)
    source_claim_id: str = Field(min_length=1)
    kind: Literal["grounded", "reference"] = "grounded"
    statement_template_markdown: str = Field(min_length=1, max_length=3_000)
    semantic_fragment_ids: list[str] = Field(default_factory=list, max_length=100)
    context_dependent: bool
    supporting_blocks: list[SourceBlockEvidence] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_semantic_links(self) -> AssertionEvidence:
        if len(set(self.semantic_fragment_ids)) != len(self.semantic_fragment_ids):
            raise ValueError("semantic_fragment_ids 不能重复")
        if self.kind == "grounded" and self.semantic_fragment_ids:
            raise ValueError("grounded Assertion 不能使用 semantic Fragment links")
        if self.kind == "reference" and not self.semantic_fragment_ids:
            raise ValueError("Reference Assertion 至少需要一个 semantic Fragment link")
        if self.kind == "reference" and "{{fragment:" in self.statement_template_markdown:
            raise ValueError("Reference Assertion 不能使用 anchored Fragment token")
        return self


class SurfaceAtom(StrictModel):
    atom_id: str = Field(min_length=1)
    source_node_id: str = Field(min_length=1)
    source_fragment_id: str = Field(min_length=1)
    ordinal: int = Field(ge=0)
    surface_form: str = Field(min_length=1, max_length=300)

    @model_validator(mode="after")
    def validate_atom(self) -> SurfaceAtom:
        if self.surface_form != self.surface_form.strip():
            raise ValueError("surface_form 不能有首尾空白")
        expected = surface_atom_id(
            self.source_node_id,
            self.source_fragment_id,
            self.ordinal,
        )
        if self.atom_id != expected:
            raise ValueError(f"SurfaceAtom.atom_id 应为 {expected}")
        return self


class ReferenceAtom(StrictModel):
    atom_id: str = Field(min_length=1)
    source_node_id: str = Field(min_length=1)
    source_claim_id: str = Field(min_length=1)
    source_fragment_id: str = Field(min_length=1)
    ordinal: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_atom(self) -> ReferenceAtom:
        expected = reference_atom_id(
            self.source_node_id,
            self.source_claim_id,
            self.ordinal,
        )
        if self.atom_id != expected:
            raise ValueError(f"ReferenceAtom.atom_id 应为 {expected}")
        return self


class SourceFragmentDossier(StrictModel):
    source_node_id: str = Field(min_length=1)
    source_fragment_id: str = Field(min_length=1)
    surface_atoms: list[SurfaceAtom] = Field(min_length=1)
    reference_atoms: list[ReferenceAtom] = Field(default_factory=list)
    assertions: list[AssertionEvidence] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_dossier(self) -> SourceFragmentDossier:
        if any(
            atom.source_node_id != self.source_node_id
            or atom.source_fragment_id != self.source_fragment_id
            for atom in [*self.surface_atoms, *self.reference_atoms]
        ):
            raise ValueError("Fragment dossier 只能包含自己的 atom")
        if sorted(atom.ordinal for atom in self.surface_atoms) != list(
            range(len(self.surface_atoms))
        ):
            raise ValueError("surface ordinals 必须从 0 连续递增")
        _validate_unique_atoms([*self.surface_atoms, *self.reference_atoms])
        assertion_ids = [item.assertion_id for item in self.assertions]
        if len(set(assertion_ids)) != len(assertion_ids):
            raise ValueError("Fragment dossier 不能重复 AssertionEvidence")
        if {
            assertion_key(atom.source_node_id, atom.source_claim_id)
            for atom in self.reference_atoms
        } - set(assertion_ids):
            raise ValueError("reference atom 缺少 AssertionEvidence")
        return self

    @property
    def fragment_key(self) -> str:
        return source_fragment_key(self.source_node_id, self.source_fragment_id)

    @property
    def atom_ids(self) -> tuple[str, ...]:
        return tuple(item.atom_id for item in [*self.surface_atoms, *self.reference_atoms])


class SourceRegionDossier(StrictModel):
    source_node_id: str = Field(min_length=1)
    region_label: str = Field(min_length=1, max_length=500)
    lineage_node_ids: list[str] = Field(default_factory=list)
    fragments: list[SourceFragmentDossier] = Field(default_factory=list)
    assertions: list[AssertionEvidence] = Field(default_factory=list)
    context_markdown: str = Field(default="", max_length=200_000)

    @model_validator(mode="after")
    def validate_region(self) -> SourceRegionDossier:
        if any(item.source_node_id != self.source_node_id for item in self.fragments):
            raise ValueError("Region dossier 只能包含当前 SourceRegion 的 Fragment")
        fragment_keys = [item.fragment_key for item in self.fragments]
        if len(set(fragment_keys)) != len(fragment_keys):
            raise ValueError("Region dossier 不能重复 Fragment")
        assertion_ids = [item.assertion_id for item in self.assertions]
        if len(set(assertion_ids)) != len(assertion_ids):
            raise ValueError("Region dossier 不能重复 Assertion")
        _validate_unique_atoms(
            [atom for fragment in self.fragments for atom in fragment.surface_atoms]
            + [atom for fragment in self.fragments for atom in fragment.reference_atoms]
        )
        expected_assertions = set(assertion_ids)
        for fragment in self.fragments:
            if {item.assertion_id for item in fragment.assertions} - expected_assertions:
                raise ValueError("Fragment dossier 引用了 Region 之外的 Assertion")
        return self

    @property
    def surface_atoms(self) -> tuple[SurfaceAtom, ...]:
        return tuple(atom for fragment in self.fragments for atom in fragment.surface_atoms)

    @property
    def reference_atoms(self) -> tuple[ReferenceAtom, ...]:
        return tuple(atom for fragment in self.fragments for atom in fragment.reference_atoms)

    @property
    def atom_ids(self) -> tuple[str, ...]:
        return tuple(item.atom_id for item in [*self.surface_atoms, *self.reference_atoms])


class ActiveGlobalObject(StrictModel):
    global_object_id: str = Field(min_length=1)
    global_object_key: str = Field(min_length=1)
    canonical_name: str = Field(min_length=1, max_length=300)
    surface_atoms: list[SurfaceAtom] = Field(default_factory=list)
    reference_atoms: list[ReferenceAtom] = Field(default_factory=list)
    assertions: list[AssertionEvidence] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_object(self) -> ActiveGlobalObject:
        _validate_unique_atoms([*self.surface_atoms, *self.reference_atoms])
        assertion_ids = [item.assertion_id for item in self.assertions]
        if len(set(assertion_ids)) != len(assertion_ids):
            raise ValueError("Global Object 不能重复 AssertionEvidence")
        if {
            assertion_key(atom.source_node_id, atom.source_claim_id)
            for atom in self.reference_atoms
        } - set(assertion_ids):
            raise ValueError("Global Object reference atom 缺少 AssertionEvidence")
        return self

    @property
    def atom_ids(self) -> tuple[str, ...]:
        return tuple(item.atom_id for item in [*self.surface_atoms, *self.reference_atoms])


class StoredGlobalObject(StrictModel):
    global_object_id: str = Field(min_length=1)
    global_object_key: str = Field(min_length=1)
    canonical_name: str = Field(min_length=1, max_length=300)
    surface_atom_ids: list[str] = Field(default_factory=list)
    reference_atom_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_assignments(self) -> StoredGlobalObject:
        if len(set(self.surface_atom_ids)) != len(self.surface_atom_ids):
            raise ValueError("Stored Global Object 不能重复 surface atom")
        if len(set(self.reference_atom_ids)) != len(self.reference_atom_ids):
            raise ValueError("Stored Global Object 不能重复 reference atom")
        if any(not item.startswith("surface:") for item in self.surface_atom_ids):
            raise ValueError("surface_atom_ids 只能包含 surface atom")
        if any(not item.startswith("reference:") for item in self.reference_atom_ids):
            raise ValueError("reference_atom_ids 只能包含 reference atom")
        return self


class RegistryState(StrictModel):
    source_sha256: str = Field(min_length=1)
    source_node_ids: list[str]
    next_source_region_ordinal: int = Field(default=0, ge=0)
    objects: list[ActiveGlobalObject] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_registry(self) -> RegistryState:
        if self.next_source_region_ordinal > len(self.source_node_ids):
            raise ValueError("Registry cursor 超出 SourceRegion 数量")
        ids = [item.global_object_id for item in self.objects]
        keys = [item.global_object_key for item in self.objects]
        if len(set(ids)) != len(ids) or len(set(keys)) != len(keys):
            raise ValueError("Registry 不能重复 Global Object ID 或 key")
        owners: dict[str, str] = {}
        for item in self.objects:
            for atom_id in item.atom_ids:
                previous = owners.setdefault(atom_id, item.global_object_id)
                if previous != item.global_object_id:
                    raise ValueError(f"atom {atom_id} 同时属于两个 Global Object")
        return self

    def object_by_id(self) -> dict[str, ActiveGlobalObject]:
        return {item.global_object_id: item for item in self.objects}


class GlobalResolutionWorking(StrictModel):
    schema_version: Literal["global-resolution-working.v3"] = "global-resolution-working.v3"
    source_semantics_schema_version: Literal["source-semantics-full.v9"]
    source_sha256: str = Field(min_length=1)
    source_node_ids: list[str]
    next_source_region_ordinal: int = Field(ge=0)
    global_objects: list[StoredGlobalObject]


class GlobalResolutionArtifact(StrictModel):
    schema_version: Literal["global-resolution.v3"] = "global-resolution.v3"
    created_at: datetime
    source_semantics_schema_version: Literal["source-semantics-full.v9"]
    source_sha256: str = Field(min_length=1)
    source_node_ids: list[str]
    source_region_count: int = Field(ge=0)
    global_objects: list[StoredGlobalObject]
    total_surface_atoms: int = Field(ge=0)
    total_reference_atoms: int = Field(ge=0)


class GlobalAssertionReferenceAtom(StrictModel):
    atom_id: str = Field(min_length=1)
    ordinal: int = Field(ge=0)
    global_object_id: str = Field(min_length=1)
    source_start: int = Field(ge=0)
    source_end: int = Field(gt=0)
    source_text: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_span(self) -> GlobalAssertionReferenceAtom:
        if self.source_end <= self.source_start:
            raise ValueError("Global Assertion reference span 必须非空")
        if not self.atom_id.startswith("reference:"):
            raise ValueError("Global Assertion reference 必须使用 reference atom ID")
        return self


class GlobalizedAssertion(StrictModel):
    assertion_id: str = Field(min_length=1)
    kind: Literal["grounded", "reference"] = "grounded"
    global_statement_template_markdown: str = Field(min_length=1, max_length=10_000)
    reference_atoms: list[GlobalAssertionReferenceAtom] = Field(default_factory=list)
    linked_global_object_ids: list[str] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def validate_references(self) -> GlobalizedAssertion:
        if [item.ordinal for item in self.reference_atoms] != list(
            range(len(self.reference_atoms))
        ):
            raise ValueError("Global Assertion reference ordinals 必须从 0 连续递增")
        _validate_unique_atom_ids([item.atom_id for item in self.reference_atoms])
        if len(set(self.linked_global_object_ids)) != len(
            self.linked_global_object_ids
        ):
            raise ValueError("linked_global_object_ids 不能重复")
        if self.kind == "grounded" and self.linked_global_object_ids:
            raise ValueError("grounded Assertion 不能使用 semantic Object links")
        if self.kind == "reference" and not self.linked_global_object_ids:
            raise ValueError("Reference Assertion 至少需要一个 semantic Object link")
        if self.kind == "reference" and self.reference_atoms:
            raise ValueError("Reference Assertion 不能使用 anchored reference atoms")
        return self


class GlobalAssertionsArtifact(StrictModel):
    schema_version: Literal["global-assertions.v3"] = "global-assertions.v3"
    created_at: datetime
    source_semantics_schema_version: Literal["source-semantics-full.v9"]
    global_resolution_schema_version: Literal["global-resolution.v3"]
    source_sha256: str = Field(min_length=1)
    source_node_ids: list[str]
    assertions: list[GlobalizedAssertion]
    total_assertions: int = Field(ge=0)
    total_source_reference_atoms: int = Field(ge=0)
    total_literal_reference_atoms: int = Field(ge=0)
    total_reference_atoms: int = Field(ge=0)
    total_semantic_object_links: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_totals(self) -> GlobalAssertionsArtifact:
        assertion_ids = [item.assertion_id for item in self.assertions]
        if len(set(assertion_ids)) != len(assertion_ids):
            raise ValueError("Global Assertions 不能重复 assertion_id")
        if self.total_assertions != len(self.assertions):
            raise ValueError("Global Assertions total_assertions 不一致")
        actual_references = sum(len(item.reference_atoms) for item in self.assertions)
        if self.total_reference_atoms != actual_references:
            raise ValueError("Global Assertions total_reference_atoms 不一致")
        if (
            self.total_source_reference_atoms + self.total_literal_reference_atoms
            != self.total_reference_atoms
        ):
            raise ValueError("Global Assertions reference atom 分类 totals 不一致")
        actual_semantic_links = sum(
            len(item.linked_global_object_ids) for item in self.assertions
        )
        if self.total_semantic_object_links != actual_semantic_links:
            raise ValueError("Global Assertions total_semantic_object_links 不一致")
        return self


class ResolutionTarget(StrictModel):
    kind: ResolutionTargetKind
    global_object_id: str | None = Field(default=None, min_length=1)
    canonical_name: str | None = Field(default=None, min_length=1, max_length=300)

    @model_validator(mode="after")
    def validate_target(self) -> ResolutionTarget:
        if self.kind == "new":
            if self.global_object_id is not None:
                raise ValueError("new target 不得预先提供 global_object_id")
            if self.canonical_name is None:
                raise ValueError("new target 必须提供 canonical_name")
        else:
            if self.global_object_id is None:
                raise ValueError("existing target 必须提供 global_object_id")
            if self.canonical_name is not None:
                raise ValueError("existing target 保留当前 canonical name")
        return self


class ResolutionGroup(StrictModel):
    target: ResolutionTarget
    surface_atom_ids: list[str] = Field(default_factory=list)
    reference_atom_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_group(self) -> ResolutionGroup:
        if not self.surface_atom_ids and not self.reference_atom_ids:
            raise ValueError("group 至少包含一个 atom")
        if len(set(self.surface_atom_ids)) != len(self.surface_atom_ids):
            raise ValueError("group 不能重复 surface atom")
        if len(set(self.reference_atom_ids)) != len(self.reference_atom_ids):
            raise ValueError("group 不能重复 reference atom")
        if any(not item.startswith("surface:") for item in self.surface_atom_ids):
            raise ValueError("surface_atom_ids 只能包含 surface atom")
        if any(not item.startswith("reference:") for item in self.reference_atom_ids):
            raise ValueError("reference_atom_ids 只能包含 reference atom")
        return self

    @property
    def atom_ids(self) -> tuple[str, ...]:
        return tuple([*self.surface_atom_ids, *self.reference_atom_ids])


class RegionResolutionOperation(StrictModel):
    action: ResolutionAction
    source_global_object_ids: list[str] = Field(default_factory=list)
    groups: list[ResolutionGroup] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_action_shape(self) -> RegionResolutionOperation:
        if len(set(self.source_global_object_ids)) != len(self.source_global_object_ids):
            raise ValueError("source Global Object IDs 不能重复")
        existing_targets = [
            item.target.global_object_id for item in self.groups if item.target.kind == "existing"
        ]
        if len(set(existing_targets)) != len(existing_targets):
            raise ValueError("同一 operation 的 existing target 不能重复")
        if self.action == "create":
            valid = (
                not self.source_global_object_ids
                and len(self.groups) == 1
                and self.groups[0].target.kind == "new"
            )
        elif self.action == "attach":
            valid = (
                not self.source_global_object_ids
                and len(self.groups) == 1
                and self.groups[0].target.kind == "existing"
            )
        elif self.action == "merge":
            target_id = self.groups[0].target.global_object_id
            valid = (
                len(self.source_global_object_ids) >= 2
                and len(self.groups) == 1
                and self.groups[0].target.kind == "existing"
                and target_id in self.source_global_object_ids
            )
        else:
            surviving_sources = set(self.source_global_object_ids) & {
                item for item in existing_targets if item is not None
            }
            valid = (
                len(self.groups) >= 2
                and len(self.source_global_object_ids) <= 1
                and (not self.source_global_object_ids or len(surviving_sources) == 1)
            )
        if not valid:
            raise ValueError(f"{self.action} 的 source/group/target 结构不合法")
        return self


class RegionIntegrationPlan(StrictModel):
    operations: list[RegionResolutionOperation] = Field(min_length=1)


class ValidatedResolutionGroup(StrictModel):
    target: ResolutionTarget
    existing_target: ActiveGlobalObject | None
    surface_atoms: list[SurfaceAtom]
    reference_atoms: list[ReferenceAtom]


class ValidatedRegionOperation(StrictModel):
    action: ResolutionAction
    source_objects: list[ActiveGlobalObject]
    groups: list[ValidatedResolutionGroup]


class ValidatedRegionPlan(StrictModel):
    plan: RegionIntegrationPlan
    incoming: SourceRegionDossier
    operations: list[ValidatedRegionOperation]


def validate_region_integration_plan(
    plan: RegionIntegrationPlan,
    *,
    incoming: SourceRegionDossier,
    registry: RegistryState,
    candidates_by_fragment: Mapping[str, Sequence[ActiveGlobalObject]],
) -> ValidatedRegionPlan:
    registry_by_id = registry.object_by_id()
    incoming_ids = set(incoming.atom_ids)
    if {atom for obj in registry.objects for atom in obj.atom_ids} & incoming_ids:
        raise ValueError("incoming SourceRegion 已经解析")

    expected_fragment_keys = {item.fragment_key for item in incoming.fragments}
    if set(candidates_by_fragment) != expected_fragment_keys:
        raise ValueError("candidate mapping 必须覆盖当前 Region 的全部 Fragment")
    candidate_by_id: dict[str, ActiveGlobalObject] = {}
    for candidates in candidates_by_fragment.values():
        for candidate in candidates:
            if registry_by_id.get(candidate.global_object_id) != candidate:
                raise ValueError("候选与当前 Registry 不一致")
            candidate_by_id[candidate.global_object_id] = candidate

    referenced_existing: list[str] = []
    source_owner: dict[str, int] = {}
    incoming_usage: list[str] = []
    operations: list[ValidatedRegionOperation] = []
    for operation_index, operation in enumerate(plan.operations):
        existing_target_ids = [
            group.target.global_object_id
            for group in operation.groups
            if group.target.kind == "existing" and group.target.global_object_id is not None
        ]
        referenced = set(operation.source_global_object_ids) | set(existing_target_ids)
        if referenced - set(candidate_by_id):
            raise ValueError("integration plan 引用了本 Region 未召回的 Global Object")
        referenced_existing.extend(existing_target_ids)
        for source_id in operation.source_global_object_ids:
            if source_id in source_owner:
                raise ValueError("同一个 source Global Object 不能被多个 operation 修改")
            source_owner[source_id] = operation_index
        source_objects = [registry_by_id[item] for item in operation.source_global_object_ids]
        if operation.action == "merge":
            survivor = min(source_objects, key=lambda item: item.global_object_key)
            if operation.groups[0].target.global_object_id != survivor.global_object_id:
                raise ValueError("merge 必须保留 source 中 global_object_key 最早的 UUID")

        operation_surface_atoms = [
            *incoming.surface_atoms,
            *(atom for item in source_objects for atom in item.surface_atoms),
        ]
        operation_reference_atoms = [
            *incoming.reference_atoms,
            *(atom for item in source_objects for atom in item.reference_atoms),
        ]
        surface_by_id = _atom_map(operation_surface_atoms, "surface")
        reference_by_id = _atom_map(operation_reference_atoms, "reference")
        source_atom_ids = {atom for item in source_objects for atom in item.atom_ids}
        actual_ids = [atom for group in operation.groups for atom in group.atom_ids]
        if len(set(actual_ids)) != len(actual_ids):
            raise ValueError("同一 operation 不能重复分配 atom")
        if set(actual_ids) - incoming_ids - source_atom_ids:
            raise ValueError("operation 包含不属于 incoming/source 的 atom")
        if source_atom_ids - set(actual_ids):
            raise ValueError("source Global Object 的 atom 必须完整分区")
        operation_incoming = set(actual_ids) & incoming_ids
        if not operation_incoming:
            raise ValueError("每个 operation 必须由当前 Region 的 incoming atom 触发")
        incoming_usage.extend(operation_incoming)

        source_ids = set(operation.source_global_object_ids)
        groups = []
        for group in operation.groups:
            existing = (
                registry_by_id[group.target.global_object_id]
                if group.target.kind == "existing" and group.target.global_object_id is not None
                else None
            )
            group_surfaces = [surface_by_id[item] for item in group.surface_atom_ids]
            observed = {item.surface_form for item in group_surfaces}
            if group.target.kind == "new":
                if not group_surfaces:
                    raise ValueError("new target 必须拥有 surface atom")
                if group.target.canonical_name not in observed:
                    raise ValueError("new target canonical_name 必须来自本组 surface forms")
            if existing is not None and existing.global_object_id in source_ids:
                if existing.canonical_name not in observed:
                    raise ValueError("split/merge 保留 UUID 的组必须保留原 canonical surface")
            groups.append(
                ValidatedResolutionGroup(
                    target=group.target,
                    existing_target=existing,
                    surface_atoms=group_surfaces,
                    reference_atoms=[reference_by_id[item] for item in group.reference_atom_ids],
                )
            )
        operations.append(
            ValidatedRegionOperation(
                action=operation.action,
                source_objects=source_objects,
                groups=groups,
            )
        )

    _validate_partition(incoming_usage, incoming_ids, "Region incoming atoms")
    if len(set(referenced_existing)) != len(referenced_existing):
        raise ValueError("同一个 existing target 不能出现在多个 operation")
    if set(referenced_existing) & set(source_owner) != {
        source_id
        for operation in plan.operations
        for source_id in operation.source_global_object_ids
        if source_id
        in {
            group.target.global_object_id
            for group in operation.groups
            if group.target.kind == "existing"
        }
    }:
        raise ValueError("source Global Object 不能被其他 operation 同时作为 target")
    return ValidatedRegionPlan(plan=plan, incoming=incoming, operations=operations)


def source_fragment_key(source_node_id: str, source_fragment_id: str) -> str:
    return f"fragment:{source_node_id}:{source_fragment_id}"


def assertion_key(source_node_id: str, source_claim_id: str) -> str:
    return f"assertion:{source_node_id}:{source_claim_id}"


def surface_atom_id(source_node_id: str, source_fragment_id: str, ordinal: int) -> str:
    return f"surface:{source_node_id}:{source_fragment_id}:{ordinal}"


def reference_atom_id(source_node_id: str, source_claim_id: str, ordinal: int) -> str:
    return f"reference:{source_node_id}:{source_claim_id}:{ordinal}"


def literal_reference_atom_id(
    source_node_id: str,
    source_claim_id: str,
    ordinal: int,
) -> str:
    return f"reference:{source_node_id}:{source_claim_id}:literal:{ordinal}"


AtomT = TypeVar("AtomT", SurfaceAtom, ReferenceAtom)


def _validate_unique_atoms(atoms: Sequence[SurfaceAtom | ReferenceAtom]) -> None:
    if len({item.atom_id for item in atoms}) != len(atoms):
        raise ValueError("atom_id 不能重复")


def _validate_unique_atom_ids(atom_ids: Sequence[str]) -> None:
    if len(set(atom_ids)) != len(atom_ids):
        raise ValueError("atom_id 不能重复")


def _atom_map(atoms: Sequence[AtomT], label: str) -> dict[str, AtomT]:
    result = {item.atom_id: item for item in atoms}
    if len(result) != len(atoms):
        raise ValueError(f"{label} 中存在重复 atom")
    return result


def _validate_partition(actual: Sequence[str], expected: set[str], label: str) -> None:
    if len(set(actual)) != len(actual) or set(actual) != expected:
        raise ValueError(f"{label} 必须完整且互斥地分区")


__all__ = [
    "ActiveGlobalObject",
    "AssertionEvidence",
    "GlobalAssertionReferenceAtom",
    "GlobalAssertionsArtifact",
    "GlobalResolutionArtifact",
    "GlobalResolutionWorking",
    "GlobalizedAssertion",
    "ReferenceAtom",
    "RegionIntegrationPlan",
    "RegionResolutionOperation",
    "RegistryState",
    "ResolutionAction",
    "ResolutionGroup",
    "ResolutionTarget",
    "ResolutionTargetKind",
    "SourceBlockEvidence",
    "SourceFragmentDossier",
    "SourceRegionDossier",
    "StoredGlobalObject",
    "SurfaceAtom",
    "ValidatedRegionOperation",
    "ValidatedRegionPlan",
    "ValidatedResolutionGroup",
    "assertion_key",
    "literal_reference_atom_id",
    "reference_atom_id",
    "source_fragment_key",
    "surface_atom_id",
    "validate_region_integration_plan",
]
