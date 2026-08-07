from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from cold_start.compilation.leaf import (
    LeafBasicCompiler,
    create_leaf_artifact_paths,
    write_leaf_artifact,
)
from cold_start.document.models import ParsedBlock
from cold_start.global_exploration.models import (
    GlobalExplorationSnapshot,
    SourceMetadata,
)
from cold_start.llm.base import ModelTurn, ThinkingMode
from cold_start.region_tree.models import RegionNode, RegionTreeSnapshot, SourceSegment


class FakeModel:
    def __init__(self, turns: list[ModelTurn]) -> None:
        self.turns = turns
        self.calls: list[dict[str, object]] = []

    async def complete_turn(
        self,
        *,
        messages: Sequence[Mapping[str, Any]],
        tools: Sequence[Mapping[str, Any]] = (),
        tool_choice: object | None = None,
        temperature: float = 0.0,
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
        return self.turns.pop(0)


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
            markdown="继往开来杯过去通常申请两个场地。",
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


def _turn(
    *,
    start_block_id: str = "p0001-b0002",
    end_block_id: str = "p0001-b0002",
    add_unused_evidence: bool = False,
    evidence_only: bool = False,
) -> ModelTurn:
    arguments = {
        "schema_version": "object-assertion-evidence-package.v4",
        "objects": [
            {
                "object_id": "obj-1",
                "label": "继往开来杯",
                "aliases": [],
            }
        ],
        "assertions": [
            {
                "assertion_id": "assert-1",
                "mode": "record",
                "statement_template_markdown": (
                    "{{object:obj-1}}过去通常申请两个场地。"
                ),
                "holder_object_id": None,
                "temporal_scope": {
                    "kind": "unknown",
                    "display": "时间不明",
                    "start": None,
                    "end": None,
                    "precision": "unspecified",
                    "confidence": "low",
                },
                "temporal_basis_markdown": "原文和上下文没有给出可定位时间。",
                "uncertainty_markdown": None,
                "evidence_ids": ["evidence-1"],
            }
        ],
        "evidence": [
            {
                "evidence_id": "evidence-1",
                "start_block_id": start_block_id,
                "end_block_id": end_block_id,
                "note_markdown": None,
            }
        ],
    }
    if add_unused_evidence:
        arguments["evidence"].append(
            {
                "evidence_id": "evidence-2",
                "start_block_id": "p0001-b0001",
                "end_block_id": "p0001-b0001",
                "note_markdown": None,
            }
        )
    if evidence_only:
        arguments.update(objects=[], assertions=[])
    return ModelTurn(
        content=json.dumps(arguments, ensure_ascii=False),
        reasoning_content="逐块检查原文并核对对象、原子叙述和依据引用。",
    )


@pytest.mark.asyncio
async def test_compiles_and_reviews_one_leaf(tmp_path: Path) -> None:
    model = FakeModel([_turn(), _turn(start_block_id="p0001-b0001")])
    compiler = LeafBasicCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
    )

    artifact = await compiler.compile("region-0002")

    assert artifact.model_calls == 2
    assert artifact.package.objects[0].label == "继往开来杯"
    assert artifact.covered_block_ids == ["p0001-b0001", "p0001-b0002"]
    assert artifact.uncovered_block_ids == []
    assert len(model.calls) == 2
    assert model.calls[0]["tools"] == ()
    assert model.calls[0]["tool_choice"] is None
    assert model.calls[0]["thinking"] == "enabled"
    assert model.calls[1]["tools"] == ()
    assert model.calls[1]["tool_choice"] is None
    assert model.calls[1]["thinking"] == "enabled"
    extraction_system = str(model.calls[0]["messages"][0]["content"])
    review_system = str(model.calls[1]["messages"][0]["content"])
    for prompt in [extraction_system, review_system]:
        assert "object-assertion-evidence-package.v4" in prompt
        assert "`label`" in prompt
        assert "`start_block_id`" in prompt
        assert "`end_block_id`" in prompt
        assert "禁止输出 `block_id`" in prompt
        assert "record` 必须为" in prompt
        assert "不能使用空字符串" in prompt
        assert "至少包含一个" in prompt
        assert "零对象引用会被拒绝" in prompt
        assert "ID 必须分别唯一" in prompt
        assert "完全位于当前节点自有原文内" in prompt
        assert "产生人工复核警告" in prompt
        assert "Object 不能包含" in prompt
        assert "现实语义门" in prompt
        assert "本章将介绍" in prompt
        assert "标题、表头或列表上方" in prompt
        assert "体育场馆申请" in prompt
        assert "核心工作对象" in prompt
    assert "必须把标题对象补回相关 Assertion" in extraction_system
    assert "核心谓词锚点检查" in review_system
    assert "审批部门、负责人、地点、工具或例子" in review_system
    assert "这是协会活动手册" in str(model.calls[0]["messages"][-1]["content"])
    review_prompt = str(model.calls[1]["messages"][-1]["content"])
    assert "第一次结构化结果" in review_prompt
    assert "贯彻原子化标准" in review_prompt
    assert "{{object:obj-1}}过去通常申请两个场地" in review_prompt

    paths = create_leaf_artifact_paths(tmp_path, "region-0002")
    write_leaf_artifact(paths, artifact, _blocks())
    assert json.loads(paths.snapshot_json.read_text(encoding="utf-8"))[
        "region_node_id"
    ] == "region-0002"
    report = paths.report_markdown.read_text(encoding="utf-8")
    assert "继往开来杯过去通常申请两个场地" in report
    assert "{{object:obj-1}}过去通常申请两个场地" in report
    assert "原文逐块覆盖" in report
    assert "p0001-b0001`｜已覆盖" in report


