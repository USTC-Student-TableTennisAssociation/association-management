"""用词面与可选 BGE 召回当前 Global Object；分数不进入决策协议。"""

from __future__ import annotations

import math
import unicodedata
from collections.abc import Iterable, Sequence
from typing import Literal

from cold_start.global_resolution.models import (
    ActiveGlobalObject,
    RegistryState,
    SourceFragmentDossier,
)
from cold_start.region_tree.runtime import TextEmbedder

LexicalMatchKind = Literal["normalized_exact", "compact_exact", "contains"]

_QUOTE_PAIRS = {'"': '"', "'": "'", "“": "”", "‘": "’", "《": "》", "〈": "〉"}
_MATCH_PRIORITY: dict[LexicalMatchKind, int] = {
    "normalized_exact": 0,
    "compact_exact": 1,
    "contains": 2,
}


class GlobalObjectCandidateRetriever:
    """合并保守词面候选和可选 BGE top-k；只返回 Registry 中的对象。"""

    def __init__(
        self,
        *,
        embedder: TextEmbedder | None = None,
        candidate_limit: int = 8,
    ) -> None:
        if candidate_limit < 1:
            raise ValueError("candidate_limit 必须大于 0")
        self.embedder = embedder
        self.candidate_limit = candidate_limit
        self._vector_cache: dict[str, list[float]] = {}

    async def retrieve(
        self,
        incoming: SourceFragmentDossier,
        registry: RegistryState,
        *,
        region_label: str = "",
        context_markdown: str = "",
    ) -> list[ActiveGlobalObject]:
        lexical = {
            item.global_object_id: lexical_match_kinds(incoming, item) for item in registry.objects
        }
        lexical = {key: value for key, value in lexical.items() if value}
        embedding_rank: dict[str, int] = {}
        if self.embedder is not None and registry.objects:
            incoming_text = source_fragment_retrieval_text(
                incoming,
                region_label=region_label,
                context_markdown=context_markdown,
            )
            object_texts = [global_object_retrieval_text(item) for item in registry.objects]
            vectors = await self._vectors([incoming_text, *object_texts])
            scores = [_cosine(vectors[0], vector) for vector in vectors[1:]]
            order = sorted(
                range(len(registry.objects)),
                key=lambda index: (
                    -scores[index],
                    registry.objects[index].global_object_key,
                    registry.objects[index].global_object_id,
                ),
            )
            embedding_rank = {
                registry.objects[index].global_object_id: rank
                for rank, index in enumerate(order[: self.candidate_limit], 1)
            }

        by_id = registry.object_by_id()
        ordered_ids = sorted(
            lexical.keys() | embedding_rank.keys(),
            key=lambda object_id: (
                min(
                    (_MATCH_PRIORITY[item] for item in lexical.get(object_id, ())),
                    default=99,
                ),
                embedding_rank.get(object_id, 1_000_000),
                by_id[object_id].global_object_key,
                object_id,
            ),
        )
        forced_ids = [
            object_id
            for object_id in ordered_ids
            if any(
                kind in {"normalized_exact", "compact_exact"} for kind in lexical.get(object_id, ())
            )
        ]
        forced = set(forced_ids)
        remaining = [object_id for object_id in ordered_ids if object_id not in forced]
        selected = [
            *forced_ids,
            *remaining[: max(0, self.candidate_limit - len(forced_ids))],
        ]
        return [by_id[object_id] for object_id in selected]

    async def _vectors(self, texts: Sequence[str]) -> list[list[float]]:
        missing = list(dict.fromkeys(text for text in texts if text not in self._vector_cache))
        if missing:
            assert self.embedder is not None
            encoded = await self.embedder.encode(missing)
            if len(encoded) != len(missing):
                raise ValueError("TextEmbedder 返回的向量数量与输入不一致")
            self._vector_cache.update(zip(missing, encoded, strict=True))
        return [self._vector_cache[text] for text in texts]


def normalize_identity_text(value: str) -> str:
    result = unicodedata.normalize("NFKC", value).strip().casefold()
    while len(result) >= 2 and result[0] in _QUOTE_PAIRS and result[-1] == _QUOTE_PAIRS[result[0]]:
        result = result[1:-1].strip()
    return result


def compact_identity_text(value: str) -> str:
    normalized = normalize_identity_text(value)
    return "".join(
        character
        for character in normalized
        if not unicodedata.category(character).startswith(("P", "Z")) and not character.isspace()
    )


def identity_match_kind(left: str, right: str) -> LexicalMatchKind | None:
    normalized_left = normalize_identity_text(left)
    normalized_right = normalize_identity_text(right)
    if normalized_left and normalized_left == normalized_right:
        return "normalized_exact"
    compact_left = compact_identity_text(left)
    compact_right = compact_identity_text(right)
    if compact_left and compact_left == compact_right:
        return "compact_exact"
    if min(len(compact_left), len(compact_right)) >= 2 and (
        compact_left in compact_right or compact_right in compact_left
    ):
        return "contains"
    return None


def lexical_match_kinds(
    incoming: SourceFragmentDossier,
    candidate: ActiveGlobalObject,
) -> list[LexicalMatchKind]:
    matches = {
        kind
        for source in incoming.surface_atoms
        for target in candidate.surface_atoms
        if (kind := identity_match_kind(source.surface_form, target.surface_form)) is not None
    }
    return sorted(matches, key=_MATCH_PRIORITY.__getitem__)


def source_fragment_retrieval_text(
    value: SourceFragmentDossier,
    *,
    region_label: str = "",
    context_markdown: str = "",
) -> str:
    parts = [
        "名称：" + "｜".join(_unique(item.surface_form for item in value.surface_atoms)),
        f"来源区域：{value.source_node_id}｜{region_label}",
    ]
    if value.assertions:
        parts.append(
            "相关叙述：\n"
            + "\n".join(f"- {item.statement_template_markdown}" for item in value.assertions[:12])
        )
    if context_markdown.strip():
        parts.append("来源语境：\n" + _truncate(context_markdown.strip(), 4_000))
    return "\n".join(parts)


def global_object_retrieval_text(value: ActiveGlobalObject) -> str:
    parts = [f"规范名称：{value.canonical_name}"]
    forms = _unique(item.surface_form for item in value.surface_atoms)
    if forms:
        parts.append("来源名称：" + "｜".join(forms))
    if value.assertions:
        parts.append(
            "相关叙述：\n"
            + "\n".join(f"- {item.statement_template_markdown}" for item in value.assertions[:12])
        )
    return "\n".join(parts)


def _cosine(left: Sequence[float], right: Sequence[float]) -> float:
    if not left or len(left) != len(right):
        raise ValueError("TextEmbedder 返回空向量或维度不一致")
    left_norm = math.sqrt(sum(float(item) ** 2 for item in left))
    right_norm = math.sqrt(sum(float(item) ** 2 for item in right))
    if left_norm == 0 or right_norm == 0:
        raise ValueError("TextEmbedder 返回零向量")
    score = sum(
        float(left_item) * float(right_item)
        for left_item, right_item in zip(left, right, strict=True)
    ) / (left_norm * right_norm)
    return max(-1.0, min(1.0, score))


def _unique(values: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(values))


def _truncate(value: str, limit: int) -> str:
    return value if len(value) <= limit else value[: limit - 1].rstrip() + "…"


__all__ = [
    "GlobalObjectCandidateRetriever",
    "compact_identity_text",
    "global_object_retrieval_text",
    "identity_match_kind",
    "lexical_match_kinds",
    "normalize_identity_text",
    "source_fragment_retrieval_text",
]
