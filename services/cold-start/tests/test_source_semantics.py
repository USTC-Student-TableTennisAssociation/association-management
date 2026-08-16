from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from cold_start.compilation.source_semantics import (
    CLAIM_EXTRACTION_SYSTEM_PROMPT,
    CONSERVATIVE_ATOMIC_FALLBACK_SYSTEM_PROMPT,
    MISSING_CLAIMS_SYSTEM_PROMPT,
    OBJECT_FRAGMENT_SYSTEM_PROMPT,
    SOURCE_TIME_SYSTEM_PROMPT,
    AssertionKind,
    AtomicClaimSubmission,
    FragmentAssertionTemplateDraft,
    FullSourceSemanticRunner,
    FullSourceSemanticSnapshot,
    MissingClaimSubmission,
    ObjectFragmentDraft,
    ObjectFragmentSubmission,
    SameReferentDraft,
    SameReferentMentionDraft,
    SourceClaim,
    SourceObjectFragmentCheckpoint,
    SourceSameReferentDraft,
    SourceSemanticCompiler,
    SourceTimeSubmission,
    _materialize_fragments,
    _validate_fragment_checkpoint,
    _validate_fragment_submission,
    _validate_missing_claims,
    _validate_same_referent_drafts,
    _validate_source_time,
    create_full_source_semantic_paths,
    create_source_semantic_paths,
    normalize_json_fence,
    open_full_source_semantic_paths,
)
from cold_start.document.models import ParsedBlock
from cold_start.global_exploration.models import GlobalExplorationSnapshot, SourceMetadata
from cold_start.llm.base import ModelTurn, ThinkingMode
from cold_start.llm.openai_compatible import ModelRepetitionError
from cold_start.region_tree.models import RegionNode, RegionTreeSnapshot, SourceSegment


class FakeJsonModel:
    def __init__(self, turns: list[ModelTurn | Exception]) -> None:
        self.turns = turns
        self.calls: list[dict[str, object]] = []

    async def complete_turn(
        self,
        *,
        messages: Sequence[Mapping[str, Any]],
        tools: Sequence[Mapping[str, Any]] = (),
        tool_choice: object | None = None,
        temperature: float | None = None,
        request_label: str = "模型",
        thinking: ThinkingMode | None = None,
    ) -> ModelTurn:
        self.calls.append(
            {
                "messages": messages,
                "tools": tools,
                "tool_choice": tool_choice,
                "temperature": temperature,
                "request_label": request_label,
                "thinking": thinking,
            }
        )
        turn = self.turns.pop(0)
        if isinstance(turn, Exception):
            raise turn
        return turn


def _json_turn(value: object) -> ModelTurn:
    return ModelTurn(
        content=json.dumps(value, ensure_ascii=False),
        reasoning_content="只完成当前阶段要求的单一判断。",
    )


def _initial_turn(
    *,
    statement: str | None = "继往开来杯过去通常申请两个场地。",
    same_referent_spans: Sequence[str] = (),
    context_dependent: bool = False,
) -> ModelTurn:
    claims = []
    if statement is not None:
        claims.append(
            {
                "statement_markdown": statement,
                "supporting_block_ids": ["p0001-b0002"],
                "context_dependent": context_dependent,
            }
        )
    drafts = []
    if same_referent_spans:
        drafts.append(
            {
                "mentions": [
                    {"span_text": span, "occurrence_index": 0} for span in same_referent_spans
                ],
                "supporting_block_ids": ["p0001-b0002"],
            }
        )
    return _json_turn({"claims": claims, "same_referent_drafts": drafts})


def _review_turn() -> ModelTurn:
    return _json_turn(
        {
            "claims": [
                {
                    "statement_markdown": "大型比赛必须提前申请场地。",
                    "supporting_block_ids": ["p0001-b0002"],
                    "context_dependent": False,
                }
            ]
        }
    )


def _fragment_turn() -> ModelTurn:
    return _json_turn(
        {
            "fragments": [
                {"fragment_key": "F1", "surface_forms": ["继往开来杯"]},
                {"fragment_key": "F2", "surface_forms": ["大型比赛"]},
            ],
            "assertions": [
                {
                    "claim_id": "claim-1",
                    "statement_template_markdown": ("{{fragment:F1}}过去通常申请两个场地。"),
                },
                {
                    "claim_id": "claim-2",
                    "statement_template_markdown": ("{{fragment:F2}}必须提前申请场地。"),
                },
            ],
        }
    )


def _one_fragment_turn(
    *,
    surface_forms: Sequence[str] = ("继往开来杯",),
    template: str = "{{fragment:F1}}过去通常申请两个场地。",
) -> ModelTurn:
    return _json_turn(
        {
            "fragments": [{"fragment_key": "F1", "surface_forms": list(surface_forms)}],
            "assertions": [
                {
                    "claim_id": "claim-1",
                    "statement_template_markdown": template,
                }
            ],
        }
    )


def _blocks(
    paragraph: str = "继往开来杯过去通常申请两个场地。大型比赛必须提前申请场地。",
) -> tuple[ParsedBlock, ...]:
    return (
        ParsedBlock(
            block_id="p0001-b0001",
            order=0,
            block_type="heading",
            source_pages=(1,),
            heading_level=2,
            heading_path=("比赛场地",),
            markdown="## 比赛场地",
        ),
        ParsedBlock(
            block_id="p0001-b0002",
            order=1,
            block_type="paragraph",
            source_pages=(1,),
            heading_path=("比赛场地",),
            markdown=paragraph,
        ),
    )


def _exploration() -> GlobalExplorationSnapshot:
    root = RegionNode(
        node_id="region-0001",
        parent_id=None,
        depth=0,
        label="测试手册",
        introduction="协会活动手册。",
        start_block_id="p0001-b0001",
        end_block_id="p0001-b0002",
        source_pages=[1],
        status="branch",
        child_ids=["region-0002"],
    )
    leaf = RegionNode(
        node_id="region-0002",
        parent_id="region-0001",
        depth=1,
        label="比赛场地",
        introduction="介绍比赛场地申请实践。",
        start_block_id="p0001-b0001",
        end_block_id="p0001-b0002",
        source_pages=[1],
        status="leaf",
        owned_segments=[
            SourceSegment(
                start_block_id="p0001-b0001",
                end_block_id="p0001-b0002",
            )
        ],
        owned_source_role="content_source",
    )
    return GlobalExplorationSnapshot(
        created_at=datetime.now(UTC),
        source=SourceMetadata(
            path="handbook.pdf",
            title="测试手册",
            sha256="a" * 64,
            parser="fake",
            page_count=1,
            block_count=2,
        ),
        document_context_markdown="这是协会活动手册。",
        context_model_calls=1,
        region_tree=RegionTreeSnapshot(
            status="frozen",
            root_node_id="region-0001",
            nodes=[root, leaf],
            leaf_node_ids=["region-0002"],
            content_node_ids=["region-0002"],
            structural_context_node_ids=[],
        ),
    )


