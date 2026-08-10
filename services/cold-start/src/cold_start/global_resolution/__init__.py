"""本地 SourceRegion 级 Global Object Registry 解析。"""

from cold_start.global_resolution.artifacts import (
    create_global_resolution_paths,
    initial_registry,
    load_source_compilation,
    load_working_registry,
    open_global_resolution_paths,
    write_working_registry,
)
from cold_start.global_resolution.finalization import (
    build_global_assertions_artifact,
    finalize_existing_global_resolution,
    write_global_assertions_artifact,
)
from cold_start.global_resolution.retrieval import GlobalObjectCandidateRetriever
from cold_start.global_resolution.runtime import GlobalObjectResolverRunner

__all__ = [
    "GlobalObjectCandidateRetriever",
    "GlobalObjectResolverRunner",
    "build_global_assertions_artifact",
    "create_global_resolution_paths",
    "finalize_existing_global_resolution",
    "initial_registry",
    "load_source_compilation",
    "load_working_registry",
    "open_global_resolution_paths",
    "write_global_assertions_artifact",
    "write_working_registry",
]
