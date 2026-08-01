from __future__ import annotations

import pytest
from pydantic import ValidationError

from cold_start.compilation import (
    Assertion,
    Evidence,
    MemoryObject,
    MemoryPackage,
    ObjectMergeConflict,
    Relation,
    UnresolvedItem,
    merge_objects,
)


def _evidence(number: int) -> Evidence:
    return Evidence(
        evidence_id=f"evidence-{number}",
        start_block_id=f"p0001-b{number:04d}",
        end_block_id=f"p0001-b{number:04d}",
        role="basis",
    )


def _object(number: int, label: str, kind: str = "unknown") -> MemoryObject:
    return MemoryObject(
        object_id=f"obj-{number}",
        label=label,
        kind_hints=[kind],
        evidence_ids=[f"evidence-{number}"],
    )


def test_package_accepts_incomplete_record_and_sourced_viewpoint() -> None:
    package = MemoryPackage(
        objects=[
            _object(1, "乒协", "organization"),
            _object(2, "继往开来杯", "activity"),
            _object(3, "魏汉东", "person"),
            _object(4, "场地申请", "work_unit"),
        ],
        assertions=[
            Assertion(
                assertion_id="assert-1",
                about_object_ids=["obj-2"],
                mode="record",
                kind_hint="practice",
                statement_markdown="继往开来杯过去通常申请两个场地。",
                evidence_ids=["evidence-5"],
            ),
            Assertion(
                assertion_id="assert-2",
                about_object_ids=["obj-1"],
                mode="viewpoint",
                kind_hint="guidance",
                statement_markdown="作者建议持续优化内部管理。",
                holder_object_id="obj-3",
                authority_status="personal_view",
                evidence_ids=["evidence-6"],
            ),
        ],
        relations=[
            Relation(
                relation_id="rel-1",
                from_object_id="obj-2",
                predicate="uses",
                to_object_id="obj-4",
                evidence_ids=["evidence-7"],
            )
        ],
        evidence=[_evidence(number) for number in range(1, 8)],
    )

    assert package.assertions[0].temporal_scope_markdown is None
    assert package.assertions[0].uncertainty_markdown is None
    assert package.relations[0].predicate == "uses"


def test_package_rejects_semantic_and_reference_errors() -> None:
    with pytest.raises(ValidationError, match="unknown 不能与其他"):
        MemoryObject(
            object_id="obj-1",
            label="错误对象",
            kind_hints=["unknown", "activity"],
            evidence_ids=["evidence-1"],
        )

    with pytest.raises(ValidationError, match="只能作为观点性陈述"):
        Assertion(
            assertion_id="assert-1",
            about_object_ids=["obj-1"],
            mode="record",
            kind_hint="guidance",
            statement_markdown="错误地把建议写成事实。",
            evidence_ids=["evidence-1"],
        )

    with pytest.raises(ValidationError, match="不存在的 ID"):
        MemoryPackage(
            objects=[_object(1, "继往开来杯", "activity")],
            assertions=[
                Assertion(
                    assertion_id="assert-1",
                    about_object_ids=["obj-404"],
                    mode="record",
                    statement_markdown="一项不完整记录。",
                    evidence_ids=["evidence-2"],
                )
            ],
            evidence=[_evidence(1), _evidence(2)],
        )


def test_merge_objects_remaps_all_object_references() -> None:
    package = MemoryPackage(
        objects=[
            _object(1, "继往开来"),
            _object(2, "继往开来杯"),
            _object(3, "场地申请", "work_unit"),
        ],
        assertions=[
            Assertion(
                assertion_id="assert-1",
                about_object_ids=["obj-1", "obj-2"],
                mode="record",
                statement_markdown="两个名称指向同一比赛。",
                evidence_ids=["evidence-4"],
            )
        ],
        relations=[
            Relation(
                relation_id="rel-1",
                from_object_id="obj-2",
                predicate="uses",
                to_object_id="obj-3",
                context_object_id="obj-1",
                evidence_ids=["evidence-5"],
            )
        ],
        evidence=[_evidence(number) for number in range(1, 6)],
        unresolved=[
            UnresolvedItem(
                unresolved_id="unresolved-1",
                kind="object_identity",
                description_markdown="两个称呼是否相同需要上层确认。",
                object_ids=["obj-1", "obj-2"],
                evidence_ids=["evidence-1", "evidence-2"],
            )
        ],
    )
    replacement = MemoryObject(
        object_id="obj-6",
        label="继往开来杯",
        aliases=["继往开来"],
        kind_hints=["activity"],
        evidence_ids=["evidence-1", "evidence-2"],
    )

    merged = merge_objects(
        package,
        source_object_ids=["obj-1", "obj-2"],
        replacement=replacement,
    )

    assert [item.object_id for item in merged.objects] == ["obj-6", "obj-3"]
    assert merged.assertions[0].about_object_ids == ["obj-6"]
    assert merged.relations[0].from_object_id == "obj-6"
    assert merged.relations[0].context_object_id == "obj-6"
    assert merged.unresolved[0].object_ids == ["obj-6"]


def test_merge_does_not_silently_discard_relation_self_loop() -> None:
    package = MemoryPackage(
        objects=[_object(1, "甲"), _object(2, "乙")],
        relations=[
            Relation(
                relation_id="rel-1",
                from_object_id="obj-1",
                predicate="same_as_candidate",
                to_object_id="obj-2",
                evidence_ids=["evidence-3"],
            )
        ],
        evidence=[_evidence(1), _evidence(2), _evidence(3)],
    )
    replacement = MemoryObject(
        object_id="obj-4",
        label="合并对象",
        kind_hints=["unknown"],
        evidence_ids=["evidence-1", "evidence-2"],
    )

    with pytest.raises(ObjectMergeConflict, match="形成自环"):
        merge_objects(
            package,
            source_object_ids=["obj-1", "obj-2"],
            replacement=replacement,
        )
