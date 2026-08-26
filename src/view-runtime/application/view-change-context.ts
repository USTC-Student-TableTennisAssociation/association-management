import type { ViewCardState, ViewModule, ViewReadSnapshot } from "@/contracts";

export type ViewChangeExecution = {
  id: string;
  commandKey: string;
  input: unknown;
  result: unknown;
  stateVersionBefore: string;
  stateVersionAfter: string;
};

export type ViewChangeEvent = {
  type: string;
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
        value,
      };
    }),
    slots: Object.fromEntries(Object.entries(card.slots).map(([key, ids]) => [
      cardType?.slots.find((slot) => slot.key === key)?.label ?? key,
      ids.flatMap((id) => cardRefs.get(id) ?? []),
    ])),
    relatedObjects: card.relatedObjectIds.flatMap((id) => objectRefs.get(id) ?? []),
  };
}

export function buildViewChangeContext(input: ViewChangeContextInput) {
  const cardRefs = new Map(input.snapshot.cards.map((card, index) => [card.id, `V${index + 1}`]));
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
    relatedObjects: input.objects.map((object) => ({
      ref: objectRefs.get(object.id),
      canonicalName: object.canonicalName,
      cognitiveHigherMemory: object.cognitiveMemory ?? null,
    })),
    humanChanges: input.executions.map((execution) => ({
      command: commandsByKey.get(execution.commandKey)?.label ?? execution.commandKey,
      fromStateVersion: execution.stateVersionBefore,
      toStateVersion: execution.stateVersionAfter,
      input: logicalValue(execution.input, cardRefs, objectRefs),
      result: logicalValue(execution.result, cardRefs, objectRefs),
      events: input.events.filter((event) =>
        event.stateVersion === execution.stateVersionAfter
      ).map((event) => ({
        type: event.type,
        payload: logicalValue(event.payload, cardRefs, objectRefs),
      })),
    })),
    recentConversation: input.recentConversation ?? [],
  };
}
