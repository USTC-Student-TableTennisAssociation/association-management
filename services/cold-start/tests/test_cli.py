from __future__ import annotations

import argparse
import json
from pathlib import Path

import pytest

import cold_start.cli as cli
from cold_start.document.models import ParsedDocument, ParsedPage


class FakePdfLoader:
    def load(self, source_path: Path) -> ParsedDocument:
        return ParsedDocument(
            source_path=source_path.resolve(),
            title="测试手册",
            file_sha256="d" * 64,
            parser_name="fake",
            pages=(ParsedPage(page_number=1, markdown="# 测试手册\n正文"),),
            markdown="# 测试手册\n正文",
        )


class FakeChatModel:
    def __init__(self, settings, *, progress) -> None:
        self.settings = settings
        self.progress = progress

    async def complete(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.0,
    ) -> str:
        del system_prompt, temperature
        if "[ROUTE: summary]" in user_prompt:
            return "# 总结\n测试"
        if "[ROUTE: structure]" in user_prompt:
            return "# 结构\n测试"
        if "[ROUTE: concept]" in user_prompt:
            return json.dumps(
                {
                    "document_level_observation": "测试",
                    "global_signals": [],
                    "candidate_concepts": [],
                    "coarse_relations": [],
                    "open_questions": [],
                }
            )
        if "[ROUTE: reconciliation]" in user_prompt:
            return json.dumps(
                {
                    "accepted_as_initial_impression": True,
                    "overall_assessment": "可以冻结",
                    "issues": [],
                    "unresolved_uncertainties": [],
                }
            )
        raise AssertionError("出现未预期的模型调用")

    async def aclose(self) -> None:
        return None


@pytest.mark.asyncio
async def test_cli_auto_loads_env_and_prints_detailed_progress(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    working_directory = tmp_path / "services" / "cold-start"
    working_directory.mkdir(parents=True)
    (tmp_path / ".env").write_text(
        (
            "AI_MODEL=fake-model\n"
            "AI_API_BASE_URL=http://model.test/v1\n"
            "AI_API_KEY=fake-key\n"
        ),
        encoding="utf-8",
    )
    for variable in ("AI_MODEL", "AI_API_BASE_URL", "AI_API_KEY"):
        monkeypatch.delenv(variable, raising=False)
    monkeypatch.chdir(working_directory)
    monkeypatch.setattr(cli, "DoclingPdfLoader", FakePdfLoader)
    monkeypatch.setattr(cli, "OpenAICompatibleChatModel", FakeChatModel)

    result = await cli._run_explore(
        argparse.Namespace(
            pdf=Path("handbook.pdf"),
            output=tmp_path / "runs",
            model=None,
            api_base_url=None,
            api_key=None,
            env_file=None,
            max_review_rounds=2,
        )
    )

    output = capsys.readouterr().out
    assert result == 0
    assert f"已加载 {tmp_path / '.env'}" in output
    assert "[规划] 阅读路径已生成" in output
    assert "[总结] 开始阅读单元 1/1" in output
    assert "[结构] 开始阅读单元 1/1" in output
    assert "[概念] 开始阅读单元 1/1" in output
    assert "[校验] 完成第 1/2 轮交叉校验" in output
    assert "[完成] 全局勘探产物" in output
    assert list((tmp_path / "runs").glob("*/global-exploration.json"))