@pytest.mark.asyncio
async def test_compiles_three_direct_json_stages(tmp_path: Path) -> None:
    paths = create_source_semantic_paths(tmp_path, "region-0002")
    model = FakeJsonModel(
        [
            _initial_turn(),
            _review_turn(),
            _fragment_turn(),
        ]
    )

    snapshot = await SourceSemanticCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=paths,
    ).compile("region-0002")

    assert snapshot.initial_claim_count == 1
    assert snapshot.review_addition_count == 1
    assert snapshot.model_calls == 3
    assert [item.claim_id for item in snapshot.assertions] == ["claim-1", "claim-2"]
    assert snapshot.assertions[0].statement_template_markdown.startswith("{{fragment:fragment-1}}")
    assert snapshot.assertions[0].context_dependent is False
    assert [item.fragment_id for item in snapshot.object_fragments] == [
        "fragment-1",
        "fragment-2",
    ]
    assert snapshot.object_fragments[0].surface_forms == ["继往开来杯"]
    assert set(snapshot.object_fragments[0].model_dump()) == {
        "fragment_id",
        "source_region_id",
        "surface_forms",
    }
    assert paths.initial_claims_json.exists()
    assert paths.reviewed_claims_json.exists()
    assert paths.object_fragments_json.exists()
    assert paths.snapshot_json.exists()
    assert paths.report_markdown.exists()

    assert len(model.calls) == 3
    assert all(call["thinking"] == "enabled" for call in model.calls)
    assert all(call["temperature"] is None for call in model.calls)
    assert all(call["tools"] == () for call in model.calls)
    assert all(call["tool_choice"] is None for call in model.calls)
    assert all(
        "Atomic-Conservative-Fallback" not in str(call["request_label"]) for call in model.calls
    )
    first_system = str(model.calls[0]["messages"][0]["content"])
    assert "只输出一个 JSON 对象" in first_system
    assert "不判断全局 Object identity" in first_system
    assert "same_referent_drafts" in first_system
    assert "context_dependent" in first_system
    assert "语义重建" in first_system
    fragment_system = str(model.calls[2]["messages"][0]["content"])
    assert fragment_system == OBJECT_FRAGMENT_SYSTEM_PROMPT
    assert "一次调用同时完成" in fragment_system
    assert "hard grouping hint" in fragment_system
    assert set(ObjectFragmentSubmission.model_fields) == {"fragments", "assertions"}
    assert set(ObjectFragmentDraft.model_fields) == {
        "fragment_key",
        "surface_forms",
    }
    assert set(FragmentAssertionTemplateDraft.model_fields) == {
        "claim_id",
        "kind",
        "statement_template_markdown",
        "semantic_fragment_keys",
    }
    assert set(snapshot.assertions[0].model_dump()) == {
        "claim_id",
        "kind",
        "statement_template_markdown",
        "semantic_fragment_ids",
        "supporting_block_ids",
        "context_dependent",
    }


@pytest.mark.asyncio
async def test_model_constructs_fragment_and_direct_template(tmp_path: Path) -> None:
    fragment = _json_turn(
        {
            "fragments": [{"fragment_key": "F1", "surface_forms": ["协会"]}],
            "assertions": [
                {
                    "claim_id": "claim-1",
                    "statement_template_markdown": ("{{fragment:F1}}过去通常申请两个场地。"),
                }
            ],
        }
    )
    paths = create_source_semantic_paths(tmp_path, "region-0002")
    snapshot = await SourceSemanticCompiler(
        model=FakeJsonModel(
            [
                _initial_turn(
                    statement="协会过去通常申请两个场地",
                    context_dependent=True,
                ),
                _json_turn({"claims": []}),
                fragment,
            ]
        ),
        exploration=_exploration(),
        blocks=_blocks("协会过去通常申请两个场地。"),
        paths=paths,
    ).compile("region-0002")

    assert snapshot.object_fragments[0].surface_forms == ["协会"]
    assert snapshot.assertions[0].statement_template_markdown == (
        "{{fragment:fragment-1}}过去通常申请两个场地。"
    )
    assert snapshot.assertions[0].context_dependent is True


@pytest.mark.asyncio
async def test_atomic_parenthetical_same_referent_is_not_a_factual_claim(
    tmp_path: Path,
) -> None:
    blocks = _blocks("远航协会（ABC，以下简称远协）。")
    model = FakeJsonModel(
        [
            _initial_turn(
                statement=None,
                same_referent_spans=["远航协会", "ABC", "远协"],
            ),
            _json_turn({"claims": []}),
            _json_turn(
                {
                    "fragments": [
                        {
                            "fragment_key": "F1",
                            "surface_forms": ["远航协会", "ABC", "远协"],
                        }
                    ],
                    "assertions": [],
                }
            ),
        ]
    )
    paths = create_source_semantic_paths(tmp_path, "region-0002")
    snapshot = await SourceSemanticCompiler(
        model=model,
        exploration=_exploration(),
        blocks=blocks,
        paths=paths,
    ).compile("region-0002")

    initial = json.loads(paths.initial_claims_json.read_text(encoding="utf-8"))
    reviewed = json.loads(paths.reviewed_claims_json.read_text(encoding="utf-8"))
    assert initial["schema_version"] == "source-claims.v7"
    assert initial["claims"] == []
    assert len(initial["same_referent_drafts"]) == 1
    assert reviewed["same_referent_drafts"] == initial["same_referent_drafts"]
    assert snapshot.assertions == []
    assert snapshot.object_fragments[0].surface_forms == [
        "远航协会",
        "ABC",
        "远协",
    ]
    assert snapshot.model_calls == 3
    assert len(model.calls) == 3
    assert not (paths.directory / "05-same-referent.json").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("statement", "spans"),
    [
        ("远航协会，简称远协。", ["远航协会", "远协"]),
        ("甲协会，英文名ABC。", ["甲协会", "ABC"]),
    ],
)
async def test_explicit_short_or_english_name_becomes_same_referent(
    tmp_path: Path,
    statement: str,
    spans: list[str],
) -> None:
    model = FakeJsonModel(
        [
            _initial_turn(statement=None, same_referent_spans=spans),
            _json_turn({"claims": []}),
            _json_turn(
                {
                    "fragments": [{"fragment_key": "F1", "surface_forms": spans}],
                    "assertions": [],
                }
            ),
        ]
    )
    snapshot = await SourceSemanticCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(statement),
        paths=create_source_semantic_paths(tmp_path, "region-0002"),
    ).compile("region-0002")

    assert snapshot.object_fragments[0].surface_forms == spans
    assert snapshot.assertions == []
    assert snapshot.model_calls == 3


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("statement", "spans"),
    [
        ("甲协会负责乙活动。", ["甲协会", "乙活动"]),
        ("甲协会属于乙组织。", ["甲协会", "乙组织"]),
        ("甲协会与乙组织合作。", ["甲协会", "乙组织"]),
        ("会长协助副会长。", ["会长", "副会长"]),
        ("继往开来与继往开来比赛都将举办。", ["继往开来", "继往开来比赛"]),
    ],
)
async def test_non_identity_relationships_do_not_create_atomic_same_referent(
    tmp_path: Path,
    statement: str,
    spans: list[str],
) -> None:
    model = FakeJsonModel(
        [
            _initial_turn(statement=statement),
            _json_turn({"claims": []}),
            _json_turn(
                {
                    "fragments": [
                        {
                            "fragment_key": f"F{position}",
                            "surface_forms": [span],
                        }
                        for position, span in enumerate(spans, start=1)
                    ],
                    "assertions": [
                        {
                            "claim_id": "claim-1",
                            "statement_template_markdown": statement,
                        }
                    ],
                }
            ),
        ]
    )
    snapshot = await SourceSemanticCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(statement),
        paths=create_source_semantic_paths(tmp_path, "region-0002"),
    ).compile("region-0002")

    assert len(snapshot.object_fragments) == len(spans)
    assert [item.surface_forms for item in snapshot.object_fragments] == [[span] for span in spans]
    assert len(model.calls) == 3


@pytest.mark.asyncio
async def test_mixed_sentence_is_split_during_atomic_extraction(
    tmp_path: Path,
) -> None:
    model = FakeJsonModel(
        [
            _initial_turn(
                statement="甲协会成立于2005年。",
                same_referent_spans=["甲协会", "ABC"],
            ),
            _json_turn({"claims": []}),
            _json_turn(
                {
                    "fragments": [
                        {
                            "fragment_key": "F1",
                            "surface_forms": ["甲协会", "ABC"],
                        }
                    ],
                    "assertions": [
                        {
                            "claim_id": "claim-1",
                            "statement_template_markdown": ("{{fragment:F1}}成立于2005年。"),
                        }
                    ],
                }
            ),
        ]
    )
    snapshot = await SourceSemanticCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks("甲协会（ABC）成立于2005年。"),
        paths=create_source_semantic_paths(tmp_path, "region-0002"),
    ).compile("region-0002")

    assert snapshot.assertions[0].statement_template_markdown == (
        "{{fragment:fragment-1}}成立于2005年。"
    )
    assert snapshot.assertions[0].supporting_block_ids == ["p0001-b0002"]
    assert snapshot.object_fragments[0].surface_forms == ["甲协会", "ABC"]
    assert len(model.calls) == 3


