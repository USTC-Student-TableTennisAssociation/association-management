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
    OBJECT_MENTION_SYSTEM_PROMPT,
    TEMPORAL_ANNOTATION_SYSTEM_PROMPT,
    AtomicClaimSubmission,
    FullSourceSemanticRunner,
    ObjectMentionDraft,
    ObjectMentionSubmission,
    SourceClaim,
    SourceSemanticCompiler,
    TemporalAnnotation,
    TemporalAnnotationSubmission,
    TemporalClaimAnnotations,
    _attach_temporal_annotations,
    _materialize_mentions,
    _validate_temporal_submission,
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


def _initial_turn(*, statement: str = "继往开来杯过去通常申请两个场地。") -> ModelTurn:
    return _json_turn(
        {
            "claims": [
                {
                    "statement_markdown": statement,
                    "supporting_block_ids": ["p0001-b0002"],
                }
            ]
        }
    )


def _review_turn() -> ModelTurn:
    return _json_turn(
        {
            "claims": [
                {
                    "statement_markdown": "大型比赛必须提前申请场地。",
                    "supporting_block_ids": ["p0001-b0002"],
                }
            ]
        }
    )


def _mention_turn() -> ModelTurn:
    return _json_turn(
        {
            "mentions": [
                {
                    "claim_id": "claim-1",
                    "span_text": "继往开来杯",
                    "occurrence_index": 0,
                },
                {
                    "claim_id": "claim-2",
                    "span_text": "大型比赛",
                    "occurrence_index": 0,
                },
            ],
        }
    )


def _temporal_turn(
    *claim_ids: str,
    annotations: Mapping[str, list[dict[str, object]]] | None = None,
) -> ModelTurn:
    annotations = annotations or {}
    return _json_turn(
        {
            "claims": [
                {
                    "claim_id": claim_id,
                    "temporal_annotations": annotations.get(claim_id, []),
                }
                for claim_id in claim_ids
            ]
        }
    )


