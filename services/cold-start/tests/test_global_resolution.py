from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pytest

from cold_start.compilation.source_semantics import (
    FullSourceSemanticSnapshot,
    ObjectFragment,
    SourceAssertion,
    SourceSemanticSnapshot,
)
from cold_start.document.models import ParsedBlock
from cold_start.global_exploration.models import SourceMetadata
from cold_start.global_resolution.artifacts import (
    GlobalResolutionPaths,
    SourceCompilationDataset,
    initial_registry,
    load_source_compilation,
    load_working_registry,
    store_registry,
    write_working_registry,
)
from cold_start.global_resolution.finalization import build_global_assertions_artifact
from cold_start.global_resolution.models import (
    ActiveGlobalObject,
    AssertionEvidence,
    ReferenceAtom,
    RegionIntegrationPlan,
    RegionResolutionOperation,
    RegistryState,
    ResolutionGroup,
    ResolutionTarget,
    SourceFragmentDossier,
    SourceRegionDossier,
    SurfaceAtom,
    assertion_key,
    literal_reference_atom_id,
    reference_atom_id,
    source_fragment_key,
    surface_atom_id,
    validate_region_integration_plan,
)
from cold_start.global_resolution.retrieval import (
    GlobalObjectCandidateRetriever,
    lexical_match_kinds,
)
from cold_start.global_resolution.runtime import (
    GlobalObjectResolverRunner,
    apply_region_plan,
)
from cold_start.llm.base import ModelTurn


def assertion(
    source_node_id: str,
    claim_id: str,
    *,
    statement: str = "一条来源命题",
) -> AssertionEvidence:
    return AssertionEvidence(
        assertion_id=assertion_key(source_node_id, claim_id),
        source_node_id=source_node_id,
        source_claim_id=claim_id,
        statement_template_markdown=statement,
        context_dependent=False,
    )


def surface(
    source_node_id: str,
    fragment_id: str,
    ordinal: int,
    value: str,
) -> SurfaceAtom:
    return SurfaceAtom(
        atom_id=surface_atom_id(source_node_id, fragment_id, ordinal),
        source_node_id=source_node_id,
        source_fragment_id=fragment_id,
        ordinal=ordinal,
        surface_form=value,
    )


def reference(
    source_node_id: str,
    claim_id: str,
    fragment_id: str,
    ordinal: int = 0,
) -> ReferenceAtom:
    return ReferenceAtom(
        atom_id=reference_atom_id(source_node_id, claim_id, ordinal),
        source_node_id=source_node_id,
        source_claim_id=claim_id,
        source_fragment_id=fragment_id,
        ordinal=ordinal,
    )


def fragment(
    source_node_id: str,
    fragment_id: str,
    values: list[str],
    *,
    references: list[ReferenceAtom] | None = None,
    assertions: list[AssertionEvidence] | None = None,
) -> SourceFragmentDossier:
    return SourceFragmentDossier(
        source_node_id=source_node_id,
        source_fragment_id=fragment_id,
        surface_atoms=[
            surface(source_node_id, fragment_id, ordinal, value)
            for ordinal, value in enumerate(values)
        ],
        reference_atoms=references or [],
        assertions=assertions or [],
    )


def region(
    source_node_id: str,
    fragments: list[SourceFragmentDossier],
    *,
    assertions: list[AssertionEvidence] | None = None,
) -> SourceRegionDossier:
    return SourceRegionDossier(
        source_node_id=source_node_id,
        region_label="测试区域",
        lineage_node_ids=["region-0000"],
        fragments=fragments,
        assertions=assertions or [],
        context_markdown="测试来源语境",
    )


def global_object(
    object_id: str,
    key: str,
    canonical_name: str,
    surfaces: list[SurfaceAtom],
    *,
    references: list[ReferenceAtom] | None = None,
    assertions: list[AssertionEvidence] | None = None,
) -> ActiveGlobalObject:
    return ActiveGlobalObject(
        global_object_id=object_id,
        global_object_key=key,
        canonical_name=canonical_name,
        identity_summary_markdown=f"来源持续指向{canonical_name}",
        surface_atoms=surfaces,
        reference_atoms=references or [],
        assertions=assertions or [],
    )


