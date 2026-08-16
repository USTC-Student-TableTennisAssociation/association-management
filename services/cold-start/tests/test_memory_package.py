from __future__ import annotations

import pytest
from pydantic import ValidationError

from cold_start.compilation import (
    Assertion,
    Evidence,
    MemoryObject,
    MemoryPackage,
    ParentIntegrationDecision,
    TemporalScope,
    apply_parent_decision,
    object_assertion_ids,
    object_evidence_ids,
    package_warnings,
    rebase_package,
    render_statement,
    rewrite_object_references,
)


def _evidence(number: int) -> Evidence:
    return Evidence(
        evidence_id=f"evidence-{number}",
        start_block_id=f"p0001-b{number:04d}",
        end_block_id=f"p0001-b{number:04d}",
    )


def _object(number: int, label: str) -> MemoryObject:
    return MemoryObject(
        object_id=f"obj-{number}",
        label=label,
    )


def _assertion(**values: object) -> Assertion:
    return Assertion(
        temporal_scope=TemporalScope(
            kind="unknown",
            display="时间不明",
            start=None,
            end=None,
            precision="unspecified",
        ),
        temporal_basis_markdown="原文及上下文没有给出可定位时间。",
        **values,
    )


def test_package_accepts_incomplete_record_and_sourced_viewpoint() -> None:
    package = MemoryPackage(
        objects=[
            _object(1, "乒协"),
            _object(2, "继往开来杯"),
            _object(3, "魏汉东"),
        ],
        assertions=[
            _assertion(
                assertion_id="assert-1",
                mode="record",
                statement_template_markdown=(
                    "{{object:obj-2}}过去通常申请两个场地。"
                ),
                evidence_ids=["evidence-4"],
            ),
            _assertion(
                assertion_id="assert-2",
                mode="viewpoint",
                statement_template_markdown=(
                    "{{object:obj-3}}建议{{object:obj-1}}持续优化内部管理。"
                ),
                holder_object_id="obj-3",
                evidence_ids=["evidence-5"],
            ),
        ],
        evidence=[_evidence(number) for number in range(1, 6)],
    )

    assert package.schema_version == "object-assertion-evidence-package.v4"
    assert package.assertions[1].referenced_object_ids == ["obj-3", "obj-1"]
    assert package.assertions[0].temporal_scope.kind == "unknown"
    assert package.assertions[0].uncertainty_markdown is None


def test_package_keeps_unused_evidence_as_warning() -> None:
    package = MemoryPackage(
        objects=[_object(1, "继往开来杯")],
        assertions=[
            _assertion(
                assertion_id="assert-1",
                mode="record",
                statement_template_markdown="{{object:obj-1}}有一项历史做法。",
                evidence_ids=["evidence-1"],
            )
        ],
        evidence=[_evidence(1), _evidence(2)],
    )

    warnings = package_warnings(package)

    assert any("evidence-2" in warning for warning in warnings)


def test_record_rejects_viewpoint_holder() -> None:
    with pytest.raises(ValidationError, match="holder_object_id 必须为 null"):
        _assertion(
            assertion_id="assert-1",
            mode="record",
            statement_template_markdown="{{object:obj-1}}有一项历史做法。",
            holder_object_id="obj-1",
            evidence_ids=["evidence-1"],
        )


def test_optional_markdown_rejects_empty_string() -> None:
    with pytest.raises(ValidationError, match="at least 1 character"):
        _assertion(
            assertion_id="assert-1",
            mode="record",
            statement_template_markdown="{{object:obj-1}}有一项历史做法。",
            uncertainty_markdown="",
            evidence_ids=["evidence-1"],
        )


def test_assertion_requires_explicit_time_and_basis() -> None:
    with pytest.raises(ValidationError, match="Field required"):
        Assertion(
            assertion_id="assert-1",
            mode="record",
            statement_template_markdown="{{object:obj-1}}有一项历史做法。",
            evidence_ids=["evidence-1"],
        )


def test_temporal_scope_rejects_inconsistent_boundaries() -> None:
    with pytest.raises(ValidationError, match="point 必须只填写 start"):
        TemporalScope(
            kind="point",
            display="2024年",
            start="2024",
            end="2025",
            precision="year",
        )


def test_package_rejects_dangling_references() -> None:
    with pytest.raises(ValidationError, match="不存在的 ID"):
        MemoryPackage(
            objects=[_object(1, "继往开来杯")],
            assertions=[
                _assertion(
                    assertion_id="assert-1",
                    mode="record",
                    statement_template_markdown="{{object:obj-404}}有一项不完整记录。",
                    evidence_ids=["evidence-2"],
                )
            ],
            evidence=[_evidence(1), _evidence(2)],
        )


def test_object_rejects_duplicate_aliases() -> None:
    with pytest.raises(ValidationError, match="aliases 不能重复"):
        MemoryObject(
            object_id="obj-1",
            label="继往开来杯",
            aliases=["继往开来", "继往开来"],
        )


def test_object_rejects_removed_evidence_field() -> None:
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        MemoryObject.model_validate(
            {
                "object_id": "obj-1",
                "label": "继往开来杯",
                "aliases": [],
                "evidence_ids": ["evidence-1"],
            }
        )