def _blocks() -> tuple[ParsedBlock, ...]:
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
            markdown="继往开来杯过去通常申请两个场地。大型比赛必须提前申请场地。",
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
async def test_compiles_four_direct_json_stages(tmp_path: Path) -> None:
    paths = create_source_semantic_paths(tmp_path, "region-0002")
    model = FakeJsonModel(
        [
            _initial_turn(),
            _review_turn(),
            _mention_turn(),
            _temporal_turn("claim-1", "claim-2"),
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
    assert snapshot.model_calls == 4
    assert [item.claim_id for item in snapshot.assertions] == ["claim-1", "claim-2"]
    assert snapshot.assertions[0].statement_template_markdown.startswith(
        "{{object:obj-1}}"
    )
    assert [item.object_id for item in snapshot.objects] == ["obj-1", "obj-2"]
    assert [item.span_text for item in snapshot.object_mentions] == [
        "继往开来杯",
        "大型比赛",
    ]
    assert set(snapshot.objects[0].model_dump()) == {"object_id", "label", "aliases"}
    assert paths.initial_claims_json.exists()
    assert paths.reviewed_claims_json.exists()
    assert paths.object_mentions_json.exists()
    assert paths.temporal_annotations_json.exists()
    assert paths.snapshot_json.exists()
    assert paths.report_markdown.exists()

    assert len(model.calls) == 4
    assert all(call["thinking"] == "enabled" for call in model.calls)
    assert all(call["temperature"] is None for call in model.calls)
    assert all(call["tools"] == () for call in model.calls)
    assert all(call["tool_choice"] is None for call in model.calls)
    assert all(
        "Atomic-Conservative-Fallback" not in str(call["request_label"])
        for call in model.calls
    )
    first_system = str(model.calls[0]["messages"][0]["content"])
    assert "只输出一个 JSON 对象" in first_system
    assert "不判断 Object" in first_system
    object_system = str(model.calls[2]["messages"][0]["content"])
    assert "每条 claim 只处理一次" in object_system
    assert "不进行第二轮扫描" in object_system
    assert "statement template 重写" in object_system
    assert set(ObjectMentionSubmission.model_fields) == {"mentions"}
    assert set(ObjectMentionDraft.model_fields) == {
        "claim_id",
        "span_text",
        "occurrence_index",
    }
    temporal_system = str(model.calls[3]["messages"][0]["content"])
    assert temporal_system == TEMPORAL_ANNOTATION_SYSTEM_PROMPT
    assert snapshot.assertions[0].temporal_annotations == []


@pytest.mark.asyncio
async def test_literal_mention_becomes_program_generated_object(tmp_path: Path) -> None:
    mention = _json_turn(
        {"mentions": [{"claim_id": "claim-1", "span_text": "协会", "occurrence_index": 0}]}
    )
    paths = create_source_semantic_paths(tmp_path, "region-0002")
    snapshot = await SourceSemanticCompiler(
        model=FakeJsonModel(
            [
                _initial_turn(statement="协会过去通常申请两个场地"),
                _json_turn({"claims": []}),
                mention,
                _temporal_turn("claim-1"),
            ]
        ),
        exploration=_exploration(),
        blocks=_blocks(),
        paths=paths,
    ).compile("region-0002")

    assert snapshot.objects[0].label == "协会"
    assert snapshot.objects[0].aliases == []
    assert snapshot.object_mentions[0].mention_id == "mention-1"
    assert snapshot.assertions[0].statement_template_markdown == (
        "{{object:obj-1}}过去通常申请两个场地"
    )


@pytest.mark.asyncio
async def test_incremental_review_does_not_duplicate_existing_claim(tmp_path: Path) -> None:
    duplicate = _initial_turn()
    one_object = _json_turn(
        {
            "mentions": [
                {"claim_id": "claim-1", "span_text": "继往开来杯", "occurrence_index": 0}
            ]
        }
    )
    snapshot = await SourceSemanticCompiler(
        model=FakeJsonModel(
            [_initial_turn(), duplicate, one_object, _temporal_turn("claim-1")]
        ),
        exploration=_exploration(),
        blocks=_blocks(),
        paths=create_source_semantic_paths(tmp_path, "region-0002"),
    ).compile("region-0002")

    assert len(snapshot.assertions) == 1
    assert snapshot.review_addition_count == 0


def test_json_fence_normalization_is_strict_and_minimal() -> None:
    payload = '{"mentions":[]}'
    assert normalize_json_fence(payload) == payload
    assert normalize_json_fence(f"```json\n{payload}\n```") == payload
    assert normalize_json_fence(f"```\n{payload}\n```") == payload
    prefixed = f"说明\n```json\n{payload}\n```"
    assert normalize_json_fence(prefixed) == prefixed
    with pytest.raises(ValueError):
        ObjectMentionSubmission.model_validate_json(
            normalize_json_fence('{mentions:[]}')
        )


def test_missing_claim_schema_examples_match_strict_model() -> None:
    empty = AtomicClaimSubmission.model_validate_json('{"claims":[]}')
    nonempty = AtomicClaimSubmission.model_validate_json(
        '{"claims":[{"statement_markdown":"完整原子命题",'
        '"supporting_block_ids":["p0001-b0001"]}]}'
    )

    assert empty.claims == []
    assert nonempty.claims[0].statement_markdown == "完整原子命题"
    assert '"statement_markdown": "完整原子命题"' in MISSING_CLAIMS_SYSTEM_PROMPT
    assert '"supporting_block_ids": ["p0001-b0001"]' in MISSING_CLAIMS_SYSTEM_PROMPT
    for forbidden in ("id", "claim_id", "text", "content", "source"):
        with pytest.raises(ValueError):
            AtomicClaimSubmission.model_validate(
                {
                    "claims": [
                        {
                            "statement_markdown": "完整原子命题",
                            "supporting_block_ids": ["p0001-b0001"],
                            forbidden: "不允许的字段",
                        }
                    ]
                }
            )


def test_atomic_prompt_requires_json_safe_quotes() -> None:
    assert "中文弯引号“”" in CLAIM_EXTRACTION_SYSTEM_PROMPT
    assert "ASCII 双引号" in CLAIM_EXTRACTION_SYSTEM_PROMPT
    assert '\\\"' in CLAIM_EXTRACTION_SYSTEM_PROMPT
    assert '协会呈现“两极化”结构' in CLAIM_EXTRACTION_SYSTEM_PROMPT


def test_mention_prompt_is_finite_sequential_task() -> None:
    for forbidden in ("高召回", "漏掉潜在 Object 的代价", "可持续指认"):
        assert forbidden not in OBJECT_MENTION_SYSTEM_PROMPT
    assert "当前给出的顺序" in OBJECT_MENTION_SYSTEM_PROMPT
    assert "每条 claim 只处理一次" in OBJECT_MENTION_SYSTEM_PROMPT
    assert "不返回已经处理过的 claim" in OBJECT_MENTION_SYSTEM_PROMPT
    assert "不进行第二轮扫描或全局遗漏检查" in OBJECT_MENTION_SYSTEM_PROMPT
    assert "不重新打开已经处理过的 claim" in OBJECT_MENTION_SYSTEM_PROMPT
    assert "最后一条 claim 处理结束后立即输出" in OBJECT_MENTION_SYSTEM_PROMPT
    assert "副会长协助会长完成重大决策" in OBJECT_MENTION_SYSTEM_PROMPT


def _source_claim(claim_id: str, statement: str) -> SourceClaim:
    return SourceClaim(
        claim_id=claim_id,
        statement_markdown=statement,
        supporting_block_ids=["p0001-b0002"],
    )


def test_mentions_reject_missing_occurrence_and_overlap() -> None:
    claims = [_source_claim("claim-1", "继往开来杯每学年举办一次。")]
    with pytest.raises(ValueError, match="不存在 span"):
        _materialize_mentions(
            ObjectMentionSubmission(
                mentions=[
                    ObjectMentionDraft(
                        claim_id="claim-1",
                        span_text="会员大会",
                        occurrence_index=0,
                    )
                ]
            ),
            claims,
        )
    with pytest.raises(ValueError, match="第 1 次出现"):
        _materialize_mentions(
            ObjectMentionSubmission(
                mentions=[
                    ObjectMentionDraft(
                        claim_id="claim-1",
                        span_text="继往开来杯",
                        occurrence_index=1,
                    )
                ]
            ),
            claims,
        )
    with pytest.raises(ValueError, match="mention span 重叠"):
        _materialize_mentions(
            ObjectMentionSubmission(
                mentions=[
                    ObjectMentionDraft(
                        claim_id="claim-1",
                        span_text="继往开来杯",
                        occurrence_index=0,
                    ),
                    ObjectMentionDraft(
                        claim_id="claim-1",
                        span_text="开来杯",
                        occurrence_index=0,
                    ),
                ]
            ),
            claims,
        )


def test_nested_occurrence_indices_follow_all_literal_substrings() -> None:
    claims = [_source_claim("claim-1", "副会长协助会长完成重大决策。")]
    correct = ObjectMentionSubmission(
        mentions=[
            ObjectMentionDraft(
                claim_id="claim-1", span_text="副会长", occurrence_index=0
            ),
            ObjectMentionDraft(
                claim_id="claim-1", span_text="会长", occurrence_index=1
            ),
        ]
    )

    _, mentions, _ = _materialize_mentions(correct, claims)

    assert [(item.span_text, item.start, item.end) for item in mentions] == [
        ("副会长", 0, 3),
        ("会长", 5, 7),
    ]

    _, nested, _ = _materialize_mentions(
        ObjectMentionSubmission(
            mentions=[
                ObjectMentionDraft(
                    claim_id="claim-1", span_text="会长", occurrence_index=0
                )
            ]
        ),
        claims,
    )
    assert (nested[0].start, nested[0].end) == (1, 3)

    overlapping = ObjectMentionSubmission(
        mentions=[
            ObjectMentionDraft(
                claim_id="claim-1", span_text="副会长", occurrence_index=0
            ),
            ObjectMentionDraft(
                claim_id="claim-1", span_text="会长", occurrence_index=0
            ),
        ]
    )
    with pytest.raises(ValueError) as error:
        _materialize_mentions(overlapping, claims)
    message = str(error.value)
    assert "span_text='会长', occurrence_index=0" in message
    assert "span_text='副会长', occurrence_index=0" in message
    assert "位于 '副会长' 内部" in message
    assert "occurrence_index=1 对应 [5:7]" in message


@pytest.mark.asyncio
async def test_overlap_clean_retry_describes_both_resolved_spans(tmp_path: Path) -> None:
    invalid_mentions = _json_turn(
        {
            "mentions": [
                {"claim_id": "claim-1", "span_text": "副会长", "occurrence_index": 0},
                {"claim_id": "claim-1", "span_text": "会长", "occurrence_index": 0},
            ]
        }
    )
    corrected_mentions = _json_turn(
        {
            "mentions": [
                {"claim_id": "claim-1", "span_text": "副会长", "occurrence_index": 0},
                {"claim_id": "claim-1", "span_text": "会长", "occurrence_index": 1},
            ]
        }
    )
    model = FakeJsonModel(
        [
            _initial_turn(statement="副会长协助会长完成重大决策。"),
            _json_turn({"claims": []}),
            invalid_mentions,
            corrected_mentions,
            _temporal_turn("claim-1"),
        ]
    )

    snapshot = await SourceSemanticCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=create_source_semantic_paths(tmp_path, "region-0002"),
    ).compile("region-0002")

    assert snapshot.model_calls == 5
    retry_system = str(model.calls[3]["messages"][0]["content"])
    assert "span_text='会长', occurrence_index=0" in retry_system
    assert "span_text='副会长', occurrence_index=0" in retry_system
    assert "位于 '副会长' 内部" in retry_system
    assert "occurrence_index=1 对应 [5:7]" in retry_system


def test_mentions_generate_reversible_templates_and_exact_surface_objects() -> None:
    claims = [
        _source_claim("claim-1", "继往开来杯通常申请两个场地。"),
        _source_claim("claim-2", "继往开来杯是大型比赛。"),
    ]
    submission = ObjectMentionSubmission(
        mentions=[
            ObjectMentionDraft(
                claim_id="claim-2", span_text="大型比赛", occurrence_index=0
            ),
            ObjectMentionDraft(
                claim_id="claim-1", span_text="继往开来杯", occurrence_index=0
            ),
            ObjectMentionDraft(
                claim_id="claim-2", span_text="继往开来杯", occurrence_index=0
            ),
        ]
    )

    objects, mentions, assertions = _materialize_mentions(submission, claims)

    assert [(item.object_id, item.label, item.aliases) for item in objects] == [
        ("obj-1", "继往开来杯", []),
        ("obj-2", "大型比赛", []),
    ]
    assert [item.mention_id for item in mentions] == [
        "mention-1",
        "mention-2",
        "mention-3",
    ]
    restored = [
        item.statement_template_markdown
        .replace("{{object:obj-1}}", "继往开来杯")
        .replace("{{object:obj-2}}", "大型比赛")
        for item in assertions
    ]
    assert restored == [item.statement_markdown for item in claims]


def _validated_temporals(
    statement: str,
    annotations: list[dict[str, object]],
) -> list[TemporalAnnotation]:
    claim = _source_claim("claim-1", statement)
    submission = TemporalAnnotationSubmission.model_validate(
        {
            "claims": [
                {
                    "claim_id": "claim-1",
                    "temporal_annotations": annotations,
                }
            ]
        }
    )
    _validate_temporal_submission(submission, [claim], _blocks())
    return submission.claims[0].temporal_annotations


def _temporal_annotation(
    *,
    raw_expression: str,
    kind: str,
    normalized_text: str,
    start: str | None,
    end: str | None,
    precision: str,
    derivation: str,
    basis_markdown: str,
) -> dict[str, object]:
    return {
        "raw_expression": raw_expression,
        "kind": kind,
        "normalized_text": normalized_text,
        "start": start,
        "end": end,
        "precision": precision,
        "derivation": derivation,
        "basis_markdown": basis_markdown,
    }


def test_temporal_without_source_time_stays_empty() -> None:
    annotations = _validated_temporals("新闻稿是行政流程的一部分。", [])

    assert annotations == []
    assert "不得根据一般现在时" in TEMPORAL_ANNOTATION_SYSTEM_PROMPT
    assert "来源日期不是 Assertion 时间" in TEMPORAL_ANNOTATION_SYSTEM_PROMPT
    assert "持续适用" in TEMPORAL_ANNOTATION_SYSTEM_PROMPT
    assert "ASCII 双引号时，必须按 JSON string 规则" in TEMPORAL_ANNOTATION_SYSTEM_PROMPT
    assert "表格中“继往开来”的举办时间" in TEMPORAL_ANNOTATION_SYSTEM_PROMPT


def test_temporal_explicit_date_and_academic_year_range() -> None:
    date = _validated_temporals(
        "文档标注日期为2026年1月28日。",
        [
            _temporal_annotation(
                raw_expression="2026年1月28日",
                kind="point",
                normalized_text="2026年1月28日",
                start="2026-01-28",
                end=None,
                precision="day",
                derivation="source_explicit",
                basis_markdown="来源明确写出“2026年1月28日”。",
            )
        ],
    )[0]
    academic_year = _validated_temporals(
        "魏汉东在2025-2026学年任会长。",
        [
            _temporal_annotation(
                raw_expression="2025-2026学年",
                kind="range",
                normalized_text="2025-2026学年",
                start="2025",
                end="2026",
                precision="academic_year",
                derivation="source_explicit",
                basis_markdown="来源明确写出“2025-2026学年”。",
            )
        ],
    )[0]

    assert (date.kind, date.start, date.derivation) == (
        "point",
        "2026-01-28",
        "source_explicit",
    )
    assert date.basis_markdown
    assert (
        academic_year.kind,
        academic_year.start,
        academic_year.end,
        academic_year.precision,
    ) == ("range", "2025", "2026", "academic_year")


def test_temporal_recurring_and_relative_keep_null_bounds() -> None:
    recurring = _validated_temporals(
        "换届交接每年五月进行。",
        [
            _temporal_annotation(
                raw_expression="每年五月",
                kind="recurring",
                normalized_text="每年5月",
                start=None,
                end=None,
                precision="month",
                derivation="source_explicit",
                basis_markdown="来源明确写出“每年五月”。",
            )
        ],
    )[0]
    relative = _validated_temporals(
        "大型赛事必须在活动前至少7天提交申请。",
        [
            _temporal_annotation(
                raw_expression="活动前至少7天",
                kind="relative",
                normalized_text="活动前至少7天",
                start=None,
                end=None,
                precision="day",
                derivation="source_explicit",
                basis_markdown="来源明确规定“活动前至少7天”。",
            )
        ],
    )[0]

    assert (recurring.kind, recurring.normalized_text) == ("recurring", "每年5月")
    assert recurring.start is recurring.end is None
    assert relative.kind == "relative"
    assert relative.start is relative.end is None


def test_temporal_contextual_inference_and_unresolved_context() -> None:
    inferred = _validated_temporals(
        "本届需要完成组织改革。",
        [
            _temporal_annotation(
                raw_expression="本届",
                kind="contextual",
                normalized_text="2025-2026学年",
                start="2025",
                end="2026",
                precision="academic_year",
                derivation="contextual_inference",
                basis_markdown="来源写出“本届”，文档背景明确作者为25-26届会长。",
            )
        ],
    )[0]
    unresolved = _validated_temporals(
        "当时出现了经验传承断层。",
        [
            _temporal_annotation(
                raw_expression="当时",
                kind="contextual",
                normalized_text="当时",
                start=None,
                end=None,
                precision="unspecified",
                derivation="unresolved",
                basis_markdown="来源使用“当时”，但当前上下文没有可靠时间锚点。",
            )
        ],
    )[0]

    assert (inferred.start, inferred.end, inferred.derivation) == (
        "2025",
        "2026",
        "contextual_inference",
    )
    assert "25-26届" in inferred.basis_markdown
    assert unresolved.derivation == "unresolved"
    assert unresolved.start is unresolved.end is None


def test_temporal_preserves_fuzzy_source_language() -> None:
    approximate = _validated_temporals(
        "协会约2025年开始改革。",
        [
            _temporal_annotation(
                raw_expression="约2025年",
                kind="point",
                normalized_text="约2025年",
                start="2025",
                end=None,
                precision="year",
                derivation="source_explicit",
                basis_markdown="来源使用近似表达“约2025年”。",
            )
        ],
    )[0]
    long_term = _validated_temporals(
        "长期以来存在经验传承断层。",
        [
            _temporal_annotation(
                raw_expression="长期以来",
                kind="unknown",
                normalized_text="长期以来",
                start=None,
                end=None,
                precision="unspecified",
                derivation="unresolved",
                basis_markdown="来源使用“长期以来”，但未给出可定位的起止时间。",
            )
        ],
    )[0]

    assert approximate.normalized_text == "约2025年"
    assert approximate.start == "2025"
    assert long_term.start is long_term.end is None


def test_temporal_supports_multiple_annotations_per_claim() -> None:
    annotations = _validated_temporals(
        "继往开来始于2009年，目前每年秋季举办。",
        [
            _temporal_annotation(
                raw_expression="2009年",
                kind="point",
                normalized_text="2009年",
                start="2009",
                end=None,
                precision="year",
                derivation="source_explicit",
                basis_markdown="来源明确写出“2009年”。",
            ),
            _temporal_annotation(
                raw_expression="目前",
                kind="contextual",
                normalized_text="目前",
                start=None,
                end=None,
                precision="unspecified",
                derivation="unresolved",
                basis_markdown="来源使用“目前”，但不自动把来源日期作为事实时间。",
            ),
            _temporal_annotation(
                raw_expression="每年秋季",
                kind="recurring",
                normalized_text="每年秋季",
                start=None,
                end=None,
                precision="unspecified",
                derivation="source_explicit",
                basis_markdown="来源明确写出“每年秋季”。",
            ),
        ],
    )

    assert [item.kind for item in annotations] == ["point", "contextual", "recurring"]


def test_temporal_rejects_ungrounded_raw_expression_and_bad_claim_coverage() -> None:
    claim = _source_claim("claim-1", "协会在2025年开始改革。")
    ungrounded = TemporalAnnotationSubmission.model_validate(
        {
            "claims": [
                {
                    "claim_id": "claim-1",
                    "temporal_annotations": [
                        _temporal_annotation(
                            raw_expression="2024年",
                            kind="point",
                            normalized_text="2024年",
                            start="2024",
                            end=None,
                            precision="year",
                            derivation="source_explicit",
                            basis_markdown="错误的来源锚点。",
                        )
                    ],
                }
            ]
        }
    )
    with pytest.raises(ValueError, match=r"raw_expression.*不存在"):
        _validate_temporal_submission(ungrounded, [claim], _blocks())

    for invalid in (
        {"claims": []},
        {
            "claims": [
                {"claim_id": "claim-2", "temporal_annotations": []},
            ]
        },
        {
            "claims": [
                {"claim_id": "claim-1", "temporal_annotations": []},
                {"claim_id": "claim-1", "temporal_annotations": []},
            ]
        },
    ):
        submission = TemporalAnnotationSubmission.model_validate(invalid)
        with pytest.raises(ValueError):
            _validate_temporal_submission(submission, [claim], _blocks())


def test_temporal_schema_rejects_truth_fields_and_invalid_bounds() -> None:
    base = _temporal_annotation(
        raw_expression="2025年",
        kind="point",
        normalized_text="2025年",
        start="2025",
        end=None,
        precision="year",
        derivation="source_explicit",
        basis_markdown="来源明确写出“2025年”。",
    )
    for forbidden in ("fact_confidence", "truth_confidence", "source_reliability"):
        with pytest.raises(ValueError):
            TemporalAnnotation.model_validate({**base, forbidden: "high"})

    with pytest.raises(ValueError, match="start 不能晚于 end"):
        TemporalAnnotation.model_validate(
            {**base, "kind": "range", "start": "2026", "end": "2025"}
        )
    with pytest.raises(ValueError, match="日期无效"):
        TemporalAnnotation.model_validate({**base, "start": "2026-02-30"})
    with pytest.raises(ValueError, match="unresolved 时间不能填写"):
        TemporalAnnotation.model_validate({**base, "derivation": "unresolved"})


def test_temporal_attachment_does_not_modify_existing_assertion() -> None:
    claims = [_source_claim("claim-1", "继往开来杯在2025年举办。")]
    objects, mentions, assertions = _materialize_mentions(
        ObjectMentionSubmission(
            mentions=[
                ObjectMentionDraft(
                    claim_id="claim-1",
                    span_text="继往开来杯",
                    occurrence_index=0,
                )
            ]
        ),
        claims,
    )
    before = assertions[0].model_dump()
    attached = _attach_temporal_annotations(
        assertions,
        [
            TemporalClaimAnnotations(
                claim_id="claim-1",
                temporal_annotations=_validated_temporals(
                    claims[0].statement_markdown,
                    [
                        _temporal_annotation(
                            raw_expression="2025年",
                            kind="point",
                            normalized_text="2025年",
                            start="2025",
                            end=None,
                            precision="year",
                            derivation="source_explicit",
                            basis_markdown="来源明确写出“2025年”。",
                        )
                    ],
                ),
            )
        ],
    )

    assert assertions[0].model_dump() == before
    assert attached[0].statement_template_markdown == before["statement_template_markdown"]
    assert attached[0].supporting_block_ids == before["supporting_block_ids"]
    assert len(attached[0].temporal_annotations) == 1
    assert objects[0].label == "继往开来杯"
    assert mentions[0].span_text == "继往开来杯"


@pytest.mark.asyncio
async def test_temporal_checkpoint_and_final_snapshot_are_persisted(
    tmp_path: Path,
) -> None:
    paths = create_source_semantic_paths(tmp_path, "region-0002")
    temporal = _temporal_turn(
        "claim-1",
        annotations={
            "claim-1": [
                _temporal_annotation(
                    raw_expression="2025-2026学年",
                    kind="range",
                    normalized_text="2025-2026学年",
                    start="2025",
                    end="2026",
                    precision="academic_year",
                    derivation="source_explicit",
                    basis_markdown="来源明确写出“2025-2026学年”。",
                )
            ]
        },
    )
    snapshot = await SourceSemanticCompiler(
        model=FakeJsonModel(
            [
                _initial_turn(statement="魏汉东在2025-2026学年任会长。"),
                _json_turn({"claims": []}),
                _json_turn(
                    {
                        "mentions": [
                            {
                                "claim_id": "claim-1",
                                "span_text": "魏汉东",
                                "occurrence_index": 0,
                            },
                            {
                                "claim_id": "claim-1",
                                "span_text": "会长",
                                "occurrence_index": 0,
                            },
                        ]
                    }
                ),
                temporal,
            ]
        ),
        exploration=_exploration(),
        blocks=_blocks(),
        paths=paths,
    ).compile("region-0002")

    assert snapshot.schema_version == "source-semantics.v4"
    assert snapshot.model_calls == 4
    assert snapshot.assertions[0].temporal_annotations[0].start == "2025"
    assert "{{object:obj-1}}" in snapshot.assertions[0].statement_template_markdown
    assert paths.temporal_annotations_json.exists()
    checkpoint = json.loads(paths.temporal_annotations_json.read_text(encoding="utf-8"))
    assert checkpoint["schema_version"] == "source-temporal-annotations.v1"
    assert checkpoint["model_calls"] == 1


@pytest.mark.asyncio
async def test_temporal_validation_failure_gets_one_clean_retry(tmp_path: Path) -> None:
    invalid = _temporal_turn(
        "claim-1",
        annotations={
            "claim-1": [
                _temporal_annotation(
                    raw_expression="不存在的2024年",
                    kind="point",
                    normalized_text="2024年",
                    start="2024",
                    end=None,
                    precision="year",
                    derivation="source_explicit",
                    basis_markdown="错误锚点。",
                )
            ]
        },
    )
    valid = _temporal_turn("claim-1")
    model = FakeJsonModel(
        [
            _initial_turn(),
            _json_turn({"claims": []}),
            _json_turn(
                {
                    "mentions": [
                        {
                            "claim_id": "claim-1",
                            "span_text": "继往开来杯",
                            "occurrence_index": 0,
                        }
                    ]
                }
            ),
            invalid,
            valid,
        ]
    )
    snapshot = await SourceSemanticCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=create_source_semantic_paths(tmp_path, "region-0002"),
    ).compile("region-0002")

    assert snapshot.model_calls == 5
    assert len(model.calls) == 5
    assert str(model.calls[4]["request_label"]).endswith("clean-retry")
    retry_messages = model.calls[4]["messages"]
    assert retry_messages[1] == model.calls[3]["messages"][1]
    assert "错误锚点" not in str(retry_messages)
    assert "只完成当前阶段要求的单一判断" not in str(retry_messages)