def registry(
    source_node_ids: list[str],
    *,
    cursor: int = 0,
    objects: list[ActiveGlobalObject] | None = None,
) -> RegistryState:
    return RegistryState(
        source_sha256="a" * 64,
        source_node_ids=source_node_ids,
        next_source_region_ordinal=cursor,
        objects=objects or [],
    )


def dataset(
    regions: list[SourceRegionDossier],
    assertions: list[AssertionEvidence] | None = None,
    *,
    directory: Path = Path("."),
) -> SourceCompilationDataset:
    all_assertions = assertions or []
    snapshot = cast(
        FullSourceSemanticSnapshot,
        SimpleNamespace(
            schema_version="source-semantics-full.v7",
            source=SimpleNamespace(sha256="a" * 64),
            source_node_ids=[item.source_node_id for item in regions],
        ),
    )
    surfaces = {atom.atom_id: atom for item in regions for atom in item.surface_atoms}
    references = {atom.atom_id: atom for item in regions for atom in item.reference_atoms}
    return SourceCompilationDataset(
        directory=directory,
        snapshot=snapshot,
        regions=tuple(regions),
        assertions={item.assertion_id: item for item in all_assertions},
        surface_atoms=surfaces,
        reference_atoms=references,
    )


async def test_fragment_candidates_are_recalled_without_auto_identity() -> None:
    existing = global_object(
        "global-org",
        "global-000001-01",
        "中国科学技术大学学生乒乓球协会",
        [
            surface("region-0001", "fragment-1", 0, "中国科学技术大学学生乒乓球协会"),
            surface("region-0001", "fragment-1", 1, "USTCTTA"),
        ],
    )
    incoming = fragment("region-0002", "fragment-1", ["USTC TTA", "乒协"])
    state = registry(["region-0001", "region-0002"], cursor=1, objects=[existing])

    candidates = await GlobalObjectCandidateRetriever(embedder=None).retrieve(incoming, state)

    assert candidates == [existing]
    assert "compact_exact" in lexical_match_kinds(incoming, existing)


def test_one_region_plan_can_create_and_attach_together() -> None:
    existing = global_object(
        "global-existing",
        "global-000001-01",
        "乒协",
        [surface("region-0001", "fragment-1", 0, "乒协")],
    )
    first = fragment("region-0002", "fragment-1", ["学生乒协"])
    second = fragment("region-0002", "fragment-2", ["新生赛"])
    incoming = region("region-0002", [first, second])
    state = registry(["region-0001", "region-0002"], cursor=1, objects=[existing])
    plan = RegionIntegrationPlan(
        operations=[
            RegionResolutionOperation(
                action="attach",
                groups=[
                    ResolutionGroup(
                        target=ResolutionTarget(
                            kind="existing",
                            global_object_id=existing.global_object_id,
                        ),
                        surface_atom_ids=[first.surface_atoms[0].atom_id],
                    )
                ],
            ),
            RegionResolutionOperation(
                action="create",
                groups=[
                    ResolutionGroup(
                        target=ResolutionTarget(
                            kind="new",
                            canonical_name="新生赛",
                            identity_summary_markdown="面向新生的比赛。",
                        ),
                        surface_atom_ids=[second.surface_atoms[0].atom_id],
                    )
                ],
            ),
        ]
    )
    validated = validate_region_integration_plan(
        plan,
        incoming=incoming,
        registry=state,
        candidates_by_fragment={
            first.fragment_key: [existing],
            second.fragment_key: [],
        },
    )

    next_state = apply_region_plan(
        plan=validated,
        state=state,
        dataset=dataset([incoming]),
        sequence=1,
    )

    assert next_state.next_source_region_ordinal == 2
    assert {item.canonical_name for item in next_state.objects} == {"乒协", "新生赛"}
    attached = next(
        item for item in next_state.objects if item.global_object_id == "global-existing"
    )
    assert [item.surface_form for item in attached.surface_atoms] == ["乒协", "学生乒协"]


