"""冷启动任务配置。"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class ModelSettings:
    """OpenAI 兼容聊天接口配置。"""

    model: str
    api_base_url: str
    api_key: str | None
    connect_timeout_seconds: float = 30.0
    read_timeout_seconds: float = 600.0
    write_timeout_seconds: float = 60.0
    pool_timeout_seconds: float = 60.0
    stream_progress_interval_seconds: float = 5.0
    max_retries: int = 2

    @classmethod
    def from_environment(
        cls,
        *,
        model: str | None = None,
        api_base_url: str | None = None,
        api_key: str | None = None,
        read_timeout_seconds: float | None = None,
        max_retries: int | None = None,
    ) -> ModelSettings:
        resolved_model = model or os.getenv("AI_MODEL")
        resolved_base_url = api_base_url or os.getenv("AI_API_BASE_URL")
        resolved_api_key = api_key or os.getenv("AI_API_KEY")
        if not resolved_model:
            raise ValueError("缺少模型名称，请设置 AI_MODEL 或传入 --model")
        if not resolved_base_url:
            raise ValueError("缺少模型接口地址，请设置 AI_API_BASE_URL 或传入 --api-base-url")
        return cls(
            model=resolved_model,
            api_base_url=resolved_base_url,
            api_key=resolved_api_key,
            read_timeout_seconds=_environment_float(
                "AI_READ_TIMEOUT_SECONDS",
                explicit=read_timeout_seconds,
                default=600.0,
            ),
            stream_progress_interval_seconds=_environment_float(
                "AI_STREAM_PROGRESS_INTERVAL_SECONDS",
                explicit=None,
                default=5.0,
            ),
            max_retries=_environment_int(
                "AI_MAX_RETRIES",
                explicit=max_retries,
                default=2,
            ),
        )

    def __post_init__(self) -> None:
        positive_values = {
            "connect_timeout_seconds": self.connect_timeout_seconds,
            "read_timeout_seconds": self.read_timeout_seconds,
            "write_timeout_seconds": self.write_timeout_seconds,
            "pool_timeout_seconds": self.pool_timeout_seconds,
            "stream_progress_interval_seconds": self.stream_progress_interval_seconds,
            "max_retries": self.max_retries,
        }
        for name, value in positive_values.items():
            if value <= 0:
                raise ValueError(f"{name} 必须大于 0")


@dataclass(frozen=True)
class ExplorationSettings:
    """全局勘探三条阅读路径及校验回路的边界。"""

    summary_unit_chars: int = 18_000
    structure_unit_chars: int = 12_000
    concept_unit_chars: int = 10_000
    structure_overlap_pages: int = 1
    concept_overlap_pages: int = 1
    revision_source_chars: int = 24_000
    max_review_rounds: int = 2

    def __post_init__(self) -> None:
        positive_values = {
            "summary_unit_chars": self.summary_unit_chars,
            "structure_unit_chars": self.structure_unit_chars,
            "concept_unit_chars": self.concept_unit_chars,
            "revision_source_chars": self.revision_source_chars,
            "max_review_rounds": self.max_review_rounds,
        }
        for name, value in positive_values.items():
            if value < 1:
                raise ValueError(f"{name} 必须大于 0")
        if self.structure_overlap_pages < 0 or self.concept_overlap_pages < 0:
            raise ValueError("重叠页数不能为负数")


def _environment_float(
    name: str,
    *,
    explicit: float | None,
    default: float,
) -> float:
    raw = explicit if explicit is not None else os.getenv(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{name} 必须是数字") from error


def _environment_int(
    name: str,
    *,
    explicit: int | None,
    default: int,
) -> int:
    raw = explicit if explicit is not None else os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{name} 必须是整数") from error