@pytest.mark.asyncio
async def test_temporal_retry_failure_stops_without_third_call(tmp_path: Path) -> None:
    invalid = _temporal_turn("claim-2")
    paths = create_source_semantic_paths(tmp_path, "region-0002")
    model = FakeJsonModel(
        [
            _initial_turn(),
            _json_turn({"claims": []}),
            _json_turn(
                {
                    "mentions": [
                        {
                            "claim_id": "claim-1",
                            "span_text": "继往开来杯",
                            "occurrence_index": 0,
                        }
                    ]
                }
            ),
            invalid,
            invalid,
        ]
    )

    with pytest.raises(ValueError, match=r"Temporal Annotation.*clean retry 均失败"):
        await SourceSemanticCompiler(
            model=model,
            exploration=_exploration(),
            blocks=_blocks(),
            paths=paths,
        ).compile("region-0002")

    assert len(model.calls) == 5
    assert not paths.temporal_annotations_json.exists()
    assert not paths.snapshot_json.exists()


@pytest.mark.asyncio
async def test_existing_three_stage_checkpoints_resume_at_temporal_only(
    tmp_path: Path,
) -> None:
    paths = create_source_semantic_paths(tmp_path, "region-0002")
    await SourceSemanticCompiler(
        model=FakeJsonModel(
            [
                _initial_turn(),
                _json_turn({"claims": []}),
                _json_turn(
                    {
                        "mentions": [
                            {
                                "claim_id": "claim-1",
                                "span_text": "继往开来杯",
                                "occurrence_index": 0,
                            }
                        ]
                    }
                ),
                _temporal_turn("claim-1"),
            ]
        ),
        exploration=_exploration(),
        blocks=_blocks(),
        paths=paths,
    ).compile("region-0002")

    legacy_snapshot = json.loads(paths.snapshot_json.read_text(encoding="utf-8"))
    legacy_snapshot["schema_version"] = "source-semantics.v3"
    for assertion in legacy_snapshot["assertions"]:
        assertion.pop("temporal_annotations")
    paths.snapshot_json.write_text(
        json.dumps(legacy_snapshot, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    paths.temporal_annotations_json.unlink()

    resumed_model = FakeJsonModel([_temporal_turn("claim-1")])
    snapshot = await SourceSemanticCompiler(
        model=resumed_model,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=paths,
    ).compile("region-0002")

    assert len(resumed_model.calls) == 1
    assert str(resumed_model.calls[0]["request_label"]).endswith(
        "Temporal Annotation"
    )
    assert snapshot.schema_version == "source-semantics.v4"
    assert snapshot.model_calls == 4


@pytest.mark.asyncio
async def test_stage_uses_one_clean_retry_without_bad_output_history(tmp_path: Path) -> None:
    invalid = ModelTurn(content='{"claims": [', reasoning_content="错误思考")
    model = FakeJsonModel(
        [
            invalid,
            _initial_turn(),
            _json_turn({"claims": []}),
            _json_turn(
                {
                    "mentions": [
                        {
                            "claim_id": "claim-1",
                            "span_text": "继往开来杯",
                            "occurrence_index": 0,
                        }
                    ]
                }
            ),
            _temporal_turn("claim-1"),
        ]
    )
    snapshot = await SourceSemanticCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=create_source_semantic_paths(tmp_path, "region-0002"),
    ).compile("region-0002")

    assert snapshot.model_calls == 5
    assert len(model.calls) == 5
    first_messages = model.calls[0]["messages"]
    retry_messages = model.calls[1]["messages"]
    assert [item["role"] for item in retry_messages] == ["system", "user"]
    assert retry_messages[1] == first_messages[1]
    assert "错误思考" not in str(retry_messages)
    assert '{"claims": [' not in str(retry_messages)
    assert "上一次提交未通过确定性校验" in str(
        retry_messages[0]["content"]
    )
    assert "请仅根据原始输入重新生成一次" in str(
        retry_messages[0]["content"]
    )
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
            _json_turn(
                {
                    "mentions": [
                        {
                            "claim_id": "claim-1",
                            "span_text": "继往开来杯",
                            "occurrence_index": 0,
                        }
                    ]
                }
            ),
            _temporal_turn("claim-1"),
        ]
    )

    snapshot = await SourceSemanticCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=create_source_semantic_paths(tmp_path, "region-0002"),
    ).compile("region-0002")

    assert snapshot.model_calls == 5
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
                }
            ]
        }
    )
    model = FakeJsonModel(
        [
            invalid_block,
            _initial_turn(),
            _json_turn({"claims": []}),
            _json_turn(
                {
                    "mentions": [
                        {
                            "claim_id": "claim-1",
                            "span_text": "继往开来杯",
                            "occurrence_index": 0,
                        }
                    ]
                }
            ),
            _temporal_turn("claim-1"),
        ]
    )

    snapshot = await SourceSemanticCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=create_source_semantic_paths(tmp_path, "region-0002"),
    ).compile("region-0002")

    assert snapshot.model_calls == 5
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
            _json_turn(
                {
                    "mentions": [
                        {
                            "claim_id": "claim-1",
                            "span_text": "继往开来杯",
                            "occurrence_index": 0,
                        }
                    ]
                }
            ),
            _temporal_turn("claim-1"),
        ]
    )
    snapshot = await SourceSemanticCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=paths,
    ).compile("region-0002")

    assert snapshot.model_calls == 5
    assert len(model.calls[1]["messages"]) == 2
    assert model.calls[1]["messages"][1] == model.calls[0]["messages"][1]
    fallback_system = str(model.calls[1]["messages"][0]["content"])
    assert fallback_system == CONSERVATIVE_ATOMIC_FALLBACK_SYSTEM_PROMPT
    assert "上一轮完整原子化推理发生重复" in fallback_system
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
    assert "不追求最小原子粒度" in prompt
    assert "保留较完整、较接近原文的表达" in prompt
    assert "不要返回已经处理过的 block" in prompt
    assert "不做第二轮全局检查" in prompt
    assert "处理完最后一个 block 后立即提交" in prompt
    assert "遗漏事实由后续 Missing" in prompt
    assert "组织架构不合理、经验传承断层" in prompt
    assert "记录→提供参考→终结失忆" in prompt
    assert '\\\"' in prompt


