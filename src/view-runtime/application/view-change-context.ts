import type {
  ViewCardState,
  ViewChange,
  ViewModule,
  ViewReadSnapshot,
  ViewReactionAttentionPolicy,
} from "@/contracts";
import { policyForViewChange } from "@/view-runtime/application/view-change-policy";

export type ViewChangeExecution = {
  id: string;
  commandKey: string;
  input: unknown;
  result: unknown;
  stateVersionBefore: string;
  stateVersionAfter: string;
  changes: readonly ViewChange[];
};

export type ViewChangeEvent = {
  type: string;
  version: string;
  payload: unknown;
  stateVersion: string;
};

export type ViewRelatedObject = {
  id: string;
  canonicalName: string;
  cognitiveMemory?: unknown;
};

export type ViewChangeContextInput = {
  viewModule: ViewModule;
  snapshot: ViewReadSnapshot;
  executions: readonly ViewChangeExecution[];
  events: readonly ViewChangeEvent[];
  objects: readonly ViewRelatedObject[];
  attentionPolicy?: ViewReactionAttentionPolicy;
  reactionGuidance?: readonly string[];
  recentConversation?: readonly { role: string; text: string }[];
};

const databaseId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function logicalValue(
  value: unknown,
  cardRefs: ReadonlyMap<string, string>,
  objectRefs: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === "string") {
    return cardRefs.get(value) ?? objectRefs.get(value) ??
      (databaseId.test(value) ? "内部引用" : value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => logicalValue(item, cardRefs, objectRefs));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    logicalValue(item, cardRefs, objectRefs),
  ]));
}

function presentCard(
  card: ViewCardState,
  index: number,
  viewModule: ViewModule,
  cardRefs: ReadonlyMap<string, string>,
  objectRefs: ReadonlyMap<string, string>,
) {
  const cardType = viewModule.schema.cardTypes.find((candidate) =>
    candidate.key === card.cardTypeKey
  );
  return {
    ref: cardRefs.get(card.id) ?? `V${index + 1}`,
    type: cardType?.label ?? card.cardTypeKey,
    dimensions: Object.entries(card.dimensions).map(([key, value]) => {
      const definition = cardType?.dimensions.find((candidate) => candidate.key === key);
      return {
        key,
        label: definition?.label ?? key,
        description: definition?.description ?? null,
        value: logicalValue(value, cardRefs, objectRefs),
      };
    }),
    slots: Object.fromEntries(Object.entries(card.slots).map(([key, ids]) => [
      cardType?.slots.find((slot) => slot.key === key)?.label ?? key,
      ids.flatMap((id) => cardRefs.get(id) ?? []),
    ])),
    relatedObjects: card.relatedObjectIds.flatMap((id) => objectRefs.get(id) ?? []),
  };
}

function addChangeCardIds(change: ViewChange, ids: Set<string>): void {
  if (change.kind === "card_created" || change.kind === "card_deleted") {
    ids.add(change.card.id);
    Object.values(change.card.slots).flat().forEach((id) => ids.add(id));
    return;
  }
  ids.add(change.cardId);
  if (change.kind === "slot") {
    change.before.forEach((id) => ids.add(id));
    change.after.forEach((id) => ids.add(id));
  }
}