def test_multiple_incoming_fragments_can_form_one_new_object() -> None:
    first = fragment("region-0001", "fragment-1", ["USTC TTA"])
    second = fragment("region-0001", "fragment-2", ["校乒协"])
    incoming = region("region-0001", [first, second])
    plan = RegionIntegrationPlan(
        operations=[
            RegionResolutionOperation(
                action="create",
                groups=[
                    ResolutionGroup(
                        target=ResolutionTarget(
                            kind="new",
                            canonical_name="USTC TTA",
                            identity_summary_markdown="学校学生乒乓球协会。",
                        ),
                        surface_atom_ids=[
                            first.surface_atoms[0].atom_id,
                            second.surface_atoms[0].atom_id,
                        ],
                    )
                ],
            )
        ]
    )
    state = registry(["region-0001"])
    validated = validate_region_integration_plan(
        plan,
        incoming=incoming,
        registry=state,
        candidates_by_fragment={first.fragment_key: [], second.fragment_key: []},
    )

    next_state = apply_region_plan(
        plan=validated,
        state=state,
        dataset=dataset([incoming]),
        sequence=0,
    )
    repeated_state = apply_region_plan(
        plan=validated,
        state=state,
        dataset=dataset([incoming]),
        sequence=0,
    )

    assert len(next_state.objects) == 1
    assert next_state.objects[0].global_object_id == repeated_state.objects[0].global_object_id
    assert {item.surface_form for item in next_state.objects[0].surface_atoms} == {
        "USTC TTA",
        "校乒协",
    }


def test_merge_keeps_earliest_existing_uuid() -> None:
    survivor = global_object(
        "global-first",
        "global-000001-01",
        "继往开来",
        [surface("region-0001", "fragment-1", 0, "继往开来")],
    )
    duplicate = global_object(
        "global-second",
        "global-000002-01",
        "继往开来杯",
        [surface("region-0002", "fragment-1", 0, "继往开来杯")],
    )
    incoming_fragment = fragment("region-0003", "fragment-1", ["继往开来乒乓球赛"])
    incoming = region("region-0003", [incoming_fragment])
    state = registry(
        ["region-0001", "region-0002", "region-0003"],
        cursor=2,
        objects=[survivor, duplicate],
    )
    plan = RegionIntegrationPlan(
        operations=[
            RegionResolutionOperation(
                action="merge",
                source_global_object_ids=[duplicate.global_object_id, survivor.global_object_id],
                groups=[
                    ResolutionGroup(
                        target=ResolutionTarget(
                            kind="existing",
                            global_object_id=survivor.global_object_id,
                        ),
                        surface_atom_ids=[
                            survivor.surface_atoms[0].atom_id,
                            duplicate.surface_atoms[0].atom_id,
                            incoming_fragment.surface_atoms[0].atom_id,
                        ],
                    )
                ],
            )
        ]
    )
    validated = validate_region_integration_plan(
        plan,
        incoming=incoming,
        registry=state,
        candidates_by_fragment={incoming_fragment.fragment_key: [survivor, duplicate]},
    )

    next_state = apply_region_plan(
        plan=validated,
        state=state,
        dataset=dataset([incoming]),
        sequence=2,
    )

    assert [item.global_object_id for item in next_state.objects] == ["global-first"]


