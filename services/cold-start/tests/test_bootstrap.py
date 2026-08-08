from subprocess import CompletedProcess

import pytest

from cold_start import bootstrap


def test_windows_bootstrap_restarts_python_in_utf8_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[list[str], dict[str, str]]] = []

    def run(command: list[str], *, env: dict[str, str], check: bool) -> CompletedProcess:
        assert check is False
        calls.append((command, env))
        return CompletedProcess(command, 7)

    monkeypatch.setattr(bootstrap.sys, "platform", "win32")
    monkeypatch.setattr(bootstrap, "_utf8_mode_enabled", lambda: False)
    monkeypatch.setattr(bootstrap.sys, "argv", ["cold-start", "explore", "--help"])
    monkeypatch.setattr(bootstrap.subprocess, "run", run)

    with pytest.raises(SystemExit) as exit_info:
        bootstrap.main()

    assert exit_info.value.code == 7
    command, environment = calls[0]
    assert command == [
        bootstrap.sys.executable,
        "-X",
        "utf8",
        "-m",
        "cold_start.cli",
        "explore",
        "--help",
    ]
    assert environment["PYTHONUTF8"] == "1"
    assert environment["PYTHONIOENCODING"] == "utf-8"
