from __future__ import annotations

import json
from pathlib import Path

import pytest

from cold_start.config import ExplorationSettings
from cold_start.document.models import ParsedDocument, ParsedPage
from cold_start.global_exploration.graph import GlobalExplorationRunner


class RecordingProgressReporter:
    def __init__(self) -> None:
        self.events: list[tuple[str, str]] = []

    def report(self, stage: str, message: str) -> None:
        self.events.append((stage, message))


def landscape_observation_payload() -> dict:
    return {
        "unit_pages": [1],
        "memory_areas": [
            {
                "label": "活动申报与行政工作",
                "coverage": "活动申报及相关行政事项",
                "source_pages": [1],
            }
        ],
        "global_signals": [
            {
                "label": "二课申请",
                "context": "在行政工作章节中作为明确主题出现",
                "basis": ["heading"],
                "source_pages": [1],
            }
        ],
        "explicit_relations": [],
    }


def memory_landscape_payload() -> dict:
    return {
        "scope_note": "只用于定位后续阅读区域，不是记忆内容或节点地图。",
        "memory_areas": [
            {
                "label": "活动申报与行政工作",
                "coverage": "活动申报、经费、场地和物资等行政工作",
                "source_pages": [2, 3],
            }
        ],
        "global_signals": [
            {
                "label": "二课申请",
                "context": "在行政工作和活动材料中出现",
                "basis": ["heading", "repeated"],
                "source_pages": [2, 3],
            }
        ],
        "explicit_relations": [],
    }


class AcceptingFakeModel:
    def __init__(self) -> None:
        self.prompts: list[str] = []
        self.system_prompts: list[str] = []

    async def complete(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.0,
        request_label: str = "模型",
    ) -> str:
        del temperature, request_label
        self.system_prompts.append(system_prompt)
        self.prompts.append(user_prompt)
        if "[ROUTE: structure]" in user_prompt:
            return "# 结构\n先介绍活动，再介绍行政工作。〔第 1 页〕"
        if "[ROUTE: profile]" in user_prompt:
            return "# 文档画像\n这是面向协会成员的历史与工作手册。〔第 1 页〕"
        if "[ROUTE: landscape_observation]" in user_prompt:
            return json.dumps(landscape_observation_payload(), ensure_ascii=False)
        if "[ROUTE: landscape_merge]" in user_prompt:
            return json.dumps(memory_landscape_payload(), ensure_ascii=False)
        if "[ROUTE: reconciliation]" in user_prompt:
            return json.dumps(
                {
                    "acceptable_as_global_exploration": True,
                    "overall_assessment": "三份产物保持了文档级和区域级粒度。",
                    "issues": [],
                    "non_blocking_notes": ["具体内容留待后续局部阅读。"],
                },
                ensure_ascii=False,
            )
        raise AssertionError(f"未处理的提示词：{user_prompt[:100]}")


class RevisingFakeModel(AcceptingFakeModel):
    def __init__(self) -> None:
        super().__init__()
        self.review_calls = 0

    async def complete(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.0,
        request_label: str = "模型",
    ) -> str:
        if "[ROUTE: reconciliation]" in user_prompt:
            self.system_prompts.append(system_prompt)
            self.prompts.append(user_prompt)
            self.review_calls += 1
            if self.review_calls == 1:
                return json.dumps(
                    {
                        "acceptable_as_global_exploration": False,
                        "overall_assessment": "画像展开了不必要的局部事实。",
                        "issues": [
                            {
                                "severity": "high",
                                "routes": ["profile"],
                                "description": "画像展开了第 2 页的具体历史实践",
                                "evidence_pages": [2],
                                "revision_instruction": "上收为文档级材料类型说明",
                            }
                        ],
                        "non_blocking_notes": [],
                    },
                    ensure_ascii=False,
                )
            return json.dumps(
                {
                    "acceptable_as_global_exploration": True,
                    "overall_assessment": "定向回看已恢复全局粒度。",
                    "issues": [],
                    "non_blocking_notes": [],
                },
                ensure_ascii=False,
            )
        if "[ROUTE: revision:profile]" in user_prompt:
            self.system_prompts.append(system_prompt)
            self.prompts.append(user_prompt)
            source_excerpt = user_prompt.split("定向回看的完整原文：", maxsplit=1)[1]
            assert "〔第 2 页〕" in source_excerpt
            assert "〔第 1 页〕" not in source_excerpt
            return "# 文档画像\n文档混合了历史叙述与工作说明。〔第 2 页〕"
        return await super().complete(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            temperature=temperature,
            request_label=request_label,
        )