def test_split_preserves_original_uuid_and_reference_ownership() -> None:
    approval = assertion(
        "region-0001",
        "claim-1",
        statement="{{fragment:fragment-1}}有固定审核流程。",
    )
    system = assertion(
        "region-0002",
        "claim-1",
        statement="活动在{{fragment:fragment-1}}中提交。",
    )
    existing = global_object(
        "global-mixed",
        "global-000001-01",
        "二课审批",
        [
            surface("region-0001", "fragment-1", 0, "二课审批"),
            surface("region-0001", "fragment-1", 1, "二课系统"),
        ],
        references=[reference("region-0001", "claim-1", "fragment-1")],
        assertions=[approval],
    )
    incoming_reference = reference("region-0002", "claim-1", "fragment-1")
    incoming_fragment = fragment(
        "region-0002",
        "fragment-1",
        ["二课系统"],
        references=[incoming_reference],
        assertions=[system],
    )
    incoming = region("region-0002", [incoming_fragment], assertions=[system])
    state = registry(
        ["region-0001", "region-0002"],
        cursor=1,
        objects=[existing],
    )
    plan = RegionIntegrationPlan(
        operations=[
            RegionResolutionOperation(
                action="split",
                source_global_object_ids=[existing.global_object_id],
                groups=[
                    ResolutionGroup(
                        target=ResolutionTarget(
                            kind="existing",
                            global_object_id=existing.global_object_id,
                        ),
                        surface_atom_ids=[existing.surface_atoms[0].atom_id],
                        reference_atom_ids=[existing.reference_atoms[0].atom_id],
                    ),
                    ResolutionGroup(
                        target=ResolutionTarget(
                            kind="new",
                            canonical_name="二课系统",
                            identity_summary_markdown="提交活动申请的平台。",
                        ),
                        surface_atom_ids=[
                            existing.surface_atoms[1].atom_id,
                            incoming_fragment.surface_atoms[0].atom_id,
                        ],
                        reference_atom_ids=[incoming_reference.atom_id],
                    ),
                ],
            )
        ]
    )
    validated = validate_region_integration_plan(
        plan,
        incoming=incoming,
        registry=state,
        candidates_by_fragment={incoming_fragment.fragment_key: [existing]},
    )
    source_dataset = dataset([incoming], [approval, system])

    next_state = apply_region_plan(
        plan=validated,
        state=state,
        dataset=source_dataset,
        sequence=1,
    )

    assert len(next_state.objects) == 2
    assert "global-mixed" in {item.global_object_id for item in next_state.objects}
    approval_object = next(
        item for item in next_state.objects if item.global_object_id == "global-mixed"
    )
    system_object = next(
        item for item in next_state.objects if item.global_object_id != "global-mixed"
    )
    assert [item.atom_id for item in approval_object.reference_atoms] == [
        existing.reference_atoms[0].atom_id
    ]
    assert [item.atom_id for item in system_object.reference_atoms] == [incoming_reference.atom_id]


def test_region_plan_must_partition_all_incoming_atoms() -> None:
    first = fragment("region-0001", "fragment-1", ["甲"])
    second = fragment("region-0001", "fragment-2", ["乙"])
    incoming = region("region-0001", [first, second])
    plan = RegionIntegrationPlan(
        operations=[
            RegionResolutionOperation(
                action="create",
                groups=[
                    ResolutionGroup(
                        target=ResolutionTarget(
                            kind="new",
                            canonical_name="甲",
                            identity_summary_markdown="甲对象。",
                        ),
                        surface_atom_ids=[first.surface_atoms[0].atom_id],
                    )
                ],
            )
        ]
    )

    with pytest.raises(ValueError, match="Region incoming atoms 必须完整"):
        validate_region_integration_plan(
            plan,
            incoming=incoming,
            registry=registry(["region-0001"]),
            candidates_by_fragment={first.fragment_key: [], second.fragment_key: []},
        )


