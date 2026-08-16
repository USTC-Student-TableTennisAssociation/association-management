from __future__ import annotations

import json
import shutil
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from cold_start.compilation import (
    FullBasicCompilationRunner,
    create_full_artifact_paths,
    open_full_artifact_paths,
)
from cold_start.config import CompilationSettings
from cold_start.document.models import ParsedBlock
from cold_start.global_exploration.models import (
    GlobalExplorationSnapshot,
    SourceMetadata,
)
from cold_start.llm.base import ModelTurn, ThinkingMode
from cold_start.region_tree.models import RegionNode, RegionTreeSnapshot, SourceSegment


def _unknown_time() -> dict[str, object]:
    return {
        "kind": "unknown",
        "display": "时间不明",
        "start": None,
        "end": None,
        "precision": "unspecified",
    }


class FullCompilationFakeModel:
    def __init__(
        self,
        *,
        parent_failures: int = 0,
        recover_missing_object: bool = False,
    ) -> None:
        self.calls: list[dict[str, object]] = []
        self.parent_failures = parent_failures
        self.parent_calls = 0
        self.recover_missing_object = recover_missing_object

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
        if request_label.startswith("基础编译·region-0002"):
            return _source_turn(
                statement_suffix="在2024年核心干事约15人。",
                block_id="p0001-b0002",
            )
        if request_label.startswith("基础编译·region-0003"):
            return _activity_source_turn()
        if request_label.startswith("父节点整合·region-0001"):
            self.parent_calls += 1
            if self.parent_calls <= self.parent_failures:
                return ModelTurn(
                    content='{"object_merges": [',
                    reasoning_content="检查父节点操作 JSON。",
                )
            return ModelTurn(
                content=json.dumps(
                    {
                        "object_merges": [
                            {
                                "object_ids": [
                                    "region-0002/obj-1",
                                    "region-0003/obj-1",
                                ],
                                "preferred_object_id": "region-0002/obj-1",
                                "reason": "两个孩子都明确指向同一乒协。",
                            }
                        ],
                        "assertion_merges": [],
                        "assertion_revisions": [
                            {
                                "assertion_id": "region-0003/assert-1",
                                "mode": "record",
                                "statement_template_markdown": (
                                    "{{object:region-0003/obj-1}}每学年举办"
                                    "{{object:region-0003/obj-2}}。"
                                ),
                                "holder_object_id": None,
                                "temporal_scope": _unknown_time(),
                                "temporal_basis_markdown": "原文和上下文没有可定位时间。",
                                "uncertainty_markdown": None,
                                "reason": "大型比赛已经是 Object，但原叙述漏标了引用。",
                            }
                        ],
                    },
                    ensure_ascii=False,
                ),
                reasoning_content="核对两个孩子中的乒协是否指向同一对象。",
            )
        if request_label.startswith("缺失对象发现·region-0001"):
            candidates = []
            if self.recover_missing_object:
                candidates = [
                    {
                        "candidate_id": "candidate-1",
                        "proposed_label": "核心干事",
                        "proposed_aliases": [],
                        "supporting_assertion_ids": ["region-0002/assert-1"],
                        "proof_evidence_ids": ["region-0002/evidence-1"],
                        "bindings": [
                            {
                                "assertion_id": "region-0002/assert-1",
                                "literal_surface": "核心干事",
                            }
                        ],
                        "reason": "原文持续指认核心干事，Assertion 仍保留字面名称。",
                    }
                ]
            return ModelTurn(
                content=json.dumps({"candidates": candidates}, ensure_ascii=False),
                reasoning_content="只寻找现有 Assertion 中缺失的稳定对象端点。",
            )
        if request_label.startswith("缺失对象复查·region-0001"):
            return ModelTurn(
                content=json.dumps(
                    {
                        "decisions": [
                            {
                                "candidate_id": "candidate-1",
                                "verdict": "accept",
                                "confirmed_label": "核心干事",
                                "confirmed_aliases": [],
                                "confirmed_bindings": [
                                    {
                                        "assertion_id": "region-0002/assert-1",
                                        "literal_surface": "核心干事",
                                    }
                                ],
                                "confirmed_evidence_ids": [
                                    "region-0002/evidence-1"
                                ],
                                "reason": "Evidence 明确支持该对象及绑定。",
                            }
                        ]
                    },
                    ensure_ascii=False,
                ),
                reasoning_content="独立核对 Evidence 与字面绑定。",
            )
        raise AssertionError(f"未预期的模型调用：{request_label}")