@pytest.mark.asyncio
async def test_invalid_evidence_gets_one_repair_then_review() -> None:
    model = FakeModel(
        [
            _turn(end_block_id="p0001-b0099"),
            _turn(),
            _turn(start_block_id="p0001-b0001"),
        ]
    )
    compiler = LeafBasicCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
    )

    artifact = await compiler.compile("region-0002")

    assert artifact.model_calls == 3
    assert len(model.calls) == 3
    repair_messages = model.calls[1]["messages"]
    assert model.calls[0]["thinking"] == "enabled"
    assert model.calls[1]["thinking"] == "enabled"
    assert model.calls[2]["thinking"] == "enabled"
    assert not any(message["role"] == "tool" for message in repair_messages)
    assert "完整替代 JSON" in str(repair_messages[-1]["content"])
    assert "逐字段对照系统消息中的唯一协议" in str(
        repair_messages[-1]["content"]
    )
    assert "不存在来源块" in str(repair_messages[-1]["content"])


@pytest.mark.asyncio
async def test_missing_schema_version_requires_repair() -> None:
    missing_schema_payload = json.loads(_turn().content)
    missing_schema_payload.pop("schema_version")
    missing_schema = ModelTurn(
        content=json.dumps(missing_schema_payload, ensure_ascii=False),
        reasoning_content="输出基础记忆包。",
    )
    model = FakeModel(
        [
            missing_schema,
            _turn(),
            _turn(start_block_id="p0001-b0001"),
        ]
    )
    compiler = LeafBasicCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
    )

    artifact = await compiler.compile("region-0002")

    assert artifact.model_calls == 3
    repair_prompt = str(model.calls[1]["messages"][-1]["content"])
    assert "schema_version 必须为 object-assertion-evidence-package.v4" in (
        repair_prompt
    )


@pytest.mark.asyncio
async def test_json_repair_can_reveal_one_protocol_repair() -> None:
    invalid_json = ModelTurn(
        content='{"objects": [',
        reasoning_content="准备输出 JSON。",
    )
    wrong_protocol = ModelTurn(
        content=json.dumps(
            {
                "schema_version": "object-assertion-evidence-package.v4",
                "objects": [
                    {
                        "object_id": "obj-1",
                        "name": "继往开来杯",
                        "aliases": [],
                    }
                ],
                "assertions": [],
                "evidence": [
                    {
                        "evidence_id": "evidence-1",
                        "start_block_id": "p0001-b0001",
                        "end_block_id": "p0001-b0001",
                        "note_markdown": None,
                    }
                ],
            },
            ensure_ascii=False,
        ),
        reasoning_content="修复 JSON 语法。",
    )
    model = FakeModel(
        [
            invalid_json,
            wrong_protocol,
            _turn(),
            _turn(start_block_id="p0001-b0001"),
        ]
    )
    compiler = LeafBasicCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
    )

    artifact = await compiler.compile("region-0002")

    assert artifact.model_calls == 4
    assert model.calls[1]["request_label"].endswith("修复1")
    assert model.calls[2]["request_label"].endswith("修复2")
    second_repair_prompt = str(model.calls[2]["messages"][-1]["content"])
    assert "objects.0.label" in second_repair_prompt
    assert "objects.0.name" in second_repair_prompt


@pytest.mark.asyncio
async def test_repeated_json_error_can_use_all_three_thinking_repairs() -> None:
    invalid_json = ModelTurn(
        content='{"objects": [',
        reasoning_content="检查 JSON 语法。",
    )
    model = FakeModel(
        [
            invalid_json,
            invalid_json,
            invalid_json,
            _turn(),
            _turn(start_block_id="p0001-b0001"),
        ]
    )
    compiler = LeafBasicCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
    )

    artifact = await compiler.compile("region-0002")

    assert artifact.model_calls == 5
    assert [model.calls[index]["request_label"] for index in range(1, 4)] == [
        "基础编译·region-0002·提取·修复1",
        "基础编译·region-0002·提取·修复2",
        "基础编译·region-0002·提取·修复3",
    ]
    assert all(call["thinking"] == "enabled" for call in model.calls)