def test_local_loader_preserves_repeated_reference_ordinals(tmp_path: Path) -> None:
    run_directory = tmp_path / "run"
    compilation_directory = run_directory / "source-semantic-compilations" / "full"
    compilation_directory.mkdir(parents=True)
    block = ParsedBlock(
        block_id="p0001-b0001",
        order=0,
        block_type="paragraph",
        source_pages=(1,),
        markdown="甲协会帮助甲协会。",
    )
    (run_directory / "parsed-blocks.json").write_text(
        json.dumps([block.model_dump(mode="json")], ensure_ascii=False),
        encoding="utf-8",
    )
    metadata = SourceMetadata(
        path="handbook.pdf",
        title="手册",
        sha256="a" * 64,
        parser="test",
        page_count=1,
        block_count=1,
    )
    source = SourceSemanticSnapshot(
        created_at=datetime.now(UTC),
        source=metadata,
        region_tree_schema_version="region-tree.v5",
        region_node_id="region-0001",
        label="组织",
        lineage_node_ids=[],
        source_pages=[1],
        source_block_ids=[block.block_id],
        covered_block_ids=[block.block_id],
        unclaimed_block_ids=[],
        initial_claim_count=1,
        review_addition_count=0,
        assertions=[
            SourceAssertion(
                claim_id="claim-1",
                statement_template_markdown=(
                    "{{fragment:fragment-1}}帮助{{fragment:fragment-1}}。"
                ),
                supporting_block_ids=[block.block_id],
                context_dependent=False,
                temporal_annotations=[],
            )
        ],
        object_fragments=[
            ObjectFragment(
                fragment_id="fragment-1",
                source_region_id="region-0001",
                surface_forms=["甲协会"],
            )
        ],
        model_calls=1,
    )
    snapshot = FullSourceSemanticSnapshot(
        created_at=datetime.now(UTC),
        source=metadata,
        region_tree_schema_version="region-tree.v5",
        source_node_ids=["region-0001"],
        sources=[source],
        total_assertions=1,
        total_object_fragments=1,
        total_surface_forms=1,
        model_calls=1,
    )
    (compilation_directory / "source-semantics-full.json").write_text(
        snapshot.model_dump_json(indent=2),
        encoding="utf-8",
    )

    loaded = load_source_compilation(compilation_directory)

    assert list(loaded.reference_atoms) == [
        reference_atom_id("region-0001", "claim-1", 0),
        reference_atom_id("region-0001", "claim-1", 1),
    ]
    assert len(loaded.regions[0].fragments[0].reference_atoms) == 2


def test_working_registry_round_trip_uses_local_current_state(tmp_path: Path) -> None:
    incoming_fragment = fragment("region-0001", "fragment-1", ["甲协会"])
    incoming = region("region-0001", [incoming_fragment])
    source_dataset = dataset([incoming], directory=tmp_path)
    state = registry(
        ["region-0001"],
        cursor=1,
        objects=[
            global_object(
                "global-1",
                "global-000001-01",
                "甲协会",
                incoming_fragment.surface_atoms,
            )
        ],
    )
    paths = _paths(tmp_path)

    write_working_registry(paths, source_dataset, state)
    rebuilt = load_working_registry(paths, source_dataset)

    assert store_registry(rebuilt) == store_registry(state)
    assert rebuilt.next_source_region_ordinal == 1


def test_global_assertion_finalization_replaces_fragments_and_adds_literal_atoms() -> None:
    evidence = assertion(
        "region-0001",
        "claim-1",
        statement="{{fragment:fragment-1}}通过后在二课系统完成报销。",
    )
    source_reference = reference("region-0001", "claim-1", "fragment-1")
    source_fragment = fragment(
        "region-0001",
        "fragment-1",
        ["二课审批"],
        references=[source_reference],
        assertions=[evidence],
    )
    incoming = region("region-0001", [source_fragment], assertions=[evidence])
    source_dataset = dataset([incoming], [evidence])
    state = registry(
        ["region-0001"],
        cursor=1,
        objects=[
            global_object(
                "global-approval",
                "global-000001-01",
                "二课审批",
                source_fragment.surface_atoms,
                references=[source_reference],
                assertions=[evidence],
            ),
            global_object(
                "global-system",
                "global-000001-02",
                "二课系统",
                [surface("region-0001", "fragment-2", 0, "二课系统")],
            ),
            global_object(
                "global-reimbursement",
                "global-000001-03",
                "报销",
                [surface("region-0001", "fragment-3", 0, "报销")],
            ),
        ],
    )

    artifact = build_global_assertions_artifact(source_dataset, state)

    assert artifact.total_source_reference_atoms == 1
    assert artifact.total_literal_reference_atoms == 2
    finalized = artifact.assertions[0]
    assert finalized.global_statement_template_markdown == (
        "{{object:global-approval}}通过后在{{object:global-system}}"
        "完成{{object:global-reimbursement}}。"
    )
    assert [item.atom_id for item in finalized.reference_atoms] == [
        reference_atom_id("region-0001", "claim-1", 0),
        literal_reference_atom_id("region-0001", "claim-1", 0),
        literal_reference_atom_id("region-0001", "claim-1", 1),
    ]
    assert [item.source_text for item in finalized.reference_atoms] == [
        "{{fragment:fragment-1}}",
        "二课系统",
        "报销",
    ]


