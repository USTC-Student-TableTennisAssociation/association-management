"""冷启动任务的可替换进度输出。"""

from __future__ import annotations

import sys
import threading
import time
from typing import Protocol, TextIO


class ProgressReporter(Protocol):
    """工作流只发布语义进度，不依赖终端或未来的任务系统。"""

    def report(self, stage: str, message: str) -> None: ...


class NullProgressReporter:
    """库调用默认保持安静。"""

    def report(self, stage: str, message: str) -> None:
        del stage, message


class ConsoleProgressReporter:
    """以任务启动后的相对时间输出并发路径进度。"""

    def __init__(self, *, stream: TextIO | None = None) -> None:
        self._stream = stream or sys.stdout
        self._started_at = time.perf_counter()
        self._lock = threading.Lock()

    def report(self, stage: str, message: str) -> None:
        elapsed = time.perf_counter() - self._started_at
        with self._lock:
            print(
                f"[+{elapsed:7.1f}s] [{stage}] {message}",
                file=self._stream,
                flush=True,
            )
