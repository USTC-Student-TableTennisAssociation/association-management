import os
from pathlib import Path

import pytest

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
        "AI_MODEL=file-model\nAI_API_BASE_URL=http://model.test/v1\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("AI_MODEL", "system-model")
    monkeypatch.delenv("AI_API_BASE_URL", raising=False)

    loaded = load_environment_file(search_starts=(working_directory,))

    assert loaded == environment_file
    assert find_environment_file((working_directory,)) == environment_file
    assert os.environ["AI_MODEL"] == "system-model"
    assert os.environ["AI_API_BASE_URL"] == "http://model.test/v1"


def test_explicit_missing_env_file_fails(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="指定的环境文件不存在"):
        load_environment_file(tmp_path / "missing.env")