def test_package_rejects_object_without_assertion() -> None:
    with pytest.raises(ValidationError, match="未被任何叙述连接"):
        MemoryPackage(objects=[_object(1, "继往开来杯")])


def test_empty_package_is_valid_for_document_navigation() -> None:
    package = MemoryPackage()

    assert package.objects == []
    assert package.assertions == []
    assert package.evidence == []


def test_object_support_is_derived_from_assertions() -> None:
    package = MemoryPackage(
        objects=[_object(1, "继往开来杯")],
        assertions=[
            _assertion(
                assertion_id="assert-1",
                mode="record",
                statement_template_markdown="{{object:obj-1}}通常申请两个场地。",
                evidence_ids=["evidence-1", "evidence-2"],
            )
        ],
        evidence=[_evidence(1), _evidence(2)],
    )

    assert object_assertion_ids(package, "obj-1") == ["assert-1"]
    assert object_evidence_ids(package, "obj-1") == ["evidence-1", "evidence-2"]


def test_assertion_rejects_plain_text_without_object_reference() -> None:
    with pytest.raises(ValidationError, match="至少需要一个对象引用"):
        _assertion(
            assertion_id="assert-1",
            mode="record",
            statement_template_markdown="继往开来杯过去通常申请两个场地。",
            evidence_ids=["evidence-1"],
        )


def test_assertion_rejects_malformed_object_reference() -> None:
    with pytest.raises(ValidationError, match="不完整的对象引用"):
        _assertion(
            assertion_id="assert-1",
            mode="record",
            statement_template_markdown="{{object:obj-1过去通常申请两个场地。",
            evidence_ids=["evidence-1"],
        )


def test_render_uses_current_object_label_without_changing_assertion() -> None:
    assertion = _assertion(
        assertion_id="assert-1",
        mode="record",
        statement_template_markdown=(
            "{{object:obj-1}}在该手册中被写作“中国科学技术大学学生乒乓球协会”。"
        ),
        evidence_ids=["evidence-1"],
    )
    original = _object(1, "中国科学技术大学学生乒乓球协会")
    corrected = original.model_copy(
        update={"label": "中国科学技术大学校学生乒乓球协会"}
    )

    assert render_statement(assertion, {original.object_id: original}).startswith(
        "中国科学技术大学学生乒乓球协会在该手册中"
    )
    rendered = render_statement(assertion, {corrected.object_id: corrected})
    assert rendered.startswith("中国科学技术大学校学生乒乓球协会在该手册中")
    assert "被写作“中国科学技术大学学生乒乓球协会”" in rendered


def test_rewrite_changes_only_object_references() -> None:
    template = "{{object:obj-1}}在原文中被称为“乒协”。"

    rewritten = rewrite_object_references(template, {"obj-1": "region-0002/obj-1"})

    assert rewritten == "{{object:region-0002/obj-1}}在原文中被称为“乒协”。"


def test_rebase_rewrites_assertion_object_references() -> None:
    package = MemoryPackage(
        objects=[_object(1, "乒协")],
        assertions=[
            _assertion(
                assertion_id="assert-1",
                mode="record",
                statement_template_markdown="{{object:obj-1}}每学年举办大型比赛。",
                evidence_ids=["evidence-1"],
            )
        ],
        evidence=[_evidence(1)],
    )

    rebased = rebase_package(package, "region-0002")

    assert rebased.assertions[0].statement_template_markdown == (
        "{{object:region-0002/obj-1}}每学年举办大型比赛。"
    )
    assert rebased.assertions[0].referenced_object_ids == ["region-0002/obj-1"]


def test_object_merge_rewrites_assertions_to_preferred_object() -> None:
    package = MemoryPackage(
        objects=[
            _object(1, "中国科学技术大学学生乒乓球协会"),
            _object(2, "中国科学技术大学校学生乒乓球协会"),
        ],
        assertions=[
            _assertion(
                assertion_id="assert-1",
                mode="record",
                statement_template_markdown="{{object:obj-1}}成立于2000年。",
                evidence_ids=["evidence-1"],
            ),
            _assertion(
                assertion_id="assert-2",
                mode="record",
                statement_template_markdown="{{object:obj-2}}是该协会的完整名称。",
                evidence_ids=["evidence-2"],
            ),
        ],
        evidence=[_evidence(1), _evidence(2)],
    )
    decision = ParentIntegrationDecision.model_validate(
        {
            "object_merges": [
                {
                    "object_ids": ["obj-1", "obj-2"],
                    "preferred_object_id": "obj-2",
                    "reason": "两处指向同一协会，以完整名称为规范名称。",
                }
            ],
            "assertion_merges": [],
            "assertion_revisions": [],
        }
    )

    merged = apply_parent_decision(package, decision)

    assert len(merged.objects) == 1
    assert merged.assertions[0].statement_template_markdown == (
        "{{object:obj-2}}成立于2000年。"
    )
    assert object_assertion_ids(merged, "obj-2") == ["assert-1", "assert-2"]
    assert object_evidence_ids(merged, "obj-2") == ["evidence-1", "evidence-2"]
    assert render_statement(
        merged.assertions[0],
        {item.object_id: item for item in merged.objects},
    ) == "中国科学技术大学校学生乒乓球协会成立于2000年。"
