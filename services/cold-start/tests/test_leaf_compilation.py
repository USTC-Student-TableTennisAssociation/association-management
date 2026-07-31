from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from cold_start.compilation.models import (
    LeafCompilationSnapshot,
    MemoryCardCandidate,
)
from cold_start.compilation.runner import (
    LeafCompilationRunner,
    create_compilation_directory,
    load_exploration_inputs,
    write_compilation_artifacts,
)
from cold_start.config import CompilationSettings
from cold_start.document.blocks import build_document_blocks
from cold_start.document.models import ParsedPage
from cold_start.global_exploration.models import (
    GlobalExplorationSnapshot,
    SourceMetadata,
)
from cold_start.llm.base import ModelTurn, ThinkingMode
from cold_start.region_tree.models import (
    RegionNode,
    RegionTreeSnapshot,
    SourceSegment,
)


class LeafModel:
    def __init__(
        self,
        *,
        first_missing_coverage: bool = False,
        include_unused_evidence: bool = False,
    ) -> None:
        self.first_missing_coverage = first_missing_coverage
        self.include_unused_evidence = include_unused_evidence
        self.calls: list[ThinkingMode | None] = []

    async def complete(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.0,
        request_label: str = "模型",
    ) -> str:
        del system_prompt, user_prompt, temperature, request_label
        raise AssertionError("叶子编译不应调用 complete")

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
        del temperature, request_label
        assert not tools and tool_choice is None
        self.calls.append(thinking)
        system_prompt = str(messages[0]["content"])
        assert "就足以建立 role" in system_prompt
        assert "覆盖检查以原文 block 为单位" in system_prompt
        assert "不要求把一个 block 内的每个" in system_prompt
        assert "词句都分别编译" in system_prompt
        assert "不要为了寻找“唯一最佳分类”反复推翻" in system_prompt
        prompt = str(messages[1]["content"])
        assert "[STAGE: compile_leaf]" in prompt
        assert "new_cards" in prompt
        assert "当前叶子完整原文" in prompt
        if self.first_missing_coverage and len(self.calls) == 1:
            return ModelTurn(content=json.dumps(_valid_output(cover_second_half=False)))
        if len(messages) > 2:
            assert "既无依据也无未编译说明" in str(messages[-1]["content"])
        return ModelTurn(
            content=json.dumps(
                _valid_output(include_unused_evidence=self.include_unused_evidence),
                ensure_ascii=False,
            )
        )


def _valid_output(
    *,
    cover_second_half: bool = True,
    include_unused_evidence: bool = False,
) -> dict[str, object]:
    evidence = [
        {
            "evidence_id": "evidence-1",
            "start_block_id": "p0001-b0001",
            "end_block_id": "p0001-b0002",
            "role": "basis",
            "note_markdown": "标题和正文共同说明活动身份。",
        }
    ]
    uncompiled = []
    if cover_second_half:
        evidence.append(
            {
                "evidence_id": "evidence-2",
                "start_block_id": "p0001-b0003",
                "end_block_id": "p0001-b0004",
                "role": "basis",
                "note_markdown": "标题和正文共同说明申请规则。",
            }
        )
    if include_unused_evidence:
        evidence.append(
            {
                "evidence_id": "evidence-3",
                "start_block_id": "p0001-b0001",
                "end_block_id": "p0001-b0001",
                "role": "context",
                "note_markdown": "模型额外生成但未被任何卡片或边引用的标题上下文。",
            }
        )
    return {
        "new_cards": [
            {
                "card_id": "card-1",
                "kind": "activity_pattern",
                "title": "继往开来杯",
                "summary": "乒协每学年举办的品牌比赛。",
                "content": {
                    "description_markdown": "乒协长期举办的品牌比赛。",
                    "recurrence_kind": "annual",
                    "typical_timing_markdown": "每学年举办。",
                },
                "evidence_ids": ["evidence-1"],
            },
            *(
                [
                    {
                        "card_id": "card-2",
                        "kind": "rule",
                        "title": "大型比赛二课申请时限",
                        "summary": "大型比赛必须提前七天申请二课。",
                        "content": {
                            "statement_markdown": "大型比赛必须提前七天申请二课。"
                        },
                        "evidence_ids": ["evidence-2"],
                    }
                ]
                if cover_second_half
                else []
            ),
        ],
        "local_edges": (
            [
                {
                    "edge_id": "edge-1",
                    "from_card_id": "card-2",
                    "to_card_id": "card-1",
                    "relation_type": "applies_to",
                    "evidence_ids": ["evidence-2"],
                }
            ]
            if cover_second_half
            else []
        ),
        "source_evidence": evidence,
        "uncompiled_segments": uncompiled,
    }


