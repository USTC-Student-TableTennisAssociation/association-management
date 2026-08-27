import { isDeepStrictEqual } from "node:util";

import type {
  ViewCardState,
  ViewChange,
  ViewChangeValue,
} from "@/contracts";

function valueAt(
  values: Readonly<Record<string, unknown>>,
  key: string,
): ViewChangeValue {
  return Object.hasOwn(values, key)
    ? { present: true, value: values[key] }
    : { present: false };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Produces a complete, storage-independent description of one committed View
 * state transition. Commands do not have to maintain before/after data by hand.
 */
export function diffViewCards(
  before: readonly ViewCardState[],
  after: readonly ViewCardState[],
): ViewChange[] {
  const beforeById = new Map(before.map((card) => [card.id, card]));
  const afterById = new Map(after.map((card) => [card.id, card]));
  const changes: ViewChange[] = [];

  for (const card of before) {
    if (!afterById.has(card.id)) changes.push({ kind: "card_deleted", card });
  }
  for (const card of after) {
    if (!beforeById.has(card.id)) changes.push({ kind: "card_created", card });
  }

  for (const previous of before) {
    const current = afterById.get(previous.id);
    if (!current) continue;

    const dimensionKeys = [...new Set([
      ...Object.keys(previous.dimensions),
      ...Object.keys(current.dimensions),
    ])].sort();
    for (const dimensionKey of dimensionKeys) {
      const previousValue = valueAt(previous.dimensions, dimensionKey);
      const currentValue = valueAt(current.dimensions, dimensionKey);
      if (isDeepStrictEqual(previousValue, currentValue)) continue;
      changes.push({
        kind: "dimension",
        cardId: current.id,
        cardTypeKey: current.cardTypeKey,
        dimensionKey,
        before: previousValue,
        after: currentValue,
      });
    }

    const slotKeys = [...new Set([
      ...Object.keys(previous.slots),
      ...Object.keys(current.slots),
    ])].sort();
    for (const slotKey of slotKeys) {
      const previousTargets = previous.slots[slotKey] ?? [];
      const currentTargets = current.slots[slotKey] ?? [];
      if (sameIds(previousTargets, currentTargets)) continue;
      changes.push({
        kind: "slot",
        cardId: current.id,
        cardTypeKey: current.cardTypeKey,
        slotKey,
        before: [...previousTargets],
        after: [...currentTargets],
      });
    }

    if (!sameIds(previous.relatedObjectIds, current.relatedObjectIds)) {
      changes.push({
        kind: "related_objects",
        cardId: current.id,
        cardTypeKey: current.cardTypeKey,
        before: [...previous.relatedObjectIds],
        after: [...current.relatedObjectIds],
      });
    }
  }

  return changes;
}