@pytest.mark.asyncio
async def test_corrupted_v6_fragment_snapshot_is_rebuilt_from_stage_checkpoints(
    tmp_path: Path,
) -> None:
    paths = create_source_semantic_paths(tmp_path, "region-0002")
    turns = [
        _initial_turn(
            statement="甲协会成立于2005年。",
            same_referent_spans=["甲协会", "ABC"],
        ),
        _json_turn({"claims": []}),
        _json_turn(
            {
                "fragments": [
                    {
                        "fragment_key": "F1",
                        "surface_forms": ["甲协会", "ABC"],
                    }
                ],
                "assertions": [
                    {
                        "claim_id": "claim-1",
                        "statement_template_markdown": ("{{fragment:F1}}成立于2005年。"),
                    }
                ],
            }
        ),
    ]
    blocks = _blocks("甲协会（ABC）成立于2005年。")
    await SourceSemanticCompiler(
        model=FakeJsonModel(turns),
        exploration=_exploration(),
        blocks=blocks,
        paths=paths,
    ).compile("region-0002")

    corrupted = json.loads(paths.snapshot_json.read_text(encoding="utf-8"))
    corrupted["assertions"][0]["statement_template_markdown"] = (
        "{{fragment:fragment-999}}成立于2005年。"
    )
    paths.snapshot_json.write_text(
        json.dumps(corrupted, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    resumed_model = FakeJsonModel([])
    snapshot = await SourceSemanticCompiler(
        model=resumed_model,
        exploration=_exploration(),
        blocks=blocks,
        paths=paths,
    ).compile("region-0002")

    assert resumed_model.calls == []
    assert snapshot.assertions[0].statement_template_markdown == (
        "{{fragment:fragment-1}}成立于2005年。"
    )


@pytest.mark.asyncio
async def test_ordinary_parenthetical_does_not_become_same_referent(
    tmp_path: Path,
) -> None:
    statement = "活动在西区体育馆（周末开放）举行。"
    snapshot = await SourceSemanticCompiler(
        model=FakeJsonModel(
            [
                _initial_turn(statement=statement),
                _json_turn({"claims": []}),
                _json_turn(
                    {
                        "fragments": [
                            {
                                "fragment_key": "F1",
                                "surface_forms": ["活动"],
                            },
                            {
                                "fragment_key": "F2",
                                "surface_forms": ["西区体育馆"],
                            },
                        ],
                        "assertions": [
                            {
                                "claim_id": "claim-1",
                                "statement_template_markdown": (
                                    "{{fragment:F1}}在{{fragment:F2}}（周末开放）举行。"
                                ),
                            }
                        ],
                    }
                ),
            ]
        ),
        exploration=_exploration(),
        blocks=_blocks(statement),
        paths=create_source_semantic_paths(tmp_path, "region-0002"),
    ).compile("region-0002")

    assert len(snapshot.object_fragments) == 2
    assert snapshot.assertions[0].statement_template_markdown == (
        "{{fragment:fragment-1}}在{{fragment:fragment-2}}（周末开放）举行。"
    )


def _same_referent_draft(
    *spans: str,
    block_id: str = "p0001-b0002",
) -> SourceSameReferentDraft:
    return SourceSameReferentDraft(
        same_referent_draft_id="same-ref-draft-1",
        mentions=[SameReferentMentionDraft(span_text=span, occurrence_index=0) for span in spans],
        supporting_block_ids=[block_id],
    )


def test_atomic_naming_hint_must_be_grouped_in_one_fragment() -> None:
    draft = _same_referent_draft("甲协会", "甲协")
    claims: list[SourceClaim] = []
    submission = ObjectFragmentSubmission(
        fragments=[
            ObjectFragmentDraft(fragment_key="F1", surface_forms=["甲协会"]),
            ObjectFragmentDraft(fragment_key="F2", surface_forms=["甲协"]),
        ],
        assertions=[],
    )
    with pytest.raises(ValueError, match="拆到不同 Fragment"):
        _validate_fragment_submission(
            submission,
            claims,
            same_referent_drafts=[draft],
            source_blocks=_blocks("甲协会，简称甲协。"),
        )


def test_fragment_can_extend_atomic_hint_with_source_local_reusable_name() -> None:
    draft = _same_referent_draft(
        "中国科学技术大学学生乒乓球协会",
        "USTC TTA",
    )
    claims = [_source_claim("claim-1", "乒协成立于2000年。")]
    submission = ObjectFragmentSubmission(
        fragments=[
            ObjectFragmentDraft(
                fragment_key="F1",
                surface_forms=[
                    "中国科学技术大学学生乒乓球协会",
                    "USTC TTA",
                    "乒协",
                ],
            )
        ],
        assertions=[
            FragmentAssertionTemplateDraft(
                claim_id="claim-1",
                statement_template_markdown="{{fragment:F1}}成立于2000年。",
            )
        ],
    )
    _validate_fragment_submission(
        submission,
        claims,
        same_referent_drafts=[draft],
        source_blocks=_blocks("中国科学技术大学学生乒乓球协会（USTC TTA）。之后乒协成立于2000年。"),
    )


def test_fragment_keeps_independent_full_and_short_names() -> None:
    claim = _source_claim("claim-1", "中国科学技术大学又称中国科大、中科大。")
    submission = ObjectFragmentSubmission(
        fragments=[
            ObjectFragmentDraft(
                fragment_key="F1",
                surface_forms=["中国科学技术大学", "中国科大", "中科大"],
            )
        ],
        assertions=[
            FragmentAssertionTemplateDraft(
                claim_id="claim-1",
                statement_template_markdown="{{fragment:F1}}又称中国科大、中科大。",
            )
        ],
    )

    _validate_fragment_submission(
        submission,
        [claim],
        source_blocks=_blocks(claim.statement_markdown),
    )


def test_fragment_rejects_generic_context_name_as_specific_object_alias() -> None:
    claim = _source_claim(
        "claim-1",
        "对各项目负责人充分赋权，推动负责人角色转向项目主理人。",
    )
    submission = ObjectFragmentSubmission(
        fragments=[
            ObjectFragmentDraft(
                fragment_key="F1",
                surface_forms=["项目负责人", "负责人"],
            )
        ],
        assertions=[
            FragmentAssertionTemplateDraft(
                claim_id="claim-1",
                statement_template_markdown=(
                    "对各{{fragment:F1}}充分赋权，推动{{fragment:F1}}角色转向项目主理人。"
                ),
            )
        ],
    )

    with pytest.raises(ValueError, match="泛称"):
        _validate_fragment_submission(
            submission,
            [claim],
            source_blocks=_blocks(claim.statement_markdown),
        )


def test_same_referent_draft_rejects_context_only_name() -> None:
    draft = _same_referent_draft("中国科学技术大学", "该校")

    with pytest.raises(ValueError, match="当前语境指代"):
        _validate_same_referent_drafts(
            [draft],
            _blocks("中国科学技术大学，以下简称该校。"),
        )


def test_same_referent_rejects_unknown_supporting_block() -> None:
    draft = _same_referent_draft("甲协会", "甲协", block_id="p9999-b0001")
    with pytest.raises(ValueError, match="当前来源之外的原文块"):
        _validate_same_referent_drafts([draft], _blocks("甲协会，简称甲协。"))


def test_same_referent_member_span_must_exist_in_source_blocks() -> None:
    draft = _same_referent_draft("甲协会", "不存在的简称")
    with pytest.raises(ValueError, match="不存在第 0 次出现"):
        _validate_same_referent_drafts([draft], _blocks("甲协会，简称甲协。"))


@pytest.mark.asyncio
async def test_incremental_review_does_not_duplicate_existing_claim(tmp_path: Path) -> None:
    duplicate = _json_turn(
        {
            "claims": [
                {
                    "statement_markdown": "继往开来杯过去通常申请两个场地。",
                    "supporting_block_ids": ["p0001-b0002"],
                    "context_dependent": False,
                }
            ]
        }
    )
    one_fragment = _json_turn(
        {
            "fragments": [{"fragment_key": "F1", "surface_forms": ["继往开来杯"]}],
            "assertions": [
                {
                    "claim_id": "claim-1",
                    "statement_template_markdown": ("{{fragment:F1}}过去通常申请两个场地。"),
                }
            ],
        }
    )
    snapshot = await SourceSemanticCompiler(
        model=FakeJsonModel([_initial_turn(), duplicate, _json_turn({"claims": []}), one_fragment]),
        exploration=_exploration(),
        blocks=_blocks(),
        paths=create_source_semantic_paths(tmp_path, "region-0002"),
    ).compile("region-0002")

    assert len(snapshot.assertions) == 1
    assert snapshot.review_addition_count == 0
    assert snapshot.model_calls == 4


def test_json_fence_normalization_is_strict_and_minimal() -> None:
    payload = '{"fragments":[],"assertions":[]}'
    assert normalize_json_fence(payload) == payload
    assert normalize_json_fence(f"```json\n{payload}\n```") == payload
    assert normalize_json_fence(f"```\n{payload}\n```") == payload
    prefixed = f"说明\n```json\n{payload}\n```"
    assert normalize_json_fence(prefixed) == prefixed
    with pytest.raises(ValueError):
        ObjectFragmentSubmission.model_validate_json(
            normalize_json_fence("{fragments:[],assertions:[]}")
        )


def test_missing_claim_schema_examples_match_strict_model() -> None:
    empty = MissingClaimSubmission.model_validate_json('{"claims":[]}')
    nonempty = MissingClaimSubmission.model_validate_json(
        '{"claims":[{"statement_markdown":"完整、内聚的知识单元",'
        '"supporting_block_ids":["p0001-b0001"],'
        '"context_dependent":false}]}'
    )

    assert empty.claims == []
    assert nonempty.claims[0].statement_markdown == "完整、内聚的知识单元"
    assert nonempty.claims[0].context_dependent is False
    assert '"statement_markdown": "完整、内聚的知识单元"' in MISSING_CLAIMS_SYSTEM_PROMPT
    assert '"supporting_block_ids": ["p0001-b0001"]' in MISSING_CLAIMS_SYSTEM_PROMPT
    assert '"context_dependent": false' in MISSING_CLAIMS_SYSTEM_PROMPT
    for forbidden in ("id", "claim_id", "text", "content", "source"):
        with pytest.raises(ValueError):
            MissingClaimSubmission.model_validate(
                {
                    "claims": [
                        {
                            "statement_markdown": "完整、内聚的知识单元",
                            "supporting_block_ids": ["p0001-b0001"],
                            "context_dependent": False,
                            forbidden: "不允许的字段",
                        }
                    ]
                }
            )


def test_atomic_prompt_requires_json_safe_quotes() -> None:
    assert "中文弯引号“”" in CLAIM_EXTRACTION_SYSTEM_PROMPT
    assert "ASCII 双引号" in CLAIM_EXTRACTION_SYSTEM_PROMPT
    assert '\\"' in CLAIM_EXTRACTION_SYSTEM_PROMPT
    assert "协会呈现“两极化”结构" in CLAIM_EXTRACTION_SYSTEM_PROMPT
    assert set(AtomicClaimSubmission.model_fields) == {
        "claims",
        "same_referent_drafts",
    }
    assert set(SameReferentDraft.model_fields) == {
        "mentions",
        "supporting_block_ids",
    }
    assert set(SameReferentMentionDraft.model_fields) == {
        "span_text",
        "occurrence_index",
    }
    assert "不得因为名称相似、常识" in CLAIM_EXTRACTION_SYSTEM_PROMPT
    assert "不得把“乒协”加入该草稿" in CLAIM_EXTRACTION_SYSTEM_PROMPT
    assert "25-26届会长深感有责任改变这一现状" in CLAIM_EXTRACTION_SYSTEM_PROMPT
    assert "不要默认按句、每个谓词、列表项或表格单元格切分" in CLAIM_EXTRACTION_SYSTEM_PROMPT
    assert "生命周期不同，应分开" in CLAIM_EXTRACTION_SYSTEM_PROMPT
    assert "Reference Assertion" in CLAIM_EXTRACTION_SYSTEM_PROMPT
    assert "不要为了关联成员而在 Reference 正文中逐一枚举" in CLAIM_EXTRACTION_SYSTEM_PROMPT
    dependent = AtomicClaimSubmission.model_validate(
        {
            "claims": [
                {
                    "statement_markdown": "25-26届会长深感有责任改变这一现状。",
                    "supporting_block_ids": ["p0001-b0001"],
                    "context_dependent": True,
                }
            ],
            "same_referent_drafts": [],
        }
    )
    assert dependent.claims[0].context_dependent is True
    with pytest.raises(ValueError):
        AtomicClaimSubmission.model_validate(
            {
                "claims": [
                    {
                        "statement_markdown": "缺少上下文标记。",
                        "supporting_block_ids": ["p0001-b0001"],
                    }
                ],
                "same_referent_drafts": [],
            }
        )


def test_fragment_prompt_defines_leaf_ir_without_global_identity() -> None:
    assert "ObjectFragment" in OBJECT_FRAGMENT_SYSTEM_PROMPT
    assert "reusable naming forms" in OBJECT_FRAGMENT_SYSTEM_PROMPT
    assert "hard grouping hint" in OBJECT_FRAGMENT_SYSTEM_PROMPT
    assert "{{fragment:F1}}" in OBJECT_FRAGMENT_SYSTEM_PROMPT
    assert "Global Object ID" in OBJECT_FRAGMENT_SYSTEM_PROMPT
    assert "reviewed/frozen claims" in OBJECT_FRAGMENT_SYSTEM_PROMPT
    assert "中文弯引号“”" in OBJECT_FRAGMENT_SYSTEM_PROMPT
    assert "未转义的 ASCII 双引号" in OBJECT_FRAGMENT_SYSTEM_PROMPT
    assert "不包括仅作为归属背景的组织" in OBJECT_FRAGMENT_SYSTEM_PROMPT
    assert "不要再加入“乒协”" in OBJECT_FRAGMENT_SYSTEM_PROMPT
    for removed in ("start", "end", "occurrence_index"):
        assert removed not in ObjectFragmentSubmission.model_json_schema()["properties"]


@pytest.mark.asyncio
async def test_case_a_keeps_a_multisentence_process_as_one_cohesive_assertion(
    tmp_path: Path,
) -> None:
    process = (
        "报名截止后应完成名单核验和抽签；如果存在临时退赛，应先处理人员变化，"
        "再生成最终赛程，避免赛程发布后二次大规模调整。"
    )
    model = FakeJsonModel(
        [
            _initial_turn(statement=process),
            _json_turn({"claims": []}),
            _json_turn(
                {
                    "fragments": [],
                    "assertions": [
                        {
                            "claim_id": "claim-1",
                            "kind": "grounded",
                            "statement_template_markdown": process,
                            "semantic_fragment_keys": [],
                        }
                    ],
                }
            ),
        ]
    )

    snapshot = await SourceSemanticCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(process),
        paths=create_source_semantic_paths(tmp_path, "region-0002"),
    ).compile("region-0002")

    assert [item.statement_template_markdown for item in snapshot.assertions] == [process]
    discovery_prompt = str(model.calls[0]["messages"][0]["content"])
    assert "流程步骤链" in discovery_prompt
    assert "不要默认按句" in discovery_prompt


@pytest.mark.parametrize(
    "statement",
    [
        "探索期组织随人员变动频繁调整；稳定期（2020年至今）形成扁平化架构。",
        "当前传承主要依赖口头传授；24-25学年曾因交接缺失导致年审扣分。",
        "大型赛事必须在活动前至少7天提交申请。",
    ],
)
@pytest.mark.asyncio
async def test_time_context_remains_in_assertion_body_without_metadata(
    tmp_path: Path,
    statement: str,
) -> None:
    model = FakeJsonModel(
        [
            _initial_turn(statement=statement),
            _json_turn({"claims": []}),
            _json_turn(
                {
                    "fragments": [],
                    "assertions": [
                        {
                            "claim_id": "claim-1",
                            "kind": "grounded",
                            "statement_template_markdown": statement,
                            "semantic_fragment_keys": [],
                        }
                    ],
                }
            ),
        ]
    )

    snapshot = await SourceSemanticCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(statement),
        paths=create_source_semantic_paths(tmp_path, "region-0002"),
    ).compile("region-0002")

    assert snapshot.assertions[0].statement_template_markdown == statement
    assert "temporal" not in snapshot.assertions[0].model_dump()


