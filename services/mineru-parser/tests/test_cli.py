from argparse import Namespace
from pathlib import Path

from sydaris_mineru.cli import _mineru_command


def test_builds_explicit_mineru_command() -> None:
    args = Namespace(
        backend="hybrid-engine",
        effort="medium",
        method="auto",
        image_analysis=False,
    )

    command = _mineru_command("mineru", Path("input.pdf"), Path("raw"), args)

    assert command == [
        "mineru",
        "-p",
        "input.pdf",
        "-o",
        "raw",
        "-b",
        "hybrid-engine",
        "--effort",
        "medium",
        "-m",
        "auto",
        "--image-analysis",
        "false",
    ]
