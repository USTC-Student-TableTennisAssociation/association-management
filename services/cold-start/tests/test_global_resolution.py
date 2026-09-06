from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

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
from cold_start.global_resolution.finalization import (
    build_global_assertions_artifact,
    resolve_ambiguous_literal_senses,
)
from cold_start.global_resolution.models import (
    ActiveGlobalObject,
    AssertionEvidence,
    FragmentDisposition,
    FragmentIdentityDecision,
    ObjectAdmissionDecision,
    ReferenceAtom,
    RegionIntegrationPlan,
    RegionResolutionOperation,
    RegistryState,
    ResolutionGroup,
    ResolutionTarget,
    SourceBlockEvidence,
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
from cold_start.global_resolution.prompts import (
    GLOBAL_IDENTITY_SYSTEM_PROMPT,
    fragment_identity_system_prompt,
)
from cold_start.global_resolution.retrieval import (
    GlobalObjectCandidateRetriever,
    lexical_match_kinds,
)
from cold_start.global_resolution.runtime import (
    GlobalObjectResolverRunner,
    apply_region_plan,
    candidate_prompt_payload,
    candidate_summary_prompt_payload,
    source_fragment_usage_payload,
)
from cold_start.llm.base import ModelTurn, ToolCall


def assertion(
    source_node_id: str,
    claim_id: str,
    *,
    statement: str = "一条来源命题",
    kind: str = "grounded",
    semantic_fragment_ids: list[str] | None = None,
    supporting_blocks: list[SourceBlockEvidence] | None = None,
) -> AssertionEvidence:
    return AssertionEvidence(
        assertion_id=assertion_key(source_node_id, claim_id),
        source_node_id=source_node_id,
        source_claim_id=claim_id,
        kind=kind,
        statement_template_markdown=statement,
        semantic_fragment_ids=semantic_fragment_ids or [],
        context_dependent=False,
        supporting_blocks=supporting_blocks or [],
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
    identity_mode_hint: str = "named_entity",
    references: list[ReferenceAtom] | None = None,
    assertions: list[AssertionEvidence] | None = None,
) -> SourceFragmentDossier:
    return SourceFragmentDossier(
        source_node_id=source_node_id,
        source_fragment_id=fragment_id,
        identity_mode_hint=identity_mode_hint,
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
            schema_version="source-semantics-full.v10",
            policy_version="source-semantics-policy.v5",
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


def test_person_identity_prompt_requires_direct_evidence() -> None:
    person_prompt = fragment_identity_system_prompt("named_person")
    role_prompt = fragment_identity_system_prompt("role_type")

    assert "attach 需要明确名称映射" in person_prompt
    assert "不要求人物身份凭据" in role_prompt
    assert "明确名称映射" not in role_prompt
    assert "identity_mode_hint" in GLOBAL_IDENTITY_SYSTEM_PROMPT
    assert "该提示本身不证明它是类别" in fragment_identity_system_prompt("entity_type")
    assert "上游无法确定身份模式" in fragment_identity_system_prompt("undetermined")


def test_fragment_identity_decision_requires_objecthood_to_match_action() -> None:
    accepted = FragmentIdentityDecision(
        fragment_key="fragment:region-0001:fragment-1",
        objecthood="accepted",
        action="create",
        canonical_name="远航计划",
        reason="具有跨命题身份",
    )
    assert accepted.objecthood == "accepted"
    with pytest.raises(ValueError, match="objecthood=rejected"):
        FragmentIdentityDecision(
            fragment_key="fragment:region-0001:fragment-1",
            objecthood="accepted",
            action="reject",
            reason="只是属性",
        )


def test_source_usage_evidence_is_complete_but_not_a_decision_threshold() -> None:
    candidate = fragment("region-0001", "fragment-1", ["远航计划"])
    first = region("region-0001", [candidate]).model_copy(
        update={"context_markdown": "远航计划已启动。"}
    )
    second = region("region-0002", []).model_copy(
        update={"context_markdown": "复盘记录显示，远航计划完成了第一阶段。"}
    )

    evidence = source_fragment_usage_payload(
        dataset([first, second]),
        candidate,
        current_source_node_id=first.source_node_id,
    )

    assert evidence["scope"] == "current_source_all_regions"
    assert evidence["coverage"] == "complete"
    assert evidence["exact_occurrences"] == [
        {"surface_form": "远航计划", "occurrence_count": 2, "region_count": 2}
    ]
    assert evidence["representative_contexts"][0]["source_node_id"] == "region-0002"
    assert "不等于" in evidence["interpretation_boundary"]


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


def test_region_plan_can_reject_fragment_without_deleting_assertion() -> None:
    evidence = assertion(
        "region-0001",
        "claim-1",
        statement="{{fragment:fragment-1}}是本材料的宽泛主题。",
    )
    source_reference = reference("region-0001", "claim-1", "fragment-1")
    candidate = fragment(
        "region-0001",
        "fragment-1",
        ["乒乓球"],
        references=[source_reference],
        assertions=[evidence],
    )
    incoming = region("region-0001", [candidate], assertions=[evidence])
    source_dataset = dataset([incoming], [evidence])
    plan = RegionIntegrationPlan(
        dispositions=[
            FragmentDisposition(
                action="reject",
                fragment_keys=[candidate.fragment_key],
                reason="只是宽泛主题，不形成独立 referent",
            )
        ]
    )
    state = registry(["region-0001"])
    validated = validate_region_integration_plan(
        plan,
        incoming=incoming,
        registry=state,
        candidates_by_fragment={candidate.fragment_key: []},
    )

    next_state = apply_region_plan(
        plan=validated,
        state=state,
        dataset=source_dataset,
        sequence=0,
    )
    artifact = build_global_assertions_artifact(source_dataset, next_state)

    assert next_state.objects == []
    assert next_state.rejected_fragment_keys == [candidate.fragment_key]
    assert artifact.assertions[0].global_statement_template_markdown == (
        "乒乓球是本材料的宽泛主题。"
    )
    assert artifact.assertions[0].reference_atoms == []


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
        policy_version="source-semantics-policy.v5",
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
            )
        ],
        object_fragments=[
            ObjectFragment(
                fragment_id="fragment-1",
                source_region_id="region-0001",
                surface_forms=["甲协会"],
                identity_mode_hint="named_entity",
            )
        ],
        model_calls=1,
    )
    snapshot = FullSourceSemanticSnapshot(
        policy_version="source-semantics-policy.v5",
        created_at=datetime.now(UTC),
        source=metadata,
        source_time_text=None,
        source_time_supporting_block_ids=[],
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

    progress_path = compilation_directory / "source-semantics-progress.json"
    progress_path.write_text(
        snapshot.model_copy(
            update={"source_node_ids": ["region-0001", "region-0002"]}
        ).model_dump_json(indent=2),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="sources 顺序"):
        load_source_compilation(progress_path)
    partial = load_source_compilation(progress_path, allow_partial=True)
    assert partial.source_node_ids == ("region-0001", "region-0002")
    assert [item.source_node_id for item in partial.regions] == ["region-0001"]

    legacy = json.loads(
        (compilation_directory / "source-semantics-full.json").read_text(encoding="utf-8")
    )
    legacy.pop("policy_version")
    legacy_path = compilation_directory / "legacy-source-semantics-full.json"
    legacy_path.write_text(json.dumps(legacy), encoding="utf-8")
    with pytest.raises(ValueError, match="缺失的编译策略版本"):
        load_source_compilation(legacy_path)


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
    working_json = json.loads(paths.working_json.read_text(encoding="utf-8"))
    assert working_json["schema_version"] == "global-resolution-working.v6"
    assert working_json["resolution_policy_version"] == "global-resolution-policy.v2"
    rebuilt = load_working_registry(paths, source_dataset)

    assert store_registry(rebuilt) == store_registry(state)
    assert rebuilt.next_source_region_ordinal == 1

    working_json["resolution_policy_version"] = "global-resolution-policy.previous"
    paths.working_json.write_text(json.dumps(working_json), encoding="utf-8")
    with pytest.raises(ValueError):
        load_working_registry(paths, source_dataset)


@pytest.mark.asyncio
async def test_progressive_resolution_checkpoints_prefix_without_finalizing(
    tmp_path: Path,
) -> None:
    first = region("region-0001", [])
    second = region("region-0002", [])
    partial = dataset([first], directory=tmp_path)
    partial.snapshot.source_node_ids = ["region-0001", "region-0002"]
    paths = _paths(tmp_path)
    state = initial_registry(partial)
    write_working_registry(paths, partial, state)

    class NoCallModel:
        async def complete_turn(self, **kwargs: object) -> ModelTurn:
            del kwargs
            raise AssertionError("空 Fragment SourceRegion 不应调用模型")

    state = await GlobalObjectResolverRunner(
        model=NoCallModel(),
        dataset=partial,
        paths=paths,
        state=state,
        retriever=GlobalObjectCandidateRetriever(embedder=None),
    ).run_all(final=False)

    assert state.next_source_region_ordinal == 1
    assert not paths.artifact_json.exists()
    assert not (paths.directory / "global-assertions.json").exists()

    complete = dataset([first, second], directory=tmp_path)
    resumed = load_working_registry(paths, complete)
    completed = await GlobalObjectResolverRunner(
        model=NoCallModel(),
        dataset=complete,
        paths=paths,
        state=resumed,
        retriever=GlobalObjectCandidateRetriever(embedder=None),
    ).run_all()

    assert completed.next_source_region_ordinal == 2
    assert paths.artifact_json.exists()
    assert (paths.directory / "global-assertions.json").exists()


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


def test_case_c_reference_finalization_links_five_objects_without_span_replacement() -> None:
    event_names = ["继往开来", "四国大战", "萍水相逢", "会员大赛", "院系杯"]
    source_fragments = [
        fragment("region-0001", f"fragment-{index}", [name])
        for index, name in enumerate(event_names, start=1)
    ]
    reference_evidence = assertion(
        "region-0001",
        "claim-1",
        kind="reference",
        statement="乒协主要品牌赛事的名称、比赛形式和基本定位集中记录于“品牌活动”表格。",
        semantic_fragment_ids=[item.source_fragment_id for item in source_fragments],
        supporting_blocks=[
            SourceBlockEvidence(
                source_block_id="p0010-b0004",
                markdown="品牌活动表格原文",
            )
        ],
    )
    incoming = region(
        "region-0001",
        source_fragments,
        assertions=[reference_evidence],
    )
    source_dataset = dataset([incoming], [reference_evidence])
    state = registry(
        ["region-0001"],
        cursor=1,
        objects=[
            global_object(
                f"global-event-{index}",
                f"global-000001-{index:02d}",
                name,
                source_fragment.surface_atoms,
            )
            for index, (name, source_fragment) in enumerate(
                zip(event_names, source_fragments, strict=True),
                start=1,
            )
        ],
    )

    artifact = build_global_assertions_artifact(source_dataset, state)
    finalized = artifact.assertions[0]

    assert finalized.kind == "reference"
    assert (
        finalized.global_statement_template_markdown
        == reference_evidence.statement_template_markdown
    )
    assert all(name not in finalized.global_statement_template_markdown for name in event_names)
    assert finalized.reference_atoms == []
    assert finalized.linked_global_object_ids == [f"global-event-{index}" for index in range(1, 6)]
    assert artifact.total_reference_atoms == 0
    assert artifact.total_semantic_object_links == 5
    assert reference_evidence.supporting_blocks[0].source_block_id == "p0010-b0004"


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
async def test_ambiguous_literal_sense_is_routed_in_one_batch_and_checkpointed(
    tmp_path: Path,
) -> None:
    mention = assertion(
        "region-0001",
        "claim-1",
        statement="每桌发放乒乓球2个。",
        supporting_blocks=[
            SourceBlockEvidence(
                source_block_id="p0001-b0001",
                markdown="器材清单：每张球桌发放乒乓球2个。",
            )
        ],
    )
    incoming = region("region-0001", [], assertions=[mention])
    source_dataset = dataset([incoming], [mention], directory=tmp_path)
    sport_evidence = assertion(
        "region-sport",
        "claim-1",
        statement="协会致力于推动乒乓球运动发展。",
    )
    equipment_evidence = assertion(
        "region-equipment",
        "claim-1",
        statement="训练需要采购乒乓球器材。",
    )
    state = registry(
        ["region-0001"],
        cursor=1,
        objects=[
            global_object(
                "global-sport",
                "global-000001-01",
                "乒乓球运动",
                [surface("region-sport", "fragment-1", 0, "乒乓球")],
                assertions=[sport_evidence],
            ),
            global_object(
                "global-equipment",
                "global-000001-02",
                "乒乓球器材",
                [surface("region-equipment", "fragment-1", 0, "乒乓球")],
                assertions=[equipment_evidence],
            ),
        ],
    )

    class FakeModel:
        def __init__(self) -> None:
            self.calls = 0

        async def complete_turn(self, **kwargs: object) -> ModelTurn:
            self.calls += 1
            messages = cast(list[dict[str, str]], kwargs["messages"])
            payload = json.loads(messages[1]["content"].split("\n", 1)[1])
            return ModelTurn(
                content=json.dumps(
                    {
                        "assignments": [
                            {
                                "occurrence_id": item["occurrence_id"],
                                "global_object_id": "global-equipment",
                            }
                            for item in payload["occurrences"]
                        ]
                    }
                )
            )

    model = FakeModel()
    routes = await resolve_ambiguous_literal_senses(
        model=model,
        dataset=source_dataset,
        state=state,
        directory=tmp_path,
    )
    artifact = build_global_assertions_artifact(
        source_dataset,
        state,
        literal_sense_routes=routes,
    )

    assert model.calls == 1
    assert artifact.assertions[0].global_statement_template_markdown == (
        "每桌发放{{object:global-equipment}}2个。"
    )
    assert (tmp_path / "literal-sense-routing.json").is_file()
    checkpoint = json.loads(
        (tmp_path / "literal-sense-routing.json").read_text(encoding="utf-8")
    )
    assert checkpoint["schema_version"] == "literal-sense-routing.v2"
    assert checkpoint["finalization_policy_version"] == "global-finalization-policy.v1"
    assert checkpoint["source_semantics_policy_version"] == "source-semantics-policy.v5"
    assert artifact.schema_version == "global-assertions.v5"
    assert artifact.global_resolution_schema_version == "global-resolution.v6"
    assert artifact.global_resolution_policy_version == "global-resolution-policy.v2"

    class NoCallModel:
        async def complete_turn(self, **kwargs: object) -> ModelTurn:
            del kwargs
            raise AssertionError("相同 Source/Registry 应复用词义分流 checkpoint")

    reused = await resolve_ambiguous_literal_senses(
        model=NoCallModel(),
        dataset=source_dataset,
        state=state,
        directory=tmp_path,
    )
    assert reused == routes


@pytest.mark.asyncio
async def test_runner_decides_fragments_in_parallel_and_skips_empty_region(
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
            self.active = 0
            self.peak = 0

        async def complete_turn(self, **kwargs: object) -> ModelTurn:
            self.calls += 1
            self.active += 1
            self.peak = max(self.peak, self.active)
            await asyncio.sleep(0)
            label = cast(str, kwargs["request_label"])
            selected = first if label.endswith("fragment-1") else second
            self.active -= 1
            decision = FragmentIdentityDecision(
                fragment_key=selected.fragment_key,
                objecthood="accepted",
                action="create",
                canonical_name=selected.surface_atoms[0].surface_form,
                reason="形成独立身份",
            )
            return ModelTurn(content=decision.model_dump_json())

    model = FakeModel()
    final_state = await GlobalObjectResolverRunner(
        model=model,
        dataset=source_dataset,
        paths=paths,
        state=state,
        retriever=GlobalObjectCandidateRetriever(embedder=None),
        enable_admission_review=False,
    ).run_all()

    assert model.calls == 2
    assert model.peak == 2
    assert final_state.next_source_region_ordinal == 2
    assert {item.canonical_name for item in final_state.objects} == {"甲", "乙"}
    assert paths.artifact_json.is_file()
    assert (paths.directory / "global-assertions.json").is_file()


@pytest.mark.asyncio
async def test_admission_review_demotes_low_evidence_property_without_losing_assertion(
    tmp_path: Path,
) -> None:
    claim = assertion(
        "region-0001",
        "claim-1",
        statement="成员的{{fragment:fragment-1}}有所下降。",
        supporting_blocks=[
            SourceBlockEvidence(
                source_block_id="block-1",
                markdown="成员的投入程度有所下降。",
            )
        ],
    )
    candidate = fragment(
        "region-0001",
        "fragment-1",
        ["投入程度"],
        identity_mode_hint="undetermined",
        references=[reference("region-0001", "claim-1", "fragment-1")],
        assertions=[claim],
    )
    source_region = region("region-0001", [candidate], assertions=[claim])
    source_dataset = dataset([source_region], assertions=[claim], directory=tmp_path)
    paths = _paths(tmp_path)
    state = initial_registry(source_dataset)
    write_working_registry(paths, source_dataset, state)

    class FakeModel:
        def __init__(self) -> None:
            self.labels: list[str] = []

        async def complete_turn(self, **kwargs: object) -> ModelTurn:
            label = cast(str, kwargs["request_label"])
            self.labels.append(label)
            if label.startswith("全局对象"):
                decision = FragmentIdentityDecision(
                    fragment_key=candidate.fragment_key,
                    objecthood="accepted",
                    action="create",
                    canonical_name="投入程度",
                    reason="上游误把属性判断为候选 Object",
                )
            else:
                user_prompt = cast(list[dict[str, str]], kwargs["messages"])[1]["content"]
                assert "single_source_region" in user_prompt
                decision = ObjectAdmissionDecision(
                    global_object_id=json.loads(
                        user_prompt.split("输入：\n", 1)[1].split("\n\n输出必须", 1)[0]
                    )["global_object_id"],
                    action="demote",
                    reason="当前证据仅把它作为成员属性使用",
                )
            return ModelTurn(content=decision.model_dump_json())

    model = FakeModel()
    final_state = await GlobalObjectResolverRunner(
        model=cast(Any, model),
        dataset=source_dataset,
        paths=paths,
        state=state,
        retriever=GlobalObjectCandidateRetriever(embedder=None),
    ).run_all()

    assert len(final_state.objects) == 0
    assert final_state.rejected_fragment_keys == [candidate.fragment_key]
    assert final_state.admission_records[0].action == "demote"
    assert any(label.startswith("对象准入") for label in model.labels)
    artifact = json.loads((paths.directory / "global-assertions.json").read_text())
    assert artifact["assertions"][0]["global_statement_template_markdown"] == (
        "成员的投入程度有所下降。"
    )


@pytest.mark.asyncio
async def test_runner_jointly_resolves_only_coupled_fragments(tmp_path: Path) -> None:
    first = fragment("region-0001", "fragment-1", ["一个核心"])
    second = fragment("region-0001", "fragment-2", ["赛事与活动运营"])
    incoming = region("region-0001", [first, second])
    source_dataset = dataset([incoming], directory=tmp_path)
    paths = _paths(tmp_path)
    state = initial_registry(source_dataset)
    write_working_registry(paths, source_dataset, state)

    class FakeModel:
        def __init__(self) -> None:
            self.labels: list[str] = []

        async def complete_turn(self, **kwargs: object) -> ModelTurn:
            label = cast(str, kwargs["request_label"])
            self.labels.append(label)
            if label.endswith("fragment-1"):
                decision = FragmentIdentityDecision(
                    fragment_key=first.fragment_key,
                    objecthood="uncertain",
                    action="joint",
                    joint_fragment_keys=[second.fragment_key],
                    reason="来源明确把两个名称映射为同一模块",
                )
                return ModelTurn(content=decision.model_dump_json())
            if label.endswith("fragment-2"):
                decision = FragmentIdentityDecision(
                    fragment_key=second.fragment_key,
                    objecthood="uncertain",
                    action="joint",
                    joint_fragment_keys=[first.fragment_key],
                    reason="需要与同区名称联合确定身份",
                )
                return ModelTurn(content=decision.model_dump_json())
            plan = RegionIntegrationPlan(
                operations=[
                    RegionResolutionOperation(
                        action="create",
                        groups=[
                            ResolutionGroup(
                                target=ResolutionTarget(
                                    kind="new",
                                    canonical_name="赛事与活动运营",
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
        model=cast(Any, model),
        dataset=source_dataset,
        paths=paths,
        state=state,
        retriever=GlobalObjectCandidateRetriever(embedder=None),
        enable_admission_review=False,
    ).run_all()

    assert len(model.labels) == 3
    assert model.labels[-1].endswith("joint")
    assert len(final_state.objects) == 1
    assert final_state.objects[0].canonical_name == "赛事与活动运营"


@pytest.mark.asyncio
async def test_fragment_attaches_to_same_target_are_coalesced(tmp_path: Path) -> None:
    prior_fragment = fragment("region-0001", "fragment-1", ["甲协会"])
    prior = region("region-0001", [prior_fragment])
    first = fragment("region-0002", "fragment-1", ["甲协会"])
    second = fragment("region-0002", "fragment-2", ["甲协会"])
    incoming = region("region-0002", [first, second])
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

    class FakeModel:
        def __init__(self) -> None:
            self.calls = 0

        async def complete_turn(self, **kwargs: object) -> ModelTurn:
            self.calls += 1
            label = cast(str, kwargs["request_label"])
            selected = first if label.endswith("fragment-1") else second
            decision = FragmentIdentityDecision(
                fragment_key=selected.fragment_key,
                objecthood="accepted",
                action="attach",
                target_global_object_id=existing.global_object_id,
                reason="存在明确的同名身份",
            )
            return ModelTurn(content=decision.model_dump_json())

    model = FakeModel()
    final_state = await GlobalObjectResolverRunner(
        model=cast(Any, model),
        dataset=source_dataset,
        paths=paths,
        state=state,
        retriever=GlobalObjectCandidateRetriever(embedder=None),
        enable_admission_review=False,
    ).run_all()

    assert model.calls == 2
    assert len(final_state.objects) == 1
    assert len(final_state.objects[0].surface_atoms) == 3


def test_candidate_summary_omits_atom_transaction_payload() -> None:
    claim = assertion(
        "region-0001",
        "claim-1",
        statement="{{fragment:fragment-1}}需要依据来源证据判断身份。",
        supporting_blocks=[
            SourceBlockEvidence(source_block_id="block-1", markdown="一段来源原文")
        ],
    )
    source = fragment(
        "region-0001",
        "fragment-1",
        ["候选对象"],
        references=[reference("region-0001", "claim-1", "fragment-1")],
        assertions=[claim],
    )
    candidate = global_object(
        "global-existing",
        "global-000001-01",
        "候选对象",
        source.surface_atoms,
        references=source.reference_atoms,
        assertions=[claim],
    )

    payload = candidate_summary_prompt_payload(candidate)

    assert "surface_atoms" not in payload
    assert "reference_atoms" not in payload
    assert "detailed_assertions" not in payload
    assert payload["aliases"] == ["候选对象"]
    assert payload["evidence_summary"] == {
        "source_region_count": 1,
        "surface_atom_count": 1,
        "reference_atom_count": 1,
    }
    assert len(json.dumps(payload, ensure_ascii=False)) < len(
        json.dumps(candidate_prompt_payload(candidate), ensure_ascii=False)
    )
    lightweight = candidate_summary_prompt_payload(
        candidate,
        include_representative_assertions=False,
    )
    assert lightweight["representative_assertions"] == []


@pytest.mark.asyncio
async def test_runner_allows_one_bounded_source_usage_tool_round(tmp_path: Path) -> None:
    candidate = fragment("region-0001", "fragment-1", ["远航计划"])
    populated = region("region-0001", [candidate]).model_copy(
        update={"context_markdown": "远航计划已启动。"}
    )
    supporting = region("region-0002", []).model_copy(
        update={"context_markdown": "复盘记录显示，远航计划完成了第一阶段。"}
    )
    source_dataset = dataset([populated, supporting], directory=tmp_path)
    paths = _paths(tmp_path)
    state = initial_registry(source_dataset)
    write_working_registry(paths, source_dataset, state)

    class FakeModel:
        def __init__(self) -> None:
            self.calls: list[dict[str, object]] = []

        async def complete_turn(self, **kwargs: object) -> ModelTurn:
            self.calls.append(kwargs)
            if len(self.calls) == 1:
                return ModelTurn(
                    content="",
                    tool_calls=(
                        ToolCall(
                            id="call-usage",
                            name="inspect_source_fragment_usage",
                            arguments=json.dumps({"fragment_key": candidate.fragment_key}),
                        ),
                    ),
                )
            messages = cast(list[dict[str, object]], kwargs["messages"])
            tool_result = json.loads(cast(str, messages[-1]["content"]))
            assert tool_result["exact_occurrences"][0]["region_count"] == 2
            assert kwargs["tools"] == ()
            decision = FragmentIdentityDecision(
                fragment_key=candidate.fragment_key,
                objecthood="accepted",
                action="create",
                canonical_name="远航计划",
                reason="跨区域持续指向同一计划",
            )
            return ModelTurn(content=decision.model_dump_json())

    model = FakeModel()
    final_state = await GlobalObjectResolverRunner(
        model=cast(Any, model),
        dataset=source_dataset,
        paths=paths,
        state=state,
        retriever=GlobalObjectCandidateRetriever(embedder=None),
        enable_admission_review=False,
    ).run_all()

    assert len(model.calls) == 2
    assert model.calls[0]["tools"]
    assert len(final_state.objects) == 1


@pytest.mark.asyncio
async def test_joint_plan_accepts_unclosed_json_fence_without_retry(
    tmp_path: Path,
) -> None:
    incoming_fragment = fragment("region-0001", "fragment-1", ["远航计划"])
    incoming = region("region-0001", [incoming_fragment])
    source_dataset = dataset([incoming], directory=tmp_path)
    paths = _paths(tmp_path)
    state = initial_registry(source_dataset)
    write_working_registry(paths, source_dataset, state)
    expected = RegionIntegrationPlan(
        operations=[
            RegionResolutionOperation(
                action="create",
                groups=[
                    ResolutionGroup(
                        target=ResolutionTarget(kind="new", canonical_name="远航计划"),
                        surface_atom_ids=[incoming_fragment.surface_atoms[0].atom_id],
                    )
                ],
            )
        ]
    )

    class FakeModel:
        def __init__(self) -> None:
            self.calls = 0

        async def complete_turn(self, **kwargs: object) -> ModelTurn:
            self.calls += 1
            return ModelTurn(content="```json\n" + expected.model_dump_json())

    model = FakeModel()
    runner = GlobalObjectResolverRunner(
        model=cast(Any, model),
        dataset=source_dataset,
        paths=paths,
        state=state,
        retriever=GlobalObjectCandidateRetriever(embedder=None),
    )

    actual = await runner._decide_region(
        incoming=incoming,
        candidates_by_fragment={incoming_fragment.fragment_key: []},
        registry=state,
        request_label="测试联合裁决",
    )

    assert actual == expected
    assert model.calls == 1


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
    runner = GlobalObjectResolverRunner(
        model=model,
        dataset=source_dataset,
        paths=paths,
        state=state,
        retriever=GlobalObjectCandidateRetriever(embedder=None),
    )
    candidates = {incoming_fragment.fragment_key: [existing]}
    plan = await runner._decide_region(
        incoming=incoming,
        candidates_by_fragment=candidates,
        registry=state,
        request_label="测试联合裁决",
    )
    final_state = apply_region_plan(
        plan=validate_region_integration_plan(
            plan,
            incoming=incoming,
            registry=state,
            candidates_by_fragment=candidates,
        ),
        state=state,
        dataset=source_dataset,
        sequence=1,
    )

    assert len(model.calls) == 2
    assert "结构细节服从输出 JSON Schema" in model.calls[0][0]["content"]
    retry_messages = model.calls[1]
    assert [item["role"] for item in retry_messages] == [
        "system",
        "user",
        "assistant",
        "user",
    ]
    assert "attach 的 source_global_object_ids 必须为 []" in retry_messages[0]["content"]
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
    runner = GlobalObjectResolverRunner(
        model=model,
        dataset=source_dataset,
        paths=paths,
        state=state,
        retriever=GlobalObjectCandidateRetriever(embedder=None),
    )
    candidates: dict[str, list[ActiveGlobalObject]] = {
        first.fragment_key: [],
        second.fragment_key: [],
    }
    plan = await runner._decide_region(
        incoming=incoming,
        candidates_by_fragment=candidates,
        registry=state,
        request_label="测试联合裁决",
    )
    final_state = apply_region_plan(
        plan=validate_region_integration_plan(
            plan,
            incoming=incoming,
            registry=state,
            candidates_by_fragment=candidates,
        ),
        state=state,
        dataset=source_dataset,
        sequence=0,
    )

    assert len(model.calls) == 2
    assert "结构细节服从输出 JSON Schema" in model.calls[0][0]["content"]
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
            ),
            surface_atom_ids=[first.surface_atoms[0].atom_id],
        ),
        ResolutionGroup(
            target=ResolutionTarget(
                kind="new",
                canonical_name="干事",
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
        '"canonical_name":"干事"',
        '"canonical_name":"与"干事会"不同"',
    )
    repaired = RegionIntegrationPlan(
        operations=[RegionResolutionOperation(action="create", groups=[group]) for group in groups]
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
    runner = GlobalObjectResolverRunner(
        model=model,
        dataset=source_dataset,
        paths=paths,
        state=state,
        retriever=GlobalObjectCandidateRetriever(embedder=None),
    )
    candidates: dict[str, list[ActiveGlobalObject]] = {
        first.fragment_key: [],
        second.fragment_key: [],
    }
    plan = await runner._decide_region(
        incoming=incoming,
        candidates_by_fragment=candidates,
        registry=state,
        request_label="测试联合裁决",
    )
    final_state = apply_region_plan(
        plan=validate_region_integration_plan(
            plan,
            incoming=incoming,
            registry=state,
            candidates_by_fragment=candidates,
        ),
        state=state,
        dataset=source_dataset,
        sequence=0,
    )

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