def test_global_assertion_literal_matching_is_longest_and_skips_ambiguous_surfaces() -> None:
    evidence = assertion(
        "region-0001",
        "claim-1",
        statement="二课审批单用于积分赛报销。",
    )
    incoming = region("region-0001", [], assertions=[evidence])
    source_dataset = dataset([incoming], [evidence])
    state = registry(
        ["region-0001"],
        cursor=1,
        objects=[
            global_object(
                "global-form",
                "global-000001-01",
                "二课审批单",
                [surface("region-0001", "fragment-1", 0, "二课审批单")],
            ),
            global_object(
                "global-approval",
                "global-000001-02",
                "二课审批",
                [surface("region-0001", "fragment-2", 0, "二课审批")],
            ),
            global_object(
                "global-system",
                "global-000001-03",
                "二课",
                [surface("region-0001", "fragment-3", 0, "二课")],
            ),
            global_object(
                "global-event",
                "global-000001-04",
                "积分赛",
                [surface("region-0001", "fragment-4", 0, "积分赛")],
            ),
            global_object(
                "global-organizer",
                "global-000001-05",
                "积分赛负责人",
                [surface("region-0001", "fragment-5", 0, "积分赛")],
            ),
            global_object(
                "global-reimbursement",
                "global-000001-06",
                "报销",
                [surface("region-0001", "fragment-6", 0, "报销")],
            ),
        ],
    )

    artifact = build_global_assertions_artifact(source_dataset, state)

    finalized = artifact.assertions[0]
    assert finalized.global_statement_template_markdown == (
        "{{object:global-form}}用于积分赛{{object:global-reimbursement}}。"
    )
    assert [item.global_object_id for item in finalized.reference_atoms] == [
        "global-form",
        "global-reimbursement",
    ]
    assert [item.source_text for item in finalized.reference_atoms] == ["二课审批单", "报销"]


@pytest.mark.asyncio
async def test_runner_calls_model_once_for_whole_region_and_skips_empty_region(
    tmp_path: Path,
) -> None:
    first = fragment("region-0001", "fragment-1", ["甲"])
    second = fragment("region-0001", "fragment-2", ["乙"])
    populated = region("region-0001", [first, second])
    empty = region("region-0002", [])
    source_dataset = dataset([populated, empty], directory=tmp_path)
    paths = _paths(tmp_path)
    state = initial_registry(source_dataset)
    write_working_registry(paths, source_dataset, state)

    class FakeModel:
        def __init__(self) -> None:
            self.calls = 0

        async def complete_turn(self, **kwargs: object) -> ModelTurn:
            del kwargs
            self.calls += 1
            plan = RegionIntegrationPlan(
                operations=[
                    RegionResolutionOperation(
                        action="create",
                        groups=[
                            ResolutionGroup(
                                target=ResolutionTarget(
                                    kind="new",
                                    canonical_name="甲",
                                    identity_summary_markdown="甲和乙共同代表的对象。",
                                ),
                                surface_atom_ids=[
                                    first.surface_atoms[0].atom_id,
                                    second.surface_atoms[0].atom_id,
                                ],
                            )
                        ],
                    )
                ]
            )
            return ModelTurn(content=plan.model_dump_json())

    model = FakeModel()
    final_state = await GlobalObjectResolverRunner(
        model=model,
        dataset=source_dataset,
        paths=paths,
        state=state,
        retriever=GlobalObjectCandidateRetriever(embedder=None),
    ).run_all()

    assert model.calls == 1
    assert final_state.next_source_region_ordinal == 2
    assert len(final_state.objects) == 1
    assert paths.artifact_json.is_file()
    assert (paths.directory / "global-assertions.json").is_file()