def _inputs() -> tuple[GlobalExplorationSnapshot, tuple]:
    blocks = build_document_blocks(
        (
            ParsedPage(
                page_number=1,
                markdown=(
                    "# 比赛\n\n每学年举办继往开来杯。\n\n"
                    "## 申请规则\n\n大型比赛必须提前七天申请二课。"
                ),
            ),
            ParsedPage(page_number=2, markdown="# 附录"),
        )
    )
    root = RegionNode(
        node_id="region-0001",
        parent_id=None,
        depth=0,
        label="测试手册",
        introduction="协会活动手册。",
        start_block_id="p0001-b0001",
        end_block_id="p0002-b0001",
        source_pages=[1, 2],
        status="branch",
        owned_segments=[],
        owned_source_role=None,
        decision_reason="按正文和附录切分。",
        child_ids=["region-0002", "region-0003"],
    )
    content_leaf = RegionNode(
        node_id="region-0002",
        parent_id="region-0001",
        depth=1,
        label="比赛",
        introduction="比赛身份和申请要求。",
        start_block_id="p0001-b0001",
        end_block_id="p0001-b0004",
        source_pages=[1],
        status="leaf",
        owned_segments=[
            SourceSegment(
                start_block_id="p0001-b0001",
                end_block_id="p0001-b0004",
            )
        ],
        owned_source_role="content_source",
        decision_reason="完整局部编译语境。",
    )
    structural_leaf = RegionNode(
        node_id="region-0003",
        parent_id="region-0001",
        depth=1,
        label="附录标题",
        introduction="纯标题。",
        start_block_id="p0002-b0001",
        end_block_id="p0002-b0001",
        source_pages=[2],
        status="leaf",
        owned_segments=[
            SourceSegment(
                start_block_id="p0002-b0001",
                end_block_id="p0002-b0001",
            )
        ],
        owned_source_role="structural_context",
        decision_reason="没有实质陈述。",
    )
    tree = RegionTreeSnapshot(
        status="frozen",
        root_node_id="region-0001",
        nodes=[root, content_leaf, structural_leaf],
        leaf_node_ids=["region-0002", "region-0003"],
        content_node_ids=["region-0002"],
        structural_context_node_ids=["region-0003"],
    )
    exploration = GlobalExplorationSnapshot(
        created_at=datetime.now(UTC),
        source=SourceMetadata(
            path="/tmp/handbook.pdf",
            title="测试手册",
            sha256="a" * 64,
            parser="fake",
            page_count=2,
            block_count=len(blocks),
        ),
        document_context_markdown="这是协会活动手册。",
        context_model_calls=1,
        region_tree=tree,
    )
    return exploration, blocks


@pytest.mark.asyncio
async def test_content_leaf_compiles_to_evidenced_local_subgraph() -> None:
    exploration, blocks = _inputs()
    checkpoints: list[LeafCompilationSnapshot] = []
    model = LeafModel()
    snapshot = await LeafCompilationRunner(
        model=model,
        exploration=exploration,
        blocks=blocks,
        settings=CompilationSettings(max_parallel_leaves=2),
        checkpoint=checkpoints.append,
    ).run()

    assert snapshot.status == "complete"
    assert snapshot.model_calls == 1
    assert len(snapshot.leaf_results) == 1
    result = snapshot.leaf_results[0]
    assert result.leaf_node_id == "region-0002"
    assert result.status == "compiled"
    assert result.subgraph is not None
    assert len(result.subgraph.new_cards) == 2
    assert len(result.subgraph.local_edges) == 1
    assert model.calls == ["enabled"]
    assert checkpoints[-1].status == "running"


@pytest.mark.asyncio
async def test_missing_block_coverage_triggers_non_thinking_repair() -> None:
    exploration, blocks = _inputs()
    model = LeafModel(first_missing_coverage=True)
    snapshot = await LeafCompilationRunner(
        model=model,
        exploration=exploration,
        blocks=blocks,
    ).run()

    assert snapshot.status == "complete"
    assert snapshot.model_calls == 2
    assert model.calls == ["enabled", "disabled"]


@pytest.mark.asyncio
async def test_unused_evidence_is_removed_without_triggering_repair() -> None:
    exploration, blocks = _inputs()
    model = LeafModel(include_unused_evidence=True)
    snapshot = await LeafCompilationRunner(
        model=model,
        exploration=exploration,
        blocks=blocks,
    ).run()

    assert snapshot.status == "complete"
    assert snapshot.model_calls == 1
    subgraph = snapshot.leaf_results[0].subgraph
    assert subgraph is not None
    assert [item.evidence_id for item in subgraph.source_evidence] == [
        "evidence-1",
        "evidence-2",
    ]


def test_card_content_fields_are_validated_by_kind() -> None:
    with pytest.raises(ValidationError, match="work_step 缺少必填内容字段"):
        MemoryCardCandidate(
            card_id="card-1",
            kind="work_step",
            title="二课申请",
            summary="申请二课。",
            content={"statement_markdown": "提前申请。"},
            evidence_ids=["evidence-1"],
        )


def test_compilation_artifacts_can_reload_exploration_and_render_report(
    tmp_path: Path,
) -> None:
    exploration, blocks = _inputs()
    run_directory = tmp_path / "run"
    run_directory.mkdir()
    (run_directory / "global-exploration.json").write_text(
        exploration.model_dump_json(indent=2),
        encoding="utf-8",
    )
    (run_directory / "parsed-blocks.json").write_text(
        json.dumps(
            [block.model_dump() for block in blocks],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    loaded_exploration, loaded_blocks = load_exploration_inputs(run_directory)
    assert loaded_exploration.source.sha256 == "a" * 64
    assert loaded_blocks == blocks

    paths = create_compilation_directory(run_directory)
    snapshot = LeafCompilationSnapshot(
        created_at=datetime.now(UTC),
        status="complete",
        source=exploration.source,
        region_tree_schema_version=exploration.region_tree.schema_version,
        leaf_results=[],
        deferred_content_node_ids=[],
    )
    write_compilation_artifacts(paths=paths, snapshot=snapshot, blocks=blocks)

    assert paths.snapshot_json.is_file()
    assert "叶子局部编译结果" in paths.report_markdown.read_text(encoding="utf-8")