@pytest.mark.asyncio
async def test_case_b_prompt_and_protocol_split_different_lifecycles(
    tmp_path: Path,
) -> None:
    source = "四国大战是团体赛，通常秋季举办，本届负责人是张三。"
    first_turn = _json_turn(
        {
            "claims": [
                {
                    "kind": "grounded",
                    "statement_markdown": "四国大战是团体赛，通常秋季举办。",
                    "supporting_block_ids": ["p0001-b0002"],
                    "context_dependent": False,
                },
                {
                    "kind": "grounded",
                    "statement_markdown": "四国大战本届负责人是张三。",
                    "supporting_block_ids": ["p0001-b0002"],
                    "context_dependent": False,
                },
            ],
            "same_referent_drafts": [],
        }
    )
    fragment_turn = _json_turn(
        {
            "fragments": [
                {"fragment_key": "F1", "surface_forms": ["四国大战"]},
                {"fragment_key": "F2", "surface_forms": ["张三"]},
            ],
            "assertions": [
                {
                    "claim_id": "claim-1",
                    "kind": "grounded",
                    "statement_template_markdown": "{{fragment:F1}}是团体赛，通常秋季举办。",
                    "semantic_fragment_keys": [],
                },
                {
                    "claim_id": "claim-2",
                    "kind": "grounded",
                    "statement_template_markdown": "{{fragment:F1}}本届负责人是{{fragment:F2}}。",
                    "semantic_fragment_keys": [],
                },
            ],
        }
    )
    model = FakeJsonModel([first_turn, _json_turn({"claims": []}), fragment_turn])

    snapshot = await SourceSemanticCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(source),
        paths=create_source_semantic_paths(tmp_path, "region-0002"),
    ).compile("region-0002")

    assert len(snapshot.assertions) == 2
    assert "本届负责人" not in snapshot.assertions[0].statement_template_markdown
    assert "本届负责人" in snapshot.assertions[1].statement_template_markdown
    assert "生命周期不同，应分开" in str(model.calls[0]["messages"][0]["content"])


