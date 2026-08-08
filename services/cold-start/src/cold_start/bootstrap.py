"""命令行启动前处理依赖导入之前必须生效的运行环境。"""

from __future__ import annotations

import os
import subprocess
import sys


def main() -> None:
    if sys.platform == "win32" and not _utf8_mode_enabled():
        environment = os.environ.copy()
        environment["PYTHONUTF8"] = "1"
        environment["PYTHONIOENCODING"] = "utf-8"
        result = subprocess.run(
            [sys.executable, "-X", "utf8", "-m", "cold_start.cli", *sys.argv[1:]],
            env=environment,
            check=False,
        )
        raise SystemExit(result.returncode)

    from cold_start.cli import main as cli_main

    cli_main()


def _utf8_mode_enabled() -> bool:
    return bool(sys.flags.utf8_mode)
