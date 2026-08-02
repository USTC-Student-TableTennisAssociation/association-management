from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from cold_start.compilation.leaf import (
    FORCED_SUBMIT_TOOL,
    SUBMIT_MEMORY_PACKAGE_TOOL,
    LeafObjectCompiler,
    create_leaf_artifact_paths,
    write_leaf_artifact,
)
from cold_start.document.models import ParsedBlock
from cold_start.global_exploration.models import (
    GlobalExplorationSnapshot,
    SourceMetadata,
)
from cold_start.llm.base import ModelTurn, ThinkingMode, ToolCall
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
    end_block_id: str = "p0001-b0002",
    assertion_kind: str = "practice",
    add_unused_evidence: bool = False,
    evidence_only: bool = False,
) -> ModelTurn:
    arguments = {
        "objects": [
            {
                "object_id": "obj-1",
                "label": "继往开来杯",
                "kind_hints": ["activity"],
                "evidence_ids": ["evidence-1"],
            }
        ],
        "assertions": [
            {
                "assertion_id": "assert-1",
                "about_object_ids": ["obj-1"],
                "mode": "record",
                "kind_hint": assertion_kind,
                "statement_markdown": "继往开来杯过去通常申请两个场地。",
                "evidence_ids": ["evidence-1"],
            }
        ],
        "relations": [],
        "evidence": [
            {
                "evidence_id": "evidence-1",
                "start_block_id": "p0001-b0002",
                "end_block_id": end_block_id,
                "role": "basis",
            }
        ],
        "unresolved": [],
    }
    if add_unused_evidence:
        arguments["evidence"].append(
            {
                "evidence_id": "evidence-2",
                "start_block_id": "p0001-b0001",
                "end_block_id": "p0001-b0001",
                "role": "context",
            }
        )
    if evidence_only:
        arguments.update(objects=[], assertions=[], relations=[], unresolved=[])
    return ModelTurn(
        content="",
        tool_calls=(
            ToolCall(
                id="call-1",
                name="submit_memory_package",
                arguments=json.dumps(arguments, ensure_ascii=False),
            ),
        ),
    )


@pytest.mark.asyncio
async def test_compiles_one_leaf_through_forced_tool(tmp_path: Path) -> None:
    model = FakeModel([_turn()])
    compiler = LeafObjectCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
    )

    artifact = await compiler.compile("region-0002")

    assert artifact.model_calls == 1
    assert artifact.package.objects[0].label == "继往开来杯"
    assert artifact.package.assertions[0].kind_hint == "practice"
    assert model.calls[0]["tools"] == SUBMIT_MEMORY_PACKAGE_TOOL
    assert model.calls[0]["tool_choice"] == FORCED_SUBMIT_TOOL
    assert model.calls[0]["thinking"] == "enabled"
    prompt = str(model.calls[0]["messages"][-1]["content"])
    assert "这是协会活动手册" in prompt
    assert "region-0001｜测试手册" in prompt
    assert "[p0001-b0002" in prompt

    paths = create_leaf_artifact_paths(tmp_path, "region-0002")
    write_leaf_artifact(paths, artifact)
    assert json.loads(paths.snapshot_json.read_text(encoding="utf-8"))[
        "region_node_id"
    ] == "region-0002"
    assert "继往开来杯" in paths.report_markdown.read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_invalid_evidence_gets_only_one_repair() -> None:
    model = FakeModel([_turn(end_block_id="p0001-b0099"), _turn()])
    compiler = LeafObjectCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
    )

    artifact = await compiler.compile("region-0002")

    assert artifact.model_calls == 2
    assert len(model.calls) == 2
    assert model.calls[1]["thinking"] == "disabled"
    repair_messages = model.calls[1]["messages"]
    assert any(message["role"] == "tool" for message in repair_messages)
    assert "不存在来源块" in str(repair_messages[-1]["content"])


@pytest.mark.asyncio
async def test_semantic_mismatch_and_unused_evidence_do_not_trigger_repair() -> None:
    model = FakeModel([_turn(assertion_kind="evaluation", add_unused_evidence=True)])
    compiler = LeafObjectCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
    )

    artifact = await compiler.compile("region-0002")

    assert artifact.model_calls == 1
    assert any("kind_hint=evaluation" in warning for warning in artifact.warnings)
    assert any("evidence-2" in warning for warning in artifact.warnings)


@pytest.mark.asyncio
async def test_evidence_only_submission_requires_semantic_repair() -> None:
    model = FakeModel([_turn(evidence_only=True), _turn()])
    compiler = LeafObjectCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
    )

    artifact = await compiler.compile("region-0002")

    assert artifact.model_calls == 2
    assert "不能只提交 Evidence" in str(model.calls[1]["messages"][-1]["content"])


@pytest.mark.asyncio
async def test_rejects_non_leaf_without_calling_model() -> None:
    model = FakeModel([])
    compiler = LeafObjectCompiler(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
    )

    with pytest.raises(ValueError, match="不是叶子节点"):
        await compiler.compile("region-0001")

    assert not model.calls


def test_submission_schema_requires_all_arrays_and_semantic_content() -> None:
    schema = SUBMIT_MEMORY_PACKAGE_TOOL[0]["function"]["parameters"]

    assert set(schema["required"]) == {
        "objects",
        "assertions",
        "relations",
        "evidence",
        "unresolved",
    }
    assert len(schema["anyOf"]) == 4
