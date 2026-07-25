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


class AcceptingFakeModel:
    def __init__(self) -> None:
        self.prompts: list[str] = []

    async def complete(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.0,
        request_label: str = "模型",
    ) -> str:
        del request_label
        self.prompts.append(user_prompt)
        if "[ROUTE: summary]" in user_prompt:
            return "# 总结\n这是面向协会成员的手册。〔第 1 页〕"
        if "[ROUTE: structure]" in user_prompt:
            return "# 结构\n先介绍活动，再介绍公共流程。〔第 1 页〕"
        if "[ROUTE: concept]" in user_prompt:
            return json.dumps(
                {
                    "document_level_observation": "文档沉淀了活动和公共流程。",
                    "global_signals": [
                        {
                            "label": "二课申请",
                            "observation": "多个活动可能复用",
                            "importance": "较高",
                            "importance_reason": "跨活动出现",
                            "source_pages": [2, 3],
                            "occurrence_count": 2,
                        }
                    ],
                    "candidate_concepts": [],
                    "coarse_relations": [],
                    "open_questions": ["其是否适用于所有比赛仍需局部编译确认"],
                },
                ensure_ascii=False,
            )
        if "[ROUTE: reconciliation]" in user_prompt:
            return json.dumps(
                {
                    "accepted_as_initial_impression": True,
                    "overall_assessment": "三条路径关注点不同但没有实质冲突。",
                    "issues": [],
                    "unresolved_uncertainties": ["公共流程的适用边界尚未确认"],
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
        del request_label
        if "[ROUTE: reconciliation]" in user_prompt:
            self.prompts.append(user_prompt)
            self.review_calls += 1
            if self.review_calls == 1:
                return json.dumps(
                    {
                        "accepted_as_initial_impression": False,
                        "overall_assessment": "总结漏掉实践不是制度。",
                        "issues": [
                            {
                                "severity": "high",
                                "routes": ["summary"],
                                "description": "总结把历史做法写成硬性要求",
                                "evidence_pages": [2],
                                "revision_instruction": "回看第 2 页并降低断言强度",
                            }
                        ],
                        "unresolved_uncertainties": [],
                    },
                    ensure_ascii=False,
                )
            return json.dumps(
                {
                    "accepted_as_initial_impression": True,
                    "overall_assessment": "定向回看已修复问题。",
                    "issues": [],
                    "unresolved_uncertainties": [],
                },
                ensure_ascii=False,
            )
        if "[ROUTE: revision:summary]" in user_prompt:
            self.prompts.append(user_prompt)
            source_excerpt = user_prompt.split("定向回看的原文：", maxsplit=1)[1]
            assert "〔第 2 页〕" in source_excerpt
            assert "〔第 1 页〕" not in source_excerpt
            return "# 总结\n第 2 页描述的是历史实践，不是制度。〔第 2 页〕"
        return await super().complete(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            temperature=temperature,
            request_label="模型",
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
async def test_three_routes_read_original_document_independently() -> None:
    model = AcceptingFakeModel()
    progress = RecordingProgressReporter()
    snapshot = await GlobalExplorationRunner(
        model=model,
        progress=progress,
        settings=ExplorationSettings(
            summary_unit_chars=15,
            structure_unit_chars=15,
            concept_unit_chars=15,
            structure_overlap_pages=0,
            concept_overlap_pages=0,
        ),
    ).run(make_document())

    for route in ("summary", "structure", "concept"):
        route_prompts = [prompt for prompt in model.prompts if f"[ROUTE: {route}]" in prompt]
        assert route_prompts
        assert any("source-page: 1" in prompt for prompt in route_prompts)
        assert any("source-page: 3" in prompt for prompt in route_prompts)

    assert snapshot.authority == "preliminary-low-authority"
    assert snapshot.route_statistics.summary_units == 3
    assert snapshot.review_history[-1].accepted_as_initial_impression is True
    assert snapshot.frozen_with_unresolved_issues is False
    stages = [stage for stage, _ in progress.events]
    assert {"规划", "总结", "结构", "概念", "校验", "冻结"} <= set(stages)
    assert any("1/3" in message for stage, message in progress.events if stage == "总结")


@pytest.mark.asyncio
async def test_review_can_trigger_targeted_reread_before_freeze() -> None:
    model = RevisingFakeModel()
    progress = RecordingProgressReporter()
    snapshot = await GlobalExplorationRunner(
        model=model,
        progress=progress,
        settings=ExplorationSettings(
            summary_unit_chars=100,
            structure_unit_chars=100,
            concept_unit_chars=100,
            structure_overlap_pages=0,
            concept_overlap_pages=0,
            max_review_rounds=2,
        ),
    ).run(make_document())

    assert model.review_calls == 2
    assert "历史实践，不是制度" in snapshot.global_summary_markdown
    assert snapshot.route_statistics.review_rounds == 2
    assert snapshot.frozen_with_unresolved_issues is False
    assert any(stage == "回看" for stage, _ in progress.events)
    assert any(stage == "回看·总结" for stage, _ in progress.events)