def _source_claim(
    claim_id: str,
    statement: str,
    *,
    kind: AssertionKind = "grounded",
) -> SourceClaim:
    return SourceClaim(
        claim_id=claim_id,
        kind=kind,
        statement_markdown=statement,
        supporting_block_ids=["p0001-b0002"],
        context_dependent=False,
    )


def test_case_c_reference_uses_semantic_links_without_object_mentions() -> None:
    event_names = ["继往开来", "四国大战", "萍水相逢", "会员大赛", "院系杯"]
    claim = _source_claim(
        "claim-1",
        "乒协主要品牌赛事的名称、比赛形式和基本定位集中记录于“品牌活动”表格。",
        kind="reference",
    )
    submission = ObjectFragmentSubmission(
        fragments=[
            ObjectFragmentDraft(fragment_key=f"F{index}", surface_forms=[name])
            for index, name in enumerate(event_names, start=1)
        ],
        assertions=[
            FragmentAssertionTemplateDraft(
                claim_id="claim-1",
                kind="reference",
                statement_template_markdown=claim.statement_markdown,
                semantic_fragment_keys=[f"F{index}" for index in range(1, 6)],
            )
        ],
    )
    blocks = _blocks("｜".join(event_names))

    _validate_fragment_submission(submission, [claim], source_blocks=blocks)
    fragments, assertions = _materialize_fragments(
        submission, [claim], source_region_id="region-0002"
    )

    assert assertions[0].kind == "reference"
    assert assertions[0].statement_template_markdown == claim.statement_markdown
    assert all(name not in assertions[0].statement_template_markdown for name in event_names)
    assert assertions[0].semantic_fragment_ids == [fragment.fragment_id for fragment in fragments]
    assert assertions[0].supporting_block_ids == ["p0001-b0002"]


def test_case_d_grounded_assertion_keeps_anchored_reference_validation() -> None:
    claim = _source_claim("claim-1", "继往开来是换届传承活动。")
    with pytest.raises(ValueError, match="grounded Assertion，不能使用 semantic links"):
        _validate_fragment_submission(
            ObjectFragmentSubmission(
                fragments=[ObjectFragmentDraft(fragment_key="F1", surface_forms=["继往开来"])],
                assertions=[
                    FragmentAssertionTemplateDraft(
                        claim_id="claim-1",
                        kind="grounded",
                        statement_template_markdown="{{fragment:F1}}是换届传承活动。",
                        semantic_fragment_keys=["F1"],
                    )
                ],
            ),
            [claim],
            source_blocks=_blocks("继往开来是换届传承活动。"),
        )

    with pytest.raises(ValueError, match="不存在的 Fragment"):
        _validate_fragment_submission(
            ObjectFragmentSubmission(
                fragments=[],
                assertions=[
                    FragmentAssertionTemplateDraft(
                        claim_id="claim-1",
                        statement_template_markdown="{{fragment:F9}}是换届传承活动。",
                    )
                ],
            ),
            [claim],
            source_blocks=_blocks("继往开来是换届传承活动。"),
        )


def test_related_roles_remain_distinct_fragments() -> None:
    claims = [_source_claim("claim-1", "副会长协助会长工作。")]
    submission = ObjectFragmentSubmission(
        fragments=[
            ObjectFragmentDraft(fragment_key="F1", surface_forms=["副会长"]),
            ObjectFragmentDraft(fragment_key="F2", surface_forms=["会长"]),
        ],
        assertions=[
            FragmentAssertionTemplateDraft(
                claim_id="claim-1",
                statement_template_markdown="{{fragment:F1}}协助{{fragment:F2}}工作。",
            )
        ],
    )
    _validate_fragment_submission(
        submission,
        claims,
        source_blocks=_blocks("副会长协助会长工作。"),
    )
    fragments, assertions = _materialize_fragments(
        submission, claims, source_region_id="region-0002"
    )
    assert [item.surface_forms for item in fragments] == [["副会长"], ["会长"]]
    assert assertions[0].statement_template_markdown == (
        "{{fragment:fragment-1}}协助{{fragment:fragment-2}}工作。"
    )


def test_non_reusable_pronouns_are_not_required_surface_forms() -> None:
    claims = [_source_claim("claim-1", "该协会支持这项活动。")]
    submission = ObjectFragmentSubmission(
        fragments=[],
        assertions=[
            FragmentAssertionTemplateDraft(
                claim_id="claim-1",
                statement_template_markdown="该协会支持这项活动。",
            )
        ],
    )
    _validate_fragment_submission(
        submission,
        claims,
        source_blocks=_blocks("该协会支持这项活动。"),
    )


@pytest.mark.asyncio
async def test_unknown_fragment_reference_gets_one_clean_retry(tmp_path: Path) -> None:
    invalid_fragments = _json_turn(
        {
            "fragments": [{"fragment_key": "F1", "surface_forms": ["副会长"]}],
            "assertions": [
                {
                    "claim_id": "claim-1",
                    "statement_template_markdown": ("{{fragment:F1}}协助{{fragment:F2}}工作。"),
                }
            ],
        }
    )
    corrected_fragments = _json_turn(
        {
            "fragments": [
                {"fragment_key": "F1", "surface_forms": ["副会长"]},
                {"fragment_key": "F2", "surface_forms": ["会长"]},
            ],
            "assertions": [
                {
                    "claim_id": "claim-1",
                    "statement_template_markdown": ("{{fragment:F1}}协助{{fragment:F2}}工作。"),
                }
            ],
        }
    )
    model = FakeJsonModel(
        [
            _initial_turn(statement="副会长协助会长完成重大决策。"),
            _json_turn({"claims": []}),
            invalid_fragments,
            corrected_fragments,
        ]
    )

    snapshot = await SourceSemanticCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks("副会长协助会长完成重大决策。"),
        paths=create_source_semantic_paths(tmp_path, "region-0002"),
    ).compile("region-0002")

    assert snapshot.model_calls == 4
    retry_system = str(model.calls[3]["messages"][0]["content"])
    assert "不存在的 Fragment" in retry_system