@pytest.mark.asyncio
async def test_attach_shape_retry_preserves_identity_and_only_repairs_protocol(
    tmp_path: Path,
) -> None:
    prior_fragment = fragment("region-0001", "fragment-1", ["甲协会"])
    prior = region("region-0001", [prior_fragment])
    incoming_fragment = fragment("region-0002", "fragment-1", ["甲协会"])
    incoming = region("region-0002", [incoming_fragment])
    existing = global_object(
        "global-existing",
        "global-000001-01",
        "甲协会",
        prior_fragment.surface_atoms,
    )
    source_dataset = dataset([prior, incoming], directory=tmp_path)
    paths = _paths(tmp_path)
    state = registry(
        ["region-0001", "region-0002"],
        cursor=1,
        objects=[existing],
    )
    write_working_registry(paths, source_dataset, state)

    def attach_plan(*, include_target_as_source: bool) -> RegionIntegrationPlan:
        return RegionIntegrationPlan.model_construct(
            operations=[
                RegionResolutionOperation.model_construct(
                    action="attach",
                    source_global_object_ids=(
                        [existing.global_object_id] if include_target_as_source else []
                    ),
                    groups=[
                        ResolutionGroup(
                            target=ResolutionTarget(
                                kind="existing",
                                global_object_id=existing.global_object_id,
                            ),
                            surface_atom_ids=[incoming_fragment.surface_atoms[0].atom_id],
                        )
                    ],
                )
            ]
        )

    class FakeModel:
        def __init__(self) -> None:
            self.calls: list[list[dict[str, str]]] = []

        async def complete_turn(self, **kwargs: object) -> ModelTurn:
            messages = cast(list[dict[str, str]], kwargs["messages"])
            self.calls.append(messages)
            plan = attach_plan(include_target_as_source=len(self.calls) == 1)
            return ModelTurn(content=plan.model_dump_json())

    model = FakeModel()
    final_state = await GlobalObjectResolverRunner(
        model=model,
        dataset=source_dataset,
        paths=paths,
        state=state,
        retriever=GlobalObjectCandidateRetriever(embedder=None),
    ).run_all()

    assert len(model.calls) == 2
    assert "source_global_object_ids 必须是 []" in model.calls[0][0]["content"]
    retry_messages = model.calls[1]
    assert [item["role"] for item in retry_messages] == [
        "system",
        "user",
        "assistant",
        "user",
    ]
    assert "attach 的 source_global_object_ids 必须为 []" in retry_messages[0][
        "content"
    ]
    assert "identity 判断本身无需改变" in retry_messages[0]["content"]
    assert existing.global_object_id in retry_messages[2]["content"]
    assert "不要重新判断 identity" in retry_messages[3]["content"]
    assert len(final_state.objects) == 1
    assert [atom.surface_form for atom in final_state.objects[0].surface_atoms] == [
        "甲协会",
        "甲协会",
    ]


@pytest.mark.asyncio
async def test_batch_create_retry_splits_groups_without_rejudging_identity(
    tmp_path: Path,
) -> None:
    first = fragment("region-0001", "fragment-1", ["甲"])
    second = fragment("region-0001", "fragment-2", ["乙"])
    incoming = region("region-0001", [first, second])
    source_dataset = dataset([incoming], directory=tmp_path)
    paths = _paths(tmp_path)
    state = initial_registry(source_dataset)
    write_working_registry(paths, source_dataset, state)
    groups = [
        ResolutionGroup(
            target=ResolutionTarget(
                kind="new",
                canonical_name=name,
                identity_summary_markdown=f"{name}对象。",
            ),
            surface_atom_ids=[atom.atom_id],
        )
        for name, atom in [
            ("甲", first.surface_atoms[0]),
            ("乙", second.surface_atoms[0]),
        ]
    ]
    batched = RegionIntegrationPlan.model_construct(
        operations=[
            RegionResolutionOperation.model_construct(
                action="create",
                source_global_object_ids=[],
                groups=groups,
            )
        ]
    )
    repaired = RegionIntegrationPlan(
        operations=[
            RegionResolutionOperation(
                action="create",
                groups=[group],
            )
            for group in groups
        ]
    )

    class FakeModel:
        def __init__(self) -> None:
            self.calls: list[list[dict[str, str]]] = []

        async def complete_turn(self, **kwargs: object) -> ModelTurn:
            messages = cast(list[dict[str, str]], kwargs["messages"])
            self.calls.append(messages)
            plan = batched if len(self.calls) == 1 else repaired
            return ModelTurn(content=plan.model_dump_json())

    model = FakeModel()
    final_state = await GlobalObjectResolverRunner(
        model=model,
        dataset=source_dataset,
        paths=paths,
        state=state,
        retriever=GlobalObjectCandidateRetriever(embedder=None),
    ).run_all()

    assert len(model.calls) == 2
    assert "只有 split operation 可以包含多个 groups" in model.calls[0][0][
        "content"
    ]
    retry_messages = model.calls[1]
    assert [item["role"] for item in retry_messages] == [
        "system",
        "user",
        "assistant",
        "user",
    ]
    assert "必须拆成 2 个独立 create operations" in retry_messages[0]["content"]
    assert batched.model_dump_json() == retry_messages[2]["content"]
    assert "保持每个 group 原有的 identity" in retry_messages[3]["content"]
    assert {item.canonical_name for item in final_state.objects} == {"甲", "乙"}


