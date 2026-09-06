"""Recover deterministic document evidence links before semantic compilation."""

from __future__ import annotations

import re
from collections import defaultdict

from cold_start.document.models import AttachedEvidence, ParsedBlock

_LATEX_SUPERSCRIPT = re.compile(r"\$\^\{(?P<marker>[^{}\s]+)\}\$")
_MARKDOWN_FOOTNOTE = re.compile(r"\[\^(?P<marker>[^\]\s]+)\]")
_LEADING_LATEX_SUPERSCRIPT = re.compile(
    r"^\s*\$\^\{(?P<marker>[^{}\s]+)\}\$"
)
_LEADING_MARKDOWN_FOOTNOTE = re.compile(
    r"^\s*\[\^(?P<marker>[^\]\s]+)\](?::)?"
)


def attach_document_evidence(
    blocks: tuple[ParsedBlock, ...],
) -> tuple[ParsedBlock, ...]:
    """Attach a same-page footnote to the nearest preceding explicit marker.

    MinerU already distinguishes page footnotes and preserves their page/bbox. This
    function recovers the reference edge without changing physical block order or
    Region ownership. Existing links are rebuilt so parser-policy changes are
    reflected when old parse checkpoints are loaded.
    """

    by_page: dict[int, list[ParsedBlock]] = defaultdict(list)
    for block in blocks:
        for page in block.source_pages:
            by_page[page].append(block)

    links_by_host: dict[str, list[AttachedEvidence]] = defaultdict(list)
    for page_blocks in by_page.values():
        ordered = sorted(page_blocks, key=lambda item: item.order)
        for footnote in ordered:
            if footnote.source_type != "page_footnote":
                continue
            marker = _leading_footnote_marker(footnote.markdown)
            if marker is None:
                continue
            host = next(
                (
                    candidate
                    for candidate in reversed(ordered)
                    if candidate.order < footnote.order
                    and candidate.source_type != "page_footnote"
                    and marker in _inline_footnote_markers(candidate.markdown)
                ),
                None,
            )
            if host is None:
                continue
            links_by_host[host.block_id].append(
                AttachedEvidence(
                    kind="footnote",
                    marker=marker,
                    block_id=footnote.block_id,
                )
            )

    return tuple(
        block.model_copy(
            update={"attached_evidence": tuple(links_by_host.get(block.block_id, ()))}
        )
        for block in blocks
    )


def attached_evidence_block_ids(blocks: tuple[ParsedBlock, ...]) -> frozenset[str]:
    return frozenset(
        evidence.block_id
        for block in blocks
        for evidence in block.attached_evidence
    )


def _leading_footnote_marker(markdown: str) -> str | None:
    for pattern in (_LEADING_LATEX_SUPERSCRIPT, _LEADING_MARKDOWN_FOOTNOTE):
        match = pattern.search(markdown)
        if match is not None:
            return _normalize_marker(match.group("marker"))
    return None


def _inline_footnote_markers(markdown: str) -> set[str]:
    return {
        _normalize_marker(match.group("marker"))
        for pattern in (_LATEX_SUPERSCRIPT, _MARKDOWN_FOOTNOTE)
        for match in pattern.finditer(markdown)
    }


def _normalize_marker(value: str) -> str:
    return value.strip().casefold()


__all__ = ["attach_document_evidence", "attached_evidence_block_ids"]