def _source_turn(*, statement_suffix: str, block_id: str) -> ModelTurn:
    return ModelTurn(
        content=json.dumps(
            {
                "schema_version": "object-assertion-evidence-package.v4",
                "objects": [
                    {
                        "object_id": "obj-1",
                        "label": "乒协",
                        "aliases": [],
                    }
                ],
                "assertions": [
                    {
                        "assertion_id": "assert-1",
                        "mode": "record",
                        "statement_template_markdown": ("{{object:obj-1}}" + statement_suffix),
                        "holder_object_id": None,
                        "temporal_scope": _unknown_time(),
                        "temporal_basis_markdown": "原文和上下文没有可定位时间。",
                        "uncertainty_markdown": None,
                        "evidence_ids": ["evidence-1"],
                    }
                ],
                "evidence": [
                    {
                        "evidence_id": "evidence-1",
                        "start_block_id": block_id,
                        "end_block_id": block_id,
                        "note_markdown": None,
                    }
                ],
            },
            ensure_ascii=False,
        ),
        reasoning_content="逐块检查原子叙述与依据。",
    )


def _activity_source_turn() -> ModelTurn:
    return ModelTurn(
        content=json.dumps(
            {
                "schema_version": "object-assertion-evidence-package.v4",
                "objects": [
                    {"object_id": "obj-1", "label": "乒协", "aliases": []},
                    {"object_id": "obj-2", "label": "大型比赛", "aliases": []},
                ],
                "assertions": [
                    {
                        "assertion_id": "assert-1",
                        "mode": "record",
                        "statement_template_markdown": ("{{object:obj-1}}每学年举办大型比赛。"),
                        "holder_object_id": None,
                        "temporal_scope": _unknown_time(),
                        "temporal_basis_markdown": "原文和上下文没有可定位时间。",
                        "uncertainty_markdown": None,
                        "evidence_ids": ["evidence-1"],
                    },
                    {
                        "assertion_id": "assert-2",
                        "mode": "record",
                        "statement_template_markdown": ("{{object:obj-2}}是每学年举办的活动。"),
                        "holder_object_id": None,
                        "temporal_scope": _unknown_time(),
                        "temporal_basis_markdown": "原文和上下文没有可定位时间。",
                        "uncertainty_markdown": None,
                        "evidence_ids": ["evidence-1"],
                    },
                ],
                "evidence": [
                    {
                        "evidence_id": "evidence-1",
                        "start_block_id": "p0001-b0003",
                        "end_block_id": "p0001-b0003",
                        "note_markdown": None,
                    }
                ],
            },
            ensure_ascii=False,
        ),
        reasoning_content="检查大型比赛对象与 Assertion 引用。",
    )


def _blocks() -> tuple[ParsedBlock, ...]:
    return (
        ParsedBlock(
            block_id="p0001-b0001",
            order=0,
            block_type="heading",
            source_pages=(1,),
            heading_level=1,
            heading_path=("测试手册",),
            markdown="# 测试手册",
        ),
        ParsedBlock(
            block_id="p0001-b0002",
            order=1,
            block_type="paragraph",
            source_pages=(1,),
            heading_path=("测试手册",),
            markdown="2024年乒协核心干事约15人。",
        ),
        ParsedBlock(
            block_id="p0001-b0003",
            order=2,
            block_type="paragraph",
            source_pages=(1,),
            heading_path=("测试手册",),
            markdown="乒协每学年举办大型比赛。",
        ),
    )