@pytest.mark.asyncio
async def test_invalid_json_retry_reuses_draft_and_rechecks_single_group_rule(
    tmp_path: Path,
) -> None:
    first = fragment("region-0001", "fragment-1", ["周常训练"])
    second = fragment("region-0001", "fragment-2", ["干事"])
    incoming = region("region-0001", [first, second])
    source_dataset = dataset([incoming], directory=tmp_path)
    paths = _paths(tmp_path)
    state = initial_registry(source_dataset)
    write_working_registry(paths, source_dataset, state)
    groups = [
        ResolutionGroup(
            target=ResolutionTarget(
                kind="new",
                canonical_name="周常训练",
                identity_summary_markdown="周常训练活动。",
            ),
            surface_atom_ids=[first.surface_atoms[0].atom_id],
        ),
        ResolutionGroup(
            target=ResolutionTarget(
                kind="new",
                canonical_name="干事",
                identity_summary_markdown="与干事会不同。",
            ),
            surface_atom_ids=[second.surface_atoms[0].atom_id],
        ),
    ]
    batched = RegionIntegrationPlan.model_construct(
        operations=[
            RegionResolutionOperation.model_construct(
                action="create",
                source_global_object_ids=[],
                groups=groups,
            )
        ]
    )
    invalid_json = batched.model_dump_json().replace(
        "与干事会不同。",
        '与"干事会"不同。',
    )
    repaired = RegionIntegrationPlan(
        operations=[
            RegionResolutionOperation(action="create", groups=[group])
            for group in groups
        ]
    )

    class FakeModel:
        def __init__(self) -> None:
            self.calls: list[list[dict[str, str]]] = []

        async def complete_turn(self, **kwargs: object) -> ModelTurn:
            messages = cast(list[dict[str, str]], kwargs["messages"])
            self.calls.append(messages)
            return ModelTurn(
                content=invalid_json if len(self.calls) == 1 else repaired.model_dump_json()
            )

    model = FakeModel()
    final_state = await GlobalObjectResolverRunner(
        model=model,
        dataset=source_dataset,
        paths=paths,
        state=state,
        retriever=GlobalObjectCandidateRetriever(embedder=None),
    ).run_all()

    assert len(model.calls) == 2
    retry_messages = model.calls[1]
    assert [item["role"] for item in retry_messages] == [
        "system",
        "user",
        "assistant",
        "user",
    ]
    assert "序列化协议错误" in retry_messages[0]["content"]
    assert "只有 split 可以包含多个 groups" in retry_messages[0]["content"]
    assert invalid_json == retry_messages[2]["content"]
    assert "不得使用未转义的 ASCII 双引号" in retry_messages[3]["content"]
    assert "把它们拆成多个独立 operations" in retry_messages[3]["content"]
    assert {item.canonical_name for item in final_state.objects} == {"周常训练", "干事"}


def _paths(directory: Path) -> GlobalResolutionPaths:
    model_streams = directory / "model-streams"
    model_streams.mkdir(exist_ok=True)
    return GlobalResolutionPaths(
        directory=directory,
        model_streams=model_streams,
        working_json=directory / "working.json",
        artifact_json=directory / "global-resolution.json",
    )


def test_source_fragment_keys_are_region_scoped() -> None:
    assert source_fragment_key("region-0001", "fragment-1") != source_fragment_key(
        "region-0002", "fragment-1"
    )