def test_fragment_template_does_not_require_reverse_rendering() -> None:
    claims = [
        _source_claim("claim-1", "继往开来杯通常申请两个场地。"),
    ]
    submission = ObjectFragmentSubmission(
        fragments=[ObjectFragmentDraft(fragment_key="F1", surface_forms=["继往开来杯"])],
        assertions=[
            FragmentAssertionTemplateDraft(
                claim_id="claim-1",
                statement_template_markdown="通常为{{fragment:F1}}申请两个场地。",
            )
        ],
    )
    _validate_fragment_submission(
        submission,
        claims,
        source_blocks=_blocks("继往开来杯通常申请两个场地。"),
    )
    _, assertions = _materialize_fragments(submission, claims, source_region_id="region-0002")
    assert assertions[0].statement_template_markdown == (
        "通常为{{fragment:fragment-1}}申请两个场地。"
    )


def test_fragment_submission_rejects_unknown_reference_and_ungrounded_alias() -> None:
    claims = [_source_claim("claim-1", "甲协会成立。")]
    with pytest.raises(ValueError, match="不存在的 Fragment"):
        _validate_fragment_submission(
            ObjectFragmentSubmission(
                fragments=[],
                assertions=[
                    FragmentAssertionTemplateDraft(
                        claim_id="claim-1",
                        statement_template_markdown="{{fragment:F9}}成立。",
                    )
                ],
            ),
            claims,
            source_blocks=_blocks("甲协会成立。"),
        )


def test_fragment_checkpoint_uses_stable_ids_without_mention_coordinates() -> None:
    claims = [_source_claim("claim-1", "甲协会成立。")]
    submission = ObjectFragmentSubmission(
        fragments=[ObjectFragmentDraft(fragment_key="F1", surface_forms=["甲协会"])],
        assertions=[
            FragmentAssertionTemplateDraft(
                claim_id="claim-1",
                statement_template_markdown="{{fragment:F1}}成立。",
            )
        ],
    )
    fragments, assertions = _materialize_fragments(
        submission, claims, source_region_id="region-0002"
    )
    checkpoint = SourceObjectFragmentCheckpoint(
        source_sha256="a" * 64,
        region_node_id="region-0002",
        fragments=fragments,
        assertions=assertions,
        model_calls=1,
    )
    _validate_fragment_checkpoint(
        checkpoint,
        claims,
        source_blocks=_blocks("甲协会成立。"),
    )
    assert checkpoint.schema_version == "source-object-fragments.v5"
    assert set(checkpoint.fragments[0].model_dump()) == {
        "fragment_id",
        "source_region_id",
        "surface_forms",
    }
    with pytest.raises(ValueError, match="未在当前 SourceRegion"):
        _validate_fragment_submission(
            ObjectFragmentSubmission(
                fragments=[
                    ObjectFragmentDraft(fragment_key="F1", surface_forms=["系统发明的别名"])
                ],
                assertions=[
                    FragmentAssertionTemplateDraft(
                        claim_id="claim-1",
                        statement_template_markdown="甲协会成立。",
                    )
                ],
            ),
            claims,
            source_blocks=_blocks("甲协会成立。"),
        )


def test_fragment_surface_form_can_be_grounded_by_frozen_claim() -> None:
    claims = [_source_claim("claim-1", "协会获评三星级社团。")]
    submission = ObjectFragmentSubmission(
        fragments=[ObjectFragmentDraft(fragment_key="F1", surface_forms=["协会"])],
        assertions=[
            FragmentAssertionTemplateDraft(
                claim_id="claim-1",
                statement_template_markdown="{{fragment:F1}}获评三星级社团。",
            )
        ],
    )
    source_blocks = _blocks("社团评级：三星级社团。")

    _validate_fragment_submission(
        submission,
        claims,
        source_blocks=source_blocks,
    )
    fragments, assertions = _materialize_fragments(
        submission, claims, source_region_id="region-0002"
    )
    checkpoint = SourceObjectFragmentCheckpoint(
        source_sha256="a" * 64,
        region_node_id="region-0002",
        fragments=fragments,
        assertions=assertions,
        model_calls=1,
    )
    _validate_fragment_checkpoint(
        checkpoint,
        claims,
        source_blocks=source_blocks,
    )


def test_source_time_is_grounded_and_null_has_no_evidence() -> None:
    blocks = _blocks("署于 2026 年春。")
    grounded = SourceTimeSubmission(
        source_time_text="2026 年春",
        supporting_block_ids=["p0001-b0002"],
    )
    assert grounded.source_time_text == "2026年春"
    _validate_source_time(grounded, blocks)

    western = SourceTimeSubmission(
        source_time_text="March 2026",
        supporting_block_ids=["p0001-b0002"],
    )
    assert western.source_time_text == "March 2026"
    _validate_source_time(western, _blocks("Signed March 2026."))

    unknown = SourceTimeSubmission(
        source_time_text=None,
        supporting_block_ids=[],
    )
    _validate_source_time(unknown, blocks)
    assert "不是 Assertion validity" in SOURCE_TIME_SYSTEM_PROMPT
    assert "正文事件的最大年份" in SOURCE_TIME_SYSTEM_PROMPT


def test_source_time_rejects_inferred_or_unknown_evidence() -> None:
    with pytest.raises(ValueError, match="直接找到"):
        _validate_source_time(
            SourceTimeSubmission(
                source_time_text="2025年",
                supporting_block_ids=["p0001-b0002"],
            ),
            _blocks("协会于2024年成立。"),
        )
    with pytest.raises(ValueError, match="不存在的 SourceBlock"):
        _validate_source_time(
            SourceTimeSubmission(
                source_time_text="2026年春",
                supporting_block_ids=["p9999-b9999"],
            ),
            _blocks("署于2026年春。"),
        )


def test_fragment_rejects_self_identity_alias_collapse() -> None:
    claim = _source_claim("claim-1", "25-26学年乒协会长为魏汉东，署于2026年春。")
    collapsed = ObjectFragmentSubmission(
        fragments=[
            ObjectFragmentDraft(
                fragment_key="F1",
                surface_forms=["25-26学年乒协会长", "魏汉东"],
            )
        ],
        assertions=[
            FragmentAssertionTemplateDraft(
                claim_id="claim-1",
                statement_template_markdown=("{{fragment:F1}}为{{fragment:F1}}，署于2026年春。"),
            )
        ],
    )
    with pytest.raises(ValueError, match="self-identity"):
        _validate_fragment_submission(
            collapsed,
            [claim],
            source_blocks=_blocks(claim.statement_markdown),
        )


def test_invalid_fragment_checkpoint_is_treated_as_stage_cache_miss(
    tmp_path: Path,
) -> None:
    claim = _source_claim(
        "claim-1",
        "25-26学年乒协会长为魏汉东，署于2026年春。",
    )
    collapsed = ObjectFragmentSubmission(
        fragments=[
            ObjectFragmentDraft(
                fragment_key="F1",
                surface_forms=["25-26学年乒协会长", "魏汉东"],
            )
        ],
        assertions=[
            FragmentAssertionTemplateDraft(
                claim_id="claim-1",
                statement_template_markdown=("{{fragment:F1}}为{{fragment:F1}}，署于2026年春。"),
            )
        ],
    )
    fragments, assertions = _materialize_fragments(
        collapsed,
        [claim],
        source_region_id="region-0002",
    )
    checkpoint = SourceObjectFragmentCheckpoint(
        source_sha256="a" * 64,
        region_node_id="region-0002",
        fragments=fragments,
        assertions=assertions,
        model_calls=1,
    )
    paths = create_source_semantic_paths(tmp_path, "region-0002")
    paths.object_fragments_json.write_text(checkpoint.model_dump_json(indent=2), encoding="utf-8")
    compiler = SourceSemanticCompiler(
        model=FakeJsonModel([]),
        exploration=_exploration(),
        blocks=_blocks(claim.statement_markdown),
        paths=paths,
    )
    assert (
        compiler._load_object_fragments_checkpoint(
            compiler.nodes["region-0002"],
            [claim],
            [],
            _blocks(claim.statement_markdown),
        )
        is None
    )