def _exploration() -> GlobalExplorationSnapshot:
    root = RegionNode(
        node_id="region-0001",
        parent_id=None,
        depth=0,
        label="测试手册",
        introduction="介绍协会现状和活动。",
        start_block_id="p0001-b0001",
        end_block_id="p0001-b0003",
        source_pages=[1],
        status="branch",
        owned_segments=[
            SourceSegment(
                start_block_id="p0001-b0001",
                end_block_id="p0001-b0001",
            )
        ],
        owned_source_role="structural_context",
        child_ids=["region-0002", "region-0003"],
    )
    leaves = [
        RegionNode(
            node_id="region-0002",
            parent_id="region-0001",
            depth=1,
            label="组织现状",
            introduction="记录人员规模。",
            start_block_id="p0001-b0002",
            end_block_id="p0001-b0002",
            source_pages=[1],
            status="leaf",
            owned_segments=[
                SourceSegment(
                    start_block_id="p0001-b0002",
                    end_block_id="p0001-b0002",
                )
            ],
            owned_source_role="content_source",
        ),
        RegionNode(
            node_id="region-0003",
            parent_id="region-0001",
            depth=1,
            label="活动情况",
            introduction="记录大型比赛。",
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
        ),
    ]
    return GlobalExplorationSnapshot(
        created_at=datetime.now(UTC),
        source=SourceMetadata(
            path="handbook.pdf",
            title="测试手册",
            sha256="a" * 64,
            parser="fake",
            page_count=1,
            block_count=3,
        ),
        document_context_markdown="这是一份协会手册。",
        context_model_calls=1,
        region_tree=RegionTreeSnapshot(
            status="frozen",
            root_node_id="region-0001",
            nodes=[root, *leaves],
            leaf_node_ids=["region-0002", "region-0003"],
            content_node_ids=["region-0002", "region-0003"],
            structural_context_node_ids=["region-0001"],
        ),
    )


@pytest.mark.asyncio
async def test_compiles_all_sources_and_integrates_to_root(tmp_path: Path) -> None:
    model = FullCompilationFakeModel()
    paths = create_full_artifact_paths(tmp_path)
    snapshot = await FullBasicCompilationRunner(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=paths,
        settings=CompilationSettings(
            max_parallel_sources=1,
            max_parallel_parents=1,
        ),
    ).run()

    assert snapshot.root_node_id == "region-0001"
    assert len(snapshot.root_package.objects) == 2
    assert len(snapshot.root_package.assertions) == 3
    assert len(snapshot.root_package.evidence) == 2
    assert snapshot.covered_block_ids == ["p0001-b0002", "p0001-b0003"]
    assert snapshot.uncovered_block_ids == []
    assert snapshot.structural_context_block_ids == ["p0001-b0001"]
    assert snapshot.model_calls == 6
    assert len(model.calls) == 6
    assert all(call["tools"] == () for call in model.calls)
    assert all(call["tool_choice"] is None for call in model.calls)
    assert all(call["thinking"] == "enabled" for call in model.calls)
    assert paths.snapshot_json.is_file()
    assert paths.root_package_json.is_file()
    assert paths.report_markdown.is_file()
    assert (paths.sources / "region-0002" / "source-compilation.md").is_file()
    assert (paths.nodes / "region-0001.json").is_file()
    parent_call = next(
        call
        for call in model.calls
        if call["request_label"] == "父节点整合·region-0001"
    )
    parent_prompt = str(parent_call["messages"][-1]["content"])
    parent_system = str(parent_call["messages"][0]["content"])
    assert "不要建立任何连接" in parent_prompt
    assert "{{object:region-0002/obj-1}}在2024年核心干事约15人" in parent_prompt
    assert "`preferred_object_id`" in parent_system
    assert "`preferred_assertion_id`" in parent_system
    assert "`statement_template_markdown`" in parent_system
    assert "record 必须为 `null`" in parent_system
    assert "possible_missing_object_references" in parent_prompt
    assert "region-0003/obj-2" in parent_prompt
    repaired_assertion = next(
        item
        for item in snapshot.root_package.assertions
        if item.assertion_id == "region-0003/assert-1"
    )
    assert repaired_assertion.referenced_object_ids == [
        "region-0002/obj-1",
        "region-0003/obj-2",
    ]
    assert (paths.nodes / "region-0001.missing-objects.json").is_file()


