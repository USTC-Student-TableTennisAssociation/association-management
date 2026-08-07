import os
from pathlib import Path

import pytest

from cold_start.config import (
    ActivityViewSettings,
    CompilationSettings,
    ExplorationSettings,
    ModelSettings,
)
from cold_start.environment import find_environment_file, load_environment_file


def test_finds_parent_env_and_preserves_system_environment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = tmp_path / "repository"
    working_directory = repository / "services" / "cold-start"
    working_directory.mkdir(parents=True)
    environment_file = repository / ".env"
    environment_file.write_text(
        (
            "AI_MODEL=file-model\n"
            "AI_API_BASE_URL=http://model.test/v1\n"
            "AI_READ_TIMEOUT_SECONDS=720\n"
            "AI_MAX_RETRIES=1\n"
            "AI_REQUESTS_PER_MINUTE=17\n"
            "AI_STREAM_PROGRESS_INTERVAL_SECONDS=7\n"
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("AI_MODEL", "system-model")
    for variable in (
        "AI_API_BASE_URL",
        "AI_READ_TIMEOUT_SECONDS",
        "AI_MAX_RETRIES",
        "AI_REQUESTS_PER_MINUTE",
        "AI_STREAM_PROGRESS_INTERVAL_SECONDS",
    ):
        monkeypatch.delenv(variable, raising=False)

    loaded = load_environment_file(search_starts=(working_directory,))
    model_settings = ModelSettings.from_environment()

    assert loaded == environment_file
    assert find_environment_file((working_directory,)) == environment_file
    assert os.environ["AI_MODEL"] == "system-model"
    assert os.environ["AI_API_BASE_URL"] == "http://model.test/v1"
    assert model_settings.read_timeout_seconds == 720
    assert model_settings.max_retries == 1
    assert model_settings.requests_per_minute == 17
    assert model_settings.stream_progress_interval_seconds == 7


def test_explicit_missing_env_file_fails(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="指定的环境文件不存在"):
        load_environment_file(tmp_path / "missing.env")


def test_reads_region_parallelism_from_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("COLD_START_MAX_PARALLEL_REGIONS", "6")

    settings = ExplorationSettings.from_environment()

    assert settings.max_parallel_regions == 6


def test_reads_compilation_parallelism_from_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("COLD_START_MAX_PARALLEL_COMPILATIONS", "8")
    monkeypatch.setenv("COLD_START_MAX_PARALLEL_PARENT_INTEGRATIONS", "4")

    settings = CompilationSettings.from_environment()

    assert settings.max_parallel_sources == 8
    assert settings.max_parallel_parents == 4


def test_reads_activity_view_settings_from_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("COLD_START_MAX_PARALLEL_PERSPECTIVE_GROUPS", "7")
    monkeypatch.setenv("COLD_START_PERSPECTIVE_OBJECTS_PER_GROUP", "32")
    monkeypatch.setenv("COLD_START_PERSPECTIVE_OBJECT_GROUP_CHARS", "36000")
    monkeypatch.setenv("COLD_START_PERSPECTIVE_ASSERTIONS_PER_GROUP", "44")
    monkeypatch.setenv(
        "COLD_START_PERSPECTIVE_MAX_REVIEW_ROUNDS",
        "7",
    )

    settings = ActivityViewSettings.from_environment()

    assert settings.max_parallel_groups == 7
    assert settings.max_objects_per_group == 32
    assert settings.max_object_group_chars == 36000
    assert settings.max_assertions_per_group == 44
    assert settings.max_review_rounds == 7


def test_activity_view_defaults_to_five_review_rounds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("COLD_START_PERSPECTIVE_MAX_REVIEW_ROUNDS", raising=False)

    assert ActivityViewSettings.from_environment().max_review_rounds == 5
