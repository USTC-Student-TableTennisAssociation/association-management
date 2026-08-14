import type {
  SemanticViewReadSnapshot,
  SemanticViewReference,
  SemanticViewReferenceBundle,
  SemanticViewReferenceTarget,
  SemanticViewState,
} from "@/semantic-view/types";

function targetKey(target: SemanticViewReferenceTarget): string {
  return JSON.stringify(target);
}

/** Small request-local registry used only by readSemanticView and the final Chat answer. */
export function createSemanticViewReferenceRegistry() {
  const references: SemanticViewReference[] = [];
  const refByTarget = new Map<string, string>();

  function register(label: string, target: SemanticViewReferenceTarget): string {
    const key = targetKey(target);
    const existing = refByTarget.get(key);
    if (existing) return existing;
    const ref = `V${references.length + 1}`;
    refByTarget.set(key, ref);
    references.push({ ref, label, target });
    return ref;
  }

  function buildSnapshot(view: SemanticViewState): SemanticViewReadSnapshot {
    const viewRef = register(view.viewLabel, {
      kind: "view",
      viewKey: view.viewKey,
    });
    return {
      isFullSnapshot: true,
      ref: viewRef,
      viewKey: view.viewKey,
      viewLabel: view.viewLabel,
      viewDescription: view.viewDescription,
      compilationId: view.compilationId,
      compatible: view.compatible,
      ...(view.incompatibilityReason
        ? { incompatibilityReason: view.incompatibilityReason }
        : {}),
      cardTypes: view.cardTypes,
      cards: view.cards.map((card) => {
        const cardLabel = `${view.viewLabel} · ${card.objectName}`;
        const dimensionsByName = new Map(
          card.contentDimensions.map((dimension) => [dimension.name, dimension]),
        );
        const dimensionNames = [
          ...card.seedContentDimensions,
          ...card.contentDimensions
            .map((dimension) => dimension.name)
            .filter((name) => !card.seedContentDimensions.includes(name)),
        ];
        return {
          ref: register(cardLabel, {
            kind: "card",
            viewKey: view.viewKey,
            cardId: card.id,
          }),
          id: card.id,
          cardTypeKey: card.cardTypeKey,
          cardTypeLabel: card.cardTypeLabel,
          objectId: card.objectId,
          objectName: card.objectName,
          contentDimensions: dimensionNames.map((name) => {
            const dimension = dimensionsByName.get(name);
            return {
              ref: register(`${cardLabel} · ${name}`, {
                kind: "dimension",
                viewKey: view.viewKey,
                cardId: card.id,
                dimensionName: name,
              }),
              ...(dimension ? { id: dimension.id } : {}),
              name,
              contentMarkdown: dimension?.contentMarkdown ?? null,
              isMissing: !dimension,
            };
          }),
          slots: card.slots.map((slot) => ({
            ref: register(`${cardLabel} · ${slot.label}`, {
              kind: "slot",
              viewKey: view.viewKey,
              cardId: card.id,
              slotKey: slot.key,
            }),
            key: slot.key,
            label: slot.label,
            meaning: slot.meaning,
            cardinality: slot.cardinality,
            targets: slot.targets.map((target) => ({
              cardId: target.cardId,
              viewKey: target.viewKey,
              cardTypeKey: target.cardTypeKey,
              ...(target.objectId ? { objectId: target.objectId } : {}),
              objectName: target.objectName,
            })),
          })),
        };
      }),
    };
  }

  function citedReferences(text: string): SemanticViewReferenceBundle {
    const available = new Map(references.map((reference) => [reference.ref, reference]));
    const used = [...text.matchAll(/\[(V\d+)\]/g)]
      .map((match) => match[1])
      .filter((ref, index, values) => available.has(ref) && values.indexOf(ref) === index);
    return {
      references: used.map((ref) => available.get(ref)!),
    };
  }

  return { buildSnapshot, citedReferences };
}