def make_document() -> ParsedDocument:
    pages = tuple(
        ParsedPage(
            page_number=index,
            markdown=f"# 第 {index} 页\n{content}",
        )
        for index, content in enumerate(
            ("文档目标和读者。", "活动历史实践。", "二课申请公共流程。"),
            start=1,
        )
    )
    return ParsedDocument(
        source_path=Path("/tmp/乒协生存手册.pdf"),
        title="乒协生存手册",
        file_sha256="b" * 64,
        parser_name="test",
        pages=pages,
        markdown="完整手册",
    )


@pytest.mark.asyncio
async def test_routes_build_a_document_level_exploration_map() -> None:
    model = AcceptingFakeModel()
    progress = RecordingProgressReporter()
    snapshot = await GlobalExplorationRunner(
        model=model,
        progress=progress,
        settings=ExplorationSettings(
            profile_unit_chars=15,
            structure_preview_chars_per_page=15,
            landscape_unit_chars=15,
            landscape_overlap_pages=0,
            landscape_parallelism=2,
        ),
    ).run(make_document())

    structure_prompts = [
        prompt for prompt in model.prompts if "[ROUTE: structure]" in prompt
    ]
    profile_prompts = [
        prompt for prompt in model.prompts if "[ROUTE: profile]" in prompt
    ]
    observation_prompts = [
        prompt
        for prompt in model.prompts
        if "[ROUTE: landscape_observation]" in prompt
    ]
    merge_prompts = [
        prompt for prompt in model.prompts if "[ROUTE: landscape_merge]" in prompt
    ]

    assert len(structure_prompts) == 1
    assert "〔第 1 页〕" in structure_prompts[0]
    assert "〔第 3 页〕" in structure_prompts[0]
    assert any("source-page: 1" in prompt for prompt in profile_prompts)
    assert any("source-page: 3" in prompt for prompt in profile_prompts)
    assert len(observation_prompts) == 3
    assert all("先介绍活动，再介绍行政工作" in p for p in observation_prompts)
    assert all("候选节点" in p and "禁止" in p for p in observation_prompts)
    assert len(merge_prompts) == 1
    assert model.prompts.index(structure_prompts[0]) < model.prompts.index(
        profile_prompts[0]
    )
    assert model.prompts.index(structure_prompts[0]) < model.prompts.index(
        observation_prompts[0]
    )
    assert all(
        "本阶段不是记忆提取或记忆编译" in system_prompt
        for system_prompt in model.system_prompts
    )

    assert snapshot.schema_version == "global-exploration.v3"
    assert snapshot.authority == "preliminary-low-authority"
    assert snapshot.route_statistics.profile_units == 3
    assert snapshot.route_statistics.landscape_units == 3
    assert snapshot.route_statistics.landscape_merge_calls == 1
    assert len(snapshot.landscape_observations) == 3
    assert snapshot.document_memory_landscape.global_signals[0].label == "二课申请"
    assert snapshot.review_history[-1].acceptable_as_global_exploration is True
    assert snapshot.frozen_with_boundary_issues is False
    stages = [stage for stage, _ in progress.events]
    assert {"规划", "画像", "结构", "地形合并", "校验", "冻结"} <= set(stages)
    assert any(stage.startswith("地形勘探·") for stage in stages)


@pytest.mark.asyncio
async def test_review_can_trigger_targeted_reread_before_freeze() -> None:
    model = RevisingFakeModel()
    progress = RecordingProgressReporter()
    snapshot = await GlobalExplorationRunner(
        model=model,
        progress=progress,
        settings=ExplorationSettings(
            profile_unit_chars=100,
            structure_preview_chars_per_page=100,
            landscape_unit_chars=100,
            landscape_overlap_pages=0,
            max_review_rounds=2,
        ),
    ).run(make_document())

    assert model.review_calls == 2
    assert "历史叙述与工作说明" in snapshot.document_profile_markdown
    assert snapshot.route_statistics.review_rounds == 2
    assert snapshot.frozen_with_boundary_issues is False
    assert any(stage == "回看" for stage, _ in progress.events)
    assert any(stage == "回看·画像" for stage, _ in progress.events)
