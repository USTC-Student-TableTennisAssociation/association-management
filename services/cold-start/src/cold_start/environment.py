"""从仓库 .env 或系统环境变量加载模型配置。"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

from dotenv import load_dotenv


def load_environment_file(
    explicit_path: Path | None = None,
    *,
    search_starts: Iterable[Path] | None = None,
) -> Path | None:
    """加载 .env，但不覆盖服务器或 shell 已经注入的环境变量。"""

    if explicit_path is not None:
        path = explicit_path.expanduser().resolve()
        if not path.is_file():
            raise FileNotFoundError(f"指定的环境文件不存在：{path}")
    else:
        starts = tuple(search_starts or (Path.cwd(), Path(__file__).resolve().parent))
        path = find_environment_file(starts)
        if path is None:
            return None

    load_dotenv(dotenv_path=path, override=False)
    return path


def find_environment_file(search_starts: Iterable[Path]) -> Path | None:
    """按给定起点顺序向上查找第一个 .env。"""

    visited: set[Path] = set()
    for start in search_starts:
        resolved = start.expanduser().resolve()
        directory = resolved if resolved.is_dir() else resolved.parent
        for candidate_directory in (directory, *directory.parents):
            if candidate_directory in visited:
                continue
            visited.add(candidate_directory)
            candidate = candidate_directory / ".env"
            if candidate.is_file():
                return candidate
    return None