@pytest.mark.asyncio
async def test_parent_can_use_three_thinking_repairs(tmp_path: Path) -> None:
    model = FullCompilationFakeModel(parent_failures=3)
    paths = create_full_artifact_paths(tmp_path)

    snapshot = await FullBasicCompilationRunner(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=paths,
        settings=CompilationSettings(
            max_parallel_sources=1,
            max_parallel_parents=1,
        ),
    ).run()

    parent_calls = [
        call
        for call in model.calls
        if str(call["request_label"]).startswith("父节点整合·region-0001")
    ]
    assert snapshot.model_calls == 9
    assert [call["request_label"] for call in parent_calls] == [
        "父节点整合·region-0001",
        "父节点整合·region-0001·修复1",
        "父节点整合·region-0001·修复2",
        "父节点整合·region-0001·修复3",
    ]
    assert all(call["thinking"] == "enabled" for call in parent_calls)


@pytest.mark.asyncio
async def test_resume_reuses_completed_sources_and_only_compiles_missing(
    tmp_path: Path,
) -> None:
    paths = create_full_artifact_paths(tmp_path)
    await FullBasicCompilationRunner(
        model=FullCompilationFakeModel(),
        exploration=_exploration(),
        blocks=_blocks(),
        paths=paths,
        settings=CompilationSettings(max_parallel_sources=1, max_parallel_parents=1),
    ).run()
    paths.snapshot_json.unlink()
    shutil.rmtree(paths.sources / "region-0003")

    resumed_model = FullCompilationFakeModel()
    snapshot = await FullBasicCompilationRunner(
        model=resumed_model,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=open_full_artifact_paths(paths.directory),
        settings=CompilationSettings(max_parallel_sources=1, max_parallel_parents=1),
    ).run()

    labels = [str(call["request_label"]) for call in resumed_model.calls]
    assert not any(label.startswith("基础编译·region-0002") for label in labels)
    assert sum(label.startswith("基础编译·region-0003") for label in labels) == 2
    assert labels[-1] == "缺失对象发现·region-0001"
    assert snapshot.model_calls == 6


@pytest.mark.asyncio
async def test_parent_recovers_missing_object_only_after_evidence_review(
    tmp_path: Path,
) -> None:
    model = FullCompilationFakeModel(recover_missing_object=True)
    paths = create_full_artifact_paths(tmp_path)

    snapshot = await FullBasicCompilationRunner(
        model=model,
        exploration=_exploration(),
        blocks=_blocks(),
        paths=paths,
        settings=CompilationSettings(max_parallel_sources=1, max_parallel_parents=1),
    ).run()

    recovered = next(
        item for item in snapshot.root_package.objects if item.label == "核心干事"
    )
    assertion = next(
        item
        for item in snapshot.root_package.assertions
        if item.assertion_id == "region-0002/assert-1"
    )
    assert recovered.object_id == "region-0001/obj-1"
    assert recovered.object_id in assertion.referenced_object_ids
    assert "核心干事" not in assertion.statement_template_markdown
    root_result = next(
        item for item in snapshot.node_results if item.node_id == "region-0001"
    )
    assert root_result.recovered_object_count == 1
    assert root_result.missing_object_model_calls == 2
    assert snapshot.model_calls == 7