function presentChange(
  change: ViewChange,
  viewModule: ViewModule,
  cardRefs: ReadonlyMap<string, string>,
  objectRefs: ReadonlyMap<string, string>,
) {
  const cardTypeKey = change.kind === "card_created" || change.kind === "card_deleted"
    ? change.card.cardTypeKey
    : change.cardTypeKey;
  const cardType = viewModule.schema.cardTypes.find((candidate) =>
    candidate.key === cardTypeKey
  );
  const cardId = change.kind === "card_created" || change.kind === "card_deleted"
    ? change.card.id
    : change.cardId;
  const policy = policyForViewChange(viewModule, change);
  const base = {
    kind: change.kind,
    card: {
      ref: cardRefs.get(cardId) ?? "内部引用",
      type: cardTypeKey,
      label: cardType?.label ?? cardTypeKey,
      definition: cardType?.description ?? null,
    },
    policy: policy ?? null,
  };

  switch (change.kind) {
    case "card_created":
    case "card_deleted":
      return {
        ...base,
        state: presentCard(change.card, 0, viewModule, cardRefs, objectRefs),
      };
    case "dimension": {
      const definition = cardType?.dimensions.find((candidate) =>
        candidate.key === change.dimensionKey
      );
      return {
        ...base,
        field: {
          key: change.dimensionKey,
          label: definition?.label ?? change.dimensionKey,
          definition: definition?.description ?? null,
        },
        before: logicalValue(change.before, cardRefs, objectRefs),
        after: logicalValue(change.after, cardRefs, objectRefs),
      };
    }
    case "slot": {
      const definition = cardType?.slots.find((candidate) => candidate.key === change.slotKey);
      return {
        ...base,
        relationship: {
          key: change.slotKey,
          label: definition?.label ?? change.slotKey,
          definition: definition?.description ?? null,
        },
        before: change.before.map((id) => cardRefs.get(id) ?? "内部引用"),
        after: change.after.map((id) => cardRefs.get(id) ?? "内部引用"),
      };
    }
    case "related_objects":
      return {
        ...base,
        relationship: {
          key: "related_objects",
          label: "关联认知 Object",
          definition: cardType?.relatedObjects?.description ?? null,
        },
        before: change.before.map((id) => objectRefs.get(id) ?? "内部引用"),
        after: change.after.map((id) => objectRefs.get(id) ?? "内部引用"),
      };
  }
}

export function buildViewChangeContext(input: ViewChangeContextInput) {
  const cardIds = new Set(input.snapshot.cards.map((card) => card.id));
  input.executions.forEach((execution) =>
    execution.changes.forEach((change) => addChangeCardIds(change, cardIds))
  );
  const cardRefs = new Map([...cardIds].map((cardId, index) => [cardId, `V${index + 1}`]));
  const objectRefs = new Map(input.objects.map((object, index) => [object.id, `O${index + 1}`]));
  const commandsByKey = new Map(input.viewModule.commands.map((command) => [command.key, command]));
  return {
    view: {
      key: input.snapshot.viewKey,
      label: input.viewModule.manifest.label,
      description: input.viewModule.manifest.description,
      semanticInstructions: input.viewModule.manifest.aiSemanticInstructions ?? null,
      stateVersion: input.snapshot.stateVersion,
      cards: input.snapshot.cards.map((card, index) =>
        presentCard(card, index, input.viewModule, cardRefs, objectRefs)
      ),
    },
    aiReaction: {
      attention: input.attentionPolicy ?? "evaluate",
      guidance: input.reactionGuidance ?? [],
    },
    relatedObjects: input.objects.map((object) => ({
      ref: objectRefs.get(object.id),
      canonicalName: object.canonicalName,
      cognitiveHigherMemory: object.cognitiveMemory ?? null,
    })),
    commandExecutions: input.executions.map((execution) => ({
      command: commandsByKey.get(execution.commandKey)?.label ?? execution.commandKey,
      fromStateVersion: execution.stateVersionBefore,
      toStateVersion: execution.stateVersionAfter,
      input: logicalValue(execution.input, cardRefs, objectRefs),
      result: logicalValue(execution.result, cardRefs, objectRefs),
      changes: execution.changes.map((change) =>
        presentChange(change, input.viewModule, cardRefs, objectRefs)
      ),
      events: input.events.filter((event) =>
        event.stateVersion === execution.stateVersionAfter
      ).map((event) => ({
        type: event.type,
        version: event.version,
        payload: logicalValue(event.payload, cardRefs, objectRefs),
      })),
    })),
    recentConversation: input.recentConversation ?? [],
  };
}