@pytest.mark.asyncio
async def test_stops_after_three_failed_repairs() -> None:
    invalid_json = ModelTurn(
        content='{"objects": [',
        reasoning_content="检查 JSON 语法。",
    )
    model = FakeModel([invalid_json] * 4)
    compiler = LeafBasicCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
    )

    with pytest.raises(ValueError, match="不存在 JSON 对象"):
        await compiler.compile("region-0002")

    assert len(model.calls) == 4
    assert model.calls[-1]["request_label"] == "基础编译·region-0002·提取·修复3"
    assert all(call["thinking"] == "enabled" for call in model.calls)


@pytest.mark.asyncio
async def test_uncovered_source_and_unused_evidence_are_visible_warnings() -> None:
    model = FakeModel([_turn(), _turn(add_unused_evidence=True)])
    compiler = LeafBasicCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
    )

    artifact = await compiler.compile("region-0002")

    assert artifact.model_calls == 2
    assert artifact.uncovered_block_ids == []
    assert any("evidence-2" in warning for warning in artifact.warnings)


@pytest.mark.asyncio
async def test_empty_semantic_submission_requires_repair() -> None:
    model = FakeModel(
        [
            _turn(evidence_only=True),
            _turn(),
            _turn(start_block_id="p0001-b0001"),
        ]
    )
    compiler = LeafBasicCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
    )

    artifact = await compiler.compile("region-0002")

    assert artifact.model_calls == 3
    assert "没有叙述时不能单独提交依据" in str(
        model.calls[1]["messages"][-1]["content"]
    )


@pytest.mark.asyncio
async def test_allows_empty_package_for_document_navigation() -> None:
    empty = ModelTurn(
        content=json.dumps(
            {
                "schema_version": "object-assertion-evidence-package.v4",
                "objects": [],
                "assertions": [],
                "evidence": [],
            },
            ensure_ascii=False,
        ),
        reasoning_content="当前原文只有文档导航，没有协会现实命题。",
    )
    model = FakeModel([empty, empty])
    compiler = LeafBasicCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
    )

    artifact = await compiler.compile("region-0002")

    assert artifact.package.objects == []
    assert artifact.package.assertions == []
    assert artifact.package.evidence == []
    assert artifact.model_calls == 2


@pytest.mark.asyncio
async def test_rejects_non_leaf_without_calling_model() -> None:
    model = FakeModel([])
    compiler = LeafBasicCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
    )

    with pytest.raises(ValueError, match="不是叶子节点"):
        await compiler.compile("region-0001")

    assert not model.calls


@pytest.mark.asyncio
async def test_compiles_content_source_owned_by_parent() -> None:
    exploration = _exploration()
    root, leaf = exploration.region_tree.nodes
    parent_source = SourceSegment(
        start_block_id="p0001-b0001",
        end_block_id="p0001-b0001",
    )
    child_source = SourceSegment(
        start_block_id="p0001-b0002",
        end_block_id="p0001-b0002",
    )
    exploration = exploration.model_copy(
        update={
            "region_tree": exploration.region_tree.model_copy(
                update={
                    "nodes": [
                        root.model_copy(
                            update={
                                "owned_segments": [parent_source],
                                "owned_source_role": "content_source",
                            }
                        ),
                        leaf.model_copy(
                            update={
                                "start_block_id": "p0001-b0002",
                                "owned_segments": [child_source],
                            }
                        ),
                    ],
                    "content_node_ids": ["region-0001", "region-0002"],
                }
            )
        }
    )
    model = FakeModel(
        [
            _turn(start_block_id="p0001-b0001", end_block_id="p0001-b0001"),
            _turn(start_block_id="p0001-b0001", end_block_id="p0001-b0001"),
        ]
    )
    compiler = LeafBasicCompiler(
        model=model,
        exploration=exploration,
        blocks=_blocks(),
    )

    artifact = await compiler.compile_owned_source("region-0001")

    assert artifact.region_node_id == "region-0001"
    assert artifact.source_block_ids == ["p0001-b0001"]
    assert artifact.covered_block_ids == ["p0001-b0001"]


@pytest.mark.asyncio
async def test_accepts_json_body_inside_markdown_fence() -> None:
    first = _turn()
    fenced = ModelTurn(
        content=f"```json\n{first.content}\n```",
        reasoning_content=first.reasoning_content,
    )
    model = FakeModel([fenced, _turn(start_block_id="p0001-b0001")])
    compiler = LeafBasicCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
    )

    artifact = await compiler.compile("region-0002")

    assert artifact.package.objects[0].label == "继往开来杯"
