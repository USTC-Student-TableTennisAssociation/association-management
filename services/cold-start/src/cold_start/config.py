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
    requests_per_minute: int = 18

    @classmethod
    def from_environment(
        cls,
        *,
        model: str | None = None,
        api_base_url: str | None = None,
        api_key: str | None = None,
        read_timeout_seconds: float | None = None,
        max_retries: int | None = None,
        requests_per_minute: int | None = None,
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
            requests_per_minute=_environment_int(
                "AI_REQUESTS_PER_MINUTE",
                explicit=requests_per_minute,
                default=18,
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
            "requests_per_minute": self.requests_per_minute,
        }
        for name, value in positive_values.items():
            if value <= 0:
                raise ValueError(f"{name} 必须大于 0")


@dataclass(frozen=True)
class ExplorationSettings:
    """文档上下文线路和递归区域树的运行边界。"""

    context_unit_chars: int = 12_000
    max_tree_depth: int = 6
    max_parallel_regions: int = 3
    max_tool_calls_per_region: int = 2
    boundary_context_blocks: int = 2
    retrieval_unit_chars: int = 1_200
    retrieval_top_k: int = 5
    embedding_model: str = "BAAI/bge-m3"

    @classmethod
    def from_environment(
        cls,
        *,
        embedding_model: str | None = None,
    ) -> ExplorationSettings:
        return cls(
            max_parallel_regions=_environment_int(
                "COLD_START_MAX_PARALLEL_REGIONS",
                explicit=None,
                default=3,
            ),
            embedding_model=embedding_model
            or os.getenv("COLD_START_EMBEDDING_MODEL")
            or "BAAI/bge-m3",
        )

    def __post_init__(self) -> None:
        positive_values = {
            "context_unit_chars": self.context_unit_chars,
            "max_tree_depth": self.max_tree_depth,
            "max_parallel_regions": self.max_parallel_regions,
            "max_tool_calls_per_region": self.max_tool_calls_per_region,
            "boundary_context_blocks": self.boundary_context_blocks,
            "retrieval_unit_chars": self.retrieval_unit_chars,
            "retrieval_top_k": self.retrieval_top_k,
        }
        for name, value in positive_values.items():
            if value < 1:
                raise ValueError(f"{name} 必须大于 0")
        if not self.embedding_model.strip():
            raise ValueError("embedding_model 不能为空")


@dataclass(frozen=True)
class CompilationSettings:
    """整棵区域树基础编译的并发边界。"""

    max_parallel_sources: int = 6
    max_parallel_parents: int = 3

    @classmethod
    def from_environment(
        cls,
        *,
        max_parallel_sources: int | None = None,
        max_parallel_parents: int | None = None,
    ) -> CompilationSettings:
        return cls(
            max_parallel_sources=_environment_int(
                "COLD_START_MAX_PARALLEL_COMPILATIONS",
                explicit=max_parallel_sources,
                default=6,
            ),
            max_parallel_parents=_environment_int(
                "COLD_START_MAX_PARALLEL_PARENT_INTEGRATIONS",
                explicit=max_parallel_parents,
                default=3,
            ),
        )

    def __post_init__(self) -> None:
        if self.max_parallel_sources < 1:
            raise ValueError("max_parallel_sources 必须大于 0")
        if self.max_parallel_parents < 1:
            raise ValueError("max_parallel_parents 必须大于 0")


@dataclass(frozen=True)
class ActivityViewSettings:
    """活动运营视角的父级语义分组与并发边界。"""

    max_parallel_groups: int = 6
    max_objects_per_group: int = 40
    max_object_group_chars: int = 50_000
    max_assertions_per_group: int = 12
    max_review_rounds: int = 5

    @classmethod
    def from_environment(
        cls,
        *,
        max_parallel_groups: int | None = None,
    ) -> ActivityViewSettings:
        return cls(
            max_parallel_groups=_environment_int(
                "COLD_START_MAX_PARALLEL_PERSPECTIVE_GROUPS",
                explicit=max_parallel_groups,
                default=6,
            ),
            max_objects_per_group=_environment_int(
                "COLD_START_PERSPECTIVE_OBJECTS_PER_GROUP",
                explicit=None,
                default=40,
            ),
            max_object_group_chars=_environment_int(
                "COLD_START_PERSPECTIVE_OBJECT_GROUP_CHARS",
                explicit=None,
                default=50_000,
            ),
            max_assertions_per_group=_environment_int(
                "COLD_START_PERSPECTIVE_ASSERTIONS_PER_GROUP",
                explicit=None,
                default=12,
            ),
            max_review_rounds=_environment_int(
                "COLD_START_PERSPECTIVE_MAX_REVIEW_ROUNDS",
                explicit=None,
                default=5,
            ),
        )

    def __post_init__(self) -> None:
        positive = {
            "max_parallel_groups": self.max_parallel_groups,
            "max_objects_per_group": self.max_objects_per_group,
            "max_object_group_chars": self.max_object_group_chars,
            "max_assertions_per_group": self.max_assertions_per_group,
            "max_review_rounds": self.max_review_rounds,
        }
        if any(value < 1 for value in positive.values()):
            raise ValueError("活动运营视角的并发和分组设置必须大于 0")


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