@pytest.mark.asyncio
async def test_stage_failure_stops_after_one_retry(tmp_path: Path) -> None:
    paths = create_source_semantic_paths(tmp_path, "region-0002")
    model = FakeJsonModel(
        [ModelTurn(content="{"), ModelTurn(content='{"claims": [}')]
    )
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
    def __init__(self, *, fail_mentions_node: str | None = None) -> None:
        self.fail_mentions_node = fail_mentions_node
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
        node_id = "region-0002" if "region-0002" in request_label else "region-0003"
        block_id = "p0001-b0002" if node_id == "region-0002" else "p0001-b0003"
        label = "继往开来杯" if node_id == "region-0002" else "会员大会"
        if request_label.endswith("原子命题"):
            return _json_turn(
                {
                    "claims": [
                        {
                            "statement_markdown": f"{label}每学年举办一次。",
                            "supporting_block_ids": [block_id],
                        }
                    ]
                }
            )
        if request_label.endswith("遗漏扫描"):
            return _json_turn({"claims": []})
        if "Object Mention" in request_label:
            span_text = "不存在的字面" if self.fail_mentions_node == node_id else label
            return _json_turn(
                {
                    "mentions": [
                        {
                            "claim_id": "claim-1",
                            "span_text": span_text,
                            "occurrence_index": 0,
                        }
                    ],
                }
            )
        if "Temporal Annotation" in request_label:
            return _temporal_turn("claim-1")
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
    assert snapshot.total_objects == 2
    assert snapshot.model_calls == 8
    assert len(model.calls) == 8
    working = json.loads(paths.working_json.read_text(encoding="utf-8"))
    assert all(item["complete"] for item in working["stages"])
    assert all(item["object_mentions"] for item in working["stages"])
    assert all(item["temporal_annotations"] for item in working["stages"])
    for node_id in snapshot.source_node_ids:
        source = paths.sources / node_id
        assert (source / "01-initial-claims.json").exists()
        assert (source / "02-reviewed-claims.json").exists()
        assert (source / "03-object-mentions.json").exists()
        assert (source / "04-temporal-annotations.json").exists()
        assert (source / "source-semantics.json").exists()


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
    assert all("region-0003" in label for label in model.calls)


@pytest.mark.asyncio
async def test_batch_resume_only_retries_failed_source_stage(tmp_path: Path) -> None:
    paths = create_full_source_semantic_paths(tmp_path)
    runner = FullSourceSemanticRunner(
        model=BatchJsonModel(fail_mentions_node="region-0003"),
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
    assert not (failed / "03-object-mentions.json").exists()
    assert (paths.sources / "region-0002" / "source-semantics.json").exists()

    resumed_model = BatchJsonModel()
    snapshot = await FullSourceSemanticRunner(
        model=resumed_model,
        exploration=_batch_exploration(),
        blocks=_batch_blocks(),
        paths=open_full_source_semantic_paths(paths.directory),
        max_parallel_sources=1,
    ).run()

    assert len(resumed_model.calls) == 2
    assert resumed_model.calls[0].endswith("region-0003·Object Mention")
    assert resumed_model.calls[1].endswith("region-0003·Temporal Annotation")
    assert len(snapshot.sources) == 2