def test_missing_review_rejects_covered_list_item_but_keeps_new_exception() -> None:
    existing = [
        _source_claim(
            "claim-1",
            "治理转型包括去中心化、资产化传承和梯队建设。",
        )
    ]
    with pytest.raises(ValueError, match="明确覆盖"):
        _validate_missing_claims(
            MissingClaimSubmission(
                claims=[
                    {
                        "statement_markdown": "资产化传承",
                        "supporting_block_ids": ["p0001-b0002"],
                        "context_dependent": False,
                    }
                ]
            ),
            existing,
            _blocks(existing[0].statement_markdown),
        )
    _validate_missing_claims(
        MissingClaimSubmission(
            claims=[
                {
                    "statement_markdown": "资产化传承不适用于个人隐私档案。",
                    "supporting_block_ids": ["p0001-b0002"],
                    "context_dependent": False,
                }
            ]
        ),
        existing,
        _blocks(existing[0].statement_markdown),
    )


@pytest.mark.asyncio
async def test_v3_initial_checkpoint_restarts_for_v8_semantics(
    tmp_path: Path,
) -> None:
    paths = create_source_semantic_paths(tmp_path, "region-0002")
    paths.initial_claims_json.write_text(
        json.dumps(
            {
                "schema_version": "source-claims.v3",
                "source_sha256": "a" * 64,
                "region_node_id": "region-0002",
                "claims": [],
                "model_calls": 1,
            }
        ),
        encoding="utf-8",
    )
    model = FakeJsonModel(
        [
            _initial_turn(),
            _json_turn({"claims": []}),
            _one_fragment_turn(),
        ]
    )
    snapshot = await SourceSemanticCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=paths,
    ).compile("region-0002")

    assert len(model.calls) == 3
    assert str(model.calls[0]["request_label"]).endswith("Assertion Discovery")
    assert snapshot.schema_version == "source-semantics.v9"
    initial = json.loads(paths.initial_claims_json.read_text(encoding="utf-8"))
    assert initial["schema_version"] == "source-claims.v7"


@pytest.mark.asyncio
async def test_stage_uses_one_clean_retry_without_bad_output_history(tmp_path: Path) -> None:
    invalid = ModelTurn(content='{"claims": [', reasoning_content="错误思考")
    model = FakeJsonModel(
        [
            invalid,
            _initial_turn(),
            _json_turn({"claims": []}),
            _one_fragment_turn(),
        ]
    )
    snapshot = await SourceSemanticCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=create_source_semantic_paths(tmp_path, "region-0002"),
    ).compile("region-0002")

    assert snapshot.model_calls == 4
    assert len(model.calls) == 4
    first_messages = model.calls[0]["messages"]
    retry_messages = model.calls[1]["messages"]
    assert [item["role"] for item in retry_messages] == ["system", "user"]
    assert retry_messages[1] == first_messages[1]
    assert "错误思考" not in str(retry_messages)
    assert '{"claims": [' not in str(retry_messages)
    assert "上一次提交未通过确定性校验" in str(retry_messages[0]["content"])
    assert "请仅根据原始输入重新生成一次" in str(retry_messages[0]["content"])
    assert str(model.calls[1]["request_label"]).endswith("clean-retry")
    assert "Atomic-Conservative-Fallback" not in str(model.calls[1])


@pytest.mark.asyncio
async def test_atomic_schema_failure_uses_normal_clean_retry(tmp_path: Path) -> None:
    invalid_schema = _json_turn(
        {
            "claims": [
                {
                    "statement_markdown": "继往开来杯过去通常申请两个场地。",
                    "supporting_block_ids": ["p0001-b0002"],
                    "context_dependent": False,
                    "text": "不允许的字段",
                }
            ]
        }
    )
    model = FakeJsonModel(
        [
            invalid_schema,
            _initial_turn(),
            _json_turn({"claims": []}),
            _one_fragment_turn(),
        ]
    )

    snapshot = await SourceSemanticCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=create_source_semantic_paths(tmp_path, "region-0002"),
    ).compile("region-0002")

    assert snapshot.model_calls == 4
    assert str(model.calls[1]["request_label"]).endswith("clean-retry")
    assert "Atomic-Conservative-Fallback" not in str(model.calls[1])


@pytest.mark.asyncio
async def test_atomic_block_validation_failure_uses_normal_clean_retry(
    tmp_path: Path,
) -> None:
    invalid_block = _json_turn(
        {
            "claims": [
                {
                    "statement_markdown": "继往开来杯过去通常申请两个场地。",
                    "supporting_block_ids": ["p9999-b9999"],
                    "context_dependent": False,
                }
            ]
        }
    )
    model = FakeJsonModel(
        [
            invalid_block,
            _initial_turn(),
            _json_turn({"claims": []}),
            _one_fragment_turn(),
        ]
    )

    snapshot = await SourceSemanticCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=create_source_semantic_paths(tmp_path, "region-0002"),
    ).compile("region-0002")

    assert snapshot.model_calls == 4
    retry_system = str(model.calls[1]["messages"][0]["content"])
    assert "p9999-b9999" in retry_system
    assert str(model.calls[1]["request_label"]).endswith("clean-retry")
    assert "Atomic-Conservative-Fallback" not in str(model.calls[1])


@pytest.mark.asyncio
async def test_atomic_repetition_uses_clean_conservative_fallback(
    tmp_path: Path,
) -> None:
    paths = create_source_semantic_paths(tmp_path, "region-0002")
    model = FakeJsonModel(
        [
            ModelRepetitionError("模型循环片段：绝不能进入下一次上下文"),
            _initial_turn(),
            _json_turn({"claims": []}),
            _one_fragment_turn(),
        ]
    )
    snapshot = await SourceSemanticCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=paths,
    ).compile("region-0002")

    assert snapshot.model_calls == 4
    assert len(model.calls[1]["messages"]) == 2
    assert model.calls[1]["messages"][1] == model.calls[0]["messages"][1]
    fallback_system = str(model.calls[1]["messages"][0]["content"])
    assert fallback_system == CONSERVATIVE_ATOMIC_FALLBACK_SYSTEM_PROMPT
    assert "上一轮来源语义推理发生重复" in fallback_system
    assert "绝不能进入下一次上下文" not in str(model.calls[1]["messages"])
    assert "Atomic-Conservative-Fallback" in str(model.calls[1]["request_label"])
    assert paths.initial_claims_json.exists()


@pytest.mark.asyncio
async def test_atomic_fallback_failure_is_not_retried(tmp_path: Path) -> None:
    paths = create_source_semantic_paths(tmp_path, "region-0002")
    model = FakeJsonModel(
        [
            ModelRepetitionError("第一次 Atomic reasoning 重复"),
            ModelTurn(content="{", reasoning_content="fallback 输出失败"),
        ]
    )

    with pytest.raises(ValueError, match=r"Atomic-Conservative-Fallback.*不再重试"):
        await SourceSemanticCompiler(
            model=model,
            exploration=_exploration(),
            blocks=_blocks(),
            paths=paths,
        ).compile("region-0002")

    assert len(model.calls) == 2
    assert "Atomic-Conservative-Fallback" in str(model.calls[1]["request_label"])
    assert not paths.initial_claims_json.exists()


def test_conservative_atomic_fallback_prompt_has_bounded_semantics() -> None:
    prompt = CONSERVATIVE_ATOMIC_FALLBACK_SYSTEM_PROMPT
    assert "不追求最小粒度" in prompt
    assert "保留较完整、较接近原文的表达" in prompt
    assert "不要返回已经处理过的 block" in prompt
    assert "不做第二轮全局检查" in prompt
    assert "处理完最后一个 block 后立即提交" in prompt
    assert "遗漏事实由后续 Missing" in prompt
    assert "组织架构不合理、经验传承断层" in prompt
    assert "记录→提供参考→终结失忆" in prompt
    assert '\\"' in prompt


