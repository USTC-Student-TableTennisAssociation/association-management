"""记忆中间包的确定性改写操作。"""

from __future__ import annotations

from collections.abc import Iterable, Mapping

from cold_start.compilation.models import MemoryObject, MemoryPackage


class ObjectMergeConflict(ValueError):
    """多个对象合并后产生无法静默处理的语义冲突。"""


def merge_objects(
    package: MemoryPackage,
    *,
    source_object_ids: Iterable[str],
    replacement: MemoryObject,
) -> MemoryPackage:
    """合并同一对象的局部指称，并重映射包内所有引用。"""

    source_ids = list(dict.fromkeys(source_object_ids))
    if len(source_ids) < 2:
        raise ValueError("对象合并至少需要两个不同的源对象")

    existing_ids = {item.object_id for item in package.objects}
    missing = set(source_ids) - existing_ids
    if missing:
        raise ValueError(f"待合并对象不存在：{', '.join(sorted(missing))}")
    unaffected_ids = existing_ids - set(source_ids)
    if replacement.object_id in unaffected_ids:
        raise ValueError(f"替换对象 ID 已被占用：{replacement.object_id}")

    mapping = {source_id: replacement.object_id for source_id in source_ids}
    objects: list[MemoryObject] = []
    inserted = False
    for item in package.objects:
        if item.object_id in mapping:
            if not inserted:
                objects.append(replacement)
                inserted = True
            continue
        objects.append(item)

    assertions = [
        item.model_copy(
            update={
                "about_object_ids": _remap_many(item.about_object_ids, mapping),
                "holder_object_id": _remap_optional(
                    item.holder_object_id,
                    mapping,
                ),
            }
        )
        for item in package.assertions
    ]

    relations = []
    for item in package.relations:
        changed = item.model_copy(
            update={
                "from_object_id": mapping.get(
                    item.from_object_id,
                    item.from_object_id,
                ),
                "to_object_id": mapping.get(item.to_object_id, item.to_object_id),
                "context_object_id": _remap_optional(
                    item.context_object_id,
                    mapping,
                ),
                "holder_object_id": _remap_optional(
                    item.holder_object_id,
                    mapping,
                ),
            }
        )
        if changed.from_object_id == changed.to_object_id:
            raise ObjectMergeConflict(
                f"合并后关系 {changed.relation_id} 形成自环，需要显式裁决"
            )
        relations.append(changed)

    unresolved = [
        item.model_copy(
            update={"object_ids": _remap_many(item.object_ids, mapping)}
        )
        for item in package.unresolved
    ]

    return MemoryPackage.model_validate(
        package.model_copy(
            update={
                "objects": objects,
                "assertions": assertions,
                "relations": relations,
                "unresolved": unresolved,
            }
        ).model_dump()
    )


def _remap_many(values: list[str], mapping: Mapping[str, str]) -> list[str]:
    return list(dict.fromkeys(mapping.get(value, value) for value in values))


def _remap_optional(value: str | None, mapping: Mapping[str, str]) -> str | None:
    return mapping.get(value, value) if value is not None else None