@pytest.mark.asyncio
async def test_stage_failure_stops_after_one_retry(tmp_path: Path) -> None:
    paths = create_source_semantic_paths(tmp_path, "region-0002")
    model = FakeJsonModel([ModelTurn(content="{"), ModelTurn(content='{"claims": [}')])
    with pytest.raises(ValueError, match="clean retry 均失败"):
        await SourceSemanticCompiler(
            model=model,
            exploration=_exploration(),
            blocks=_blocks(),
            paths=paths,
        ).compile("region-0002")

    assert len(model.calls) == 2
    assert not paths.initial_claims_json.exists()


class BatchJsonModel:
    def __init__(self, *, fail_fragments_node: str | None = None) -> None:
        self.fail_fragments_node = fail_fragments_node
        self.calls: list[str] = []

    async def complete_turn(
        self,
        *,
        messages: Sequence[Mapping[str, Any]],
        tools: Sequence[Mapping[str, Any]] = (),
        tool_choice: object | None = None,
        temperature: float | None = None,
        request_label: str = "模型",
        thinking: ThinkingMode | None = None,
    ) -> ModelTurn:
        del messages, tools, tool_choice, temperature, thinking
        self.calls.append(request_label)
        if request_label == "Source Time":
            return _json_turn({"source_time_text": None, "supporting_block_ids": []})
        node_id = "region-0002" if "region-0002" in request_label else "region-0003"
        block_id = "p0001-b0002" if node_id == "region-0002" else "p0001-b0003"
        label = "继往开来杯" if node_id == "region-0002" else "会员大会"
        if request_label.endswith("Assertion Discovery"):
            return _json_turn(
                {
                    "claims": [
                        {
                            "statement_markdown": f"{label}每学年举办一次。",
                            "supporting_block_ids": [block_id],
                            "context_dependent": False,
                        }
                    ]
                }
            )
        if request_label.endswith("遗漏扫描"):
            return _json_turn({"claims": []})
        if "Object Fragment Construction" in request_label:
            surface_form = "不存在的字面" if self.fail_fragments_node == node_id else label
            return _json_turn(
                {
                    "fragments": [
                        {
                            "fragment_key": "F1",
                            "surface_forms": [surface_form],
                        }
                    ],
                    "assertions": [
                        {
                            "claim_id": "claim-1",
                            "statement_template_markdown": ("{{fragment:F1}}每学年举办一次。"),
                        }
                    ],
                }
            )
        raise AssertionError(f"未预期的模型调用：{request_label}")


def _batch_blocks() -> tuple[ParsedBlock, ...]:
    return (
        *_blocks(),
        ParsedBlock(
            block_id="p0001-b0003",
            order=2,
            block_type="paragraph",
            source_pages=(1,),
            heading_path=("会员大会",),
            markdown="会员大会每学年举办一次。",
        ),
    )


def _batch_exploration() -> GlobalExplorationSnapshot:
    base = _exploration()
    root = base.region_tree.nodes[0].model_copy(
        update={
            "end_block_id": "p0001-b0003",
            "child_ids": ["region-0002", "region-0003"],
        }
    )
    second = RegionNode(
        node_id="region-0003",
        parent_id="region-0001",
        depth=1,
        label="会员大会",
        introduction="介绍会员大会频率。",
        start_block_id="p0001-b0003",
        end_block_id="p0001-b0003",
        source_pages=[1],
        status="leaf",
        owned_segments=[
            SourceSegment(
                start_block_id="p0001-b0003",
                end_block_id="p0001-b0003",
            )
        ],
        owned_source_role="content_source",
    )
    return base.model_copy(
        update={
            "source": base.source.model_copy(update={"block_count": 3}),
            "region_tree": base.region_tree.model_copy(
                update={
                    "nodes": [root, base.region_tree.nodes[1], second],
                    "leaf_node_ids": ["region-0002", "region-0003"],
                    "content_node_ids": ["region-0002", "region-0003"],
                }
            ),
        }
    )


@pytest.mark.asyncio
async def test_batch_compiles_all_sources_and_writes_stage_index(tmp_path: Path) -> None:
    paths = create_full_source_semantic_paths(tmp_path)
    model = BatchJsonModel()

    snapshot = await FullSourceSemanticRunner(
        model=model,
        exploration=_batch_exploration(),
        blocks=_batch_blocks(),
        paths=paths,
        max_parallel_sources=1,
    ).run()

    assert snapshot.source_node_ids == ["region-0002", "region-0003"]
    assert snapshot.total_assertions == 2
    assert snapshot.total_object_fragments == 2
    assert snapshot.total_surface_forms == 2
    assert snapshot.model_calls == 7
    assert len(model.calls) == 7
    assert snapshot.source_time_text is None
    assert paths.source_time_json.exists()
    working = json.loads(paths.working_json.read_text(encoding="utf-8"))
    assert all(item["complete"] for item in working["stages"])
    assert all(item["object_fragments"] for item in working["stages"])
    assert working["source_time"] is True
    for node_id in snapshot.source_node_ids:
        source = paths.sources / node_id
        assert (source / "01-initial-claims.json").exists()
        assert (source / "02-reviewed-claims.json").exists()
        assert (source / "03-object-fragments.json").exists()
        assert (source / "source-semantics.json").exists()


@pytest.mark.asyncio
async def test_batch_exposes_stable_completed_prefix_before_final_snapshot(
    tmp_path: Path,
) -> None:
    available: list[tuple[list[str], list[str], bool]] = []

    async def on_available(
        snapshot: FullSourceSemanticSnapshot,
        complete: bool,
    ) -> None:
        available.append(
            (
                list(snapshot.source_node_ids),
                [item.region_node_id for item in snapshot.sources],
                complete,
            )
        )

    await FullSourceSemanticRunner(
        model=BatchJsonModel(),
        exploration=_batch_exploration(),
        blocks=_batch_blocks(),
        paths=create_full_source_semantic_paths(tmp_path),
        max_parallel_sources=1,
        on_available=on_available,
    ).run()

    assert available == [
        (["region-0002", "region-0003"], ["region-0002"], False),
        (
            ["region-0002", "region-0003"],
            ["region-0002", "region-0003"],
            False,
        ),
        (
            ["region-0002", "region-0003"],
            ["region-0002", "region-0003"],
            True,
        ),
    ]


@pytest.mark.asyncio
async def test_batch_can_filter_sources_without_changing_stage_flow(tmp_path: Path) -> None:
    model = BatchJsonModel()
    snapshot = await FullSourceSemanticRunner(
        model=model,
        exploration=_batch_exploration(),
        blocks=_batch_blocks(),
        paths=create_full_source_semantic_paths(tmp_path),
        max_parallel_sources=1,
        source_node_ids=["region-0003"],
    ).run()

    assert snapshot.source_node_ids == ["region-0003"]
    assert len(model.calls) == 4
    assert model.calls[0] == "Source Time"
    assert all("region-0003" in label for label in model.calls[1:])


@pytest.mark.asyncio
async def test_batch_resume_only_retries_failed_source_stage(tmp_path: Path) -> None:
    paths = create_full_source_semantic_paths(tmp_path)
    runner = FullSourceSemanticRunner(
        model=BatchJsonModel(fail_fragments_node="region-0003"),
        exploration=_batch_exploration(),
        blocks=_batch_blocks(),
        paths=paths,
        max_parallel_sources=1,
    )

    with pytest.raises(RuntimeError, match="region-0003"):
        await runner.run()

    failed = paths.sources / "region-0003"
    assert (failed / "01-initial-claims.json").exists()
    assert (failed / "02-reviewed-claims.json").exists()
    assert not (failed / "03-object-fragments.json").exists()
    assert (paths.sources / "region-0002" / "source-semantics.json").exists()

    resumed_model = BatchJsonModel()
    snapshot = await FullSourceSemanticRunner(
        model=resumed_model,
        exploration=_batch_exploration(),
        blocks=_batch_blocks(),
        paths=open_full_source_semantic_paths(paths.directory),
        max_parallel_sources=1,
    ).run()

    assert len(resumed_model.calls) == 1
    assert resumed_model.calls[0].endswith("region-0003·Object Fragment Construction")
    assert len(snapshot.sources) == 2
