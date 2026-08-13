import { Prisma, type PrismaClient } from "@/generated/prisma/client";

import { getDatabase } from "@/db";
import {
  businessViewDefinition,
  cardTypeDefinition,
} from "@/semantic-view/card-types";
import {
  SOCIETY_INFORMATION_VIEW,
  type AssertionSupportView,
  type BusinessViewKey,
  type SemanticViewState,
  type ViewChange,
  type ViewChangePayload,
  type ViewProposalPresentation,
  viewChangePayloadSchema,
} from "@/semantic-view/types";
import { renderResolvedAssertion } from "@/memory/resolved-assertion";

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

type VirtualCard = {
  selector: string;
  id?: string;
  viewKey: BusinessViewKey;
  objectId: string;
  objectName: string;
  cardTypeKey: string;
};

type LoadedAssertion = {
  id: string;
  kind: "grounded" | "reference";
  statement: string;
  objectIds: Set<string>;
  sources: AssertionSupportView["sources"];
};

type ValidatedProposal = {
  cardsBySelector: Map<string, VirtualCard>;
  assertionsById: Map<string, LoadedAssertion>;
};

export class SemanticViewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticViewValidationError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function latestCompilation(database: DatabaseClient) {
  return database.memoryCompilation.findFirst({
    orderBy: { importedAt: "desc" },
    select: { id: true, sourceTitle: true },
  });
}

async function loadAssertions(
  database: DatabaseClient,
  assertionIds: string[],
): Promise<Map<string, LoadedAssertion>> {
  if (!assertionIds.length) return new Map();
  const assertions = await database.memoryAssertion.findMany({
    where: { id: { in: [...new Set(assertionIds)] } },
    select: {
      id: true,
      kind: true,
      sourceClaimId: true,
      globalStatementTemplateMarkdown: true,
      compilation: { select: { sourceTitle: true } },
      sourceRegion: { select: { sourceNodeId: true, label: true } },
      sourceBlockLinks: {
        orderBy: { ordinal: "asc" },
        select: {
          sourceBlock: {
            select: {
              sourceBlockId: true,
              sourcePages: true,
              markdown: true,
            },
          },
        },
      },
      fragmentReferences: {
        orderBy: { ordinal: "asc" },
        select: {
          globalResolutions: {
            select: {
              globalObject: { select: { id: true, canonicalName: true } },
            },
          },
        },
      },
      literalGlobalReferences: {
        orderBy: { globalOrdinal: "asc" },
        select: {
          globalObject: { select: { id: true, canonicalName: true } },
        },
      },
    },
  });

  return new Map(assertions.map((assertion) => {
    const references = [
      ...assertion.fragmentReferences.map((reference) => {
        if (reference.globalResolutions.length !== 1) {
          throw new SemanticViewValidationError(
            `Assertion ${assertion.id} 没有唯一的 GlobalObject resolution`,
          );
        }
        const object = reference.globalResolutions[0].globalObject;
        return { globalObjectId: object.id, canonicalName: object.canonicalName };
      }),
      ...assertion.literalGlobalReferences.map(({ globalObject }) => ({
        globalObjectId: globalObject.id,
        canonicalName: globalObject.canonicalName,
      })),
    ];
    return [assertion.id, {
      id: assertion.id,
      kind: assertion.kind,
      statement: renderResolvedAssertion({
        globalStatementTemplateMarkdown: assertion.globalStatementTemplateMarkdown,
        references,
        assertionKey: `${assertion.sourceRegion.sourceNodeId}\u0000${assertion.sourceClaimId}`,
      }),
      objectIds: new Set(references.map((reference) => reference.globalObjectId)),
      sources: assertion.sourceBlockLinks.map(({ sourceBlock }) => ({
        sourceTitle: assertion.compilation.sourceTitle,
        sourceNodeId: assertion.sourceRegion.sourceNodeId,
        sourceRegionLabel: assertion.sourceRegion.label,
        sourceBlockId: sourceBlock.sourceBlockId,
        pages: sourceBlock.sourcePages,
        excerpt: sourceBlock.markdown,
      })),
    }];
  }));
}

export function assertGroundedAssertionSupports(
  assertions: Iterable<{ id: string; kind: "grounded" | "reference" }>,
): void {
  const referenceIds = [...assertions]
    .filter((assertion) => assertion.kind === "reference")
    .map((assertion) => assertion.id);
  if (referenceIds.length) {
    throw new SemanticViewValidationError(
      "Reference Assertion 只能用于定位原文，不能直接作为 Business View support：" +
        referenceIds.join(", "),
    );
  }
}

function allSupportingAssertionIds(payload: ViewChangePayload): string[] {
  return [...new Set(payload.changes.flatMap((change) =>
    change.type === "CREATE_CARD" ? [] : change.supportingAssertionIds
  ))];
}

function resolveCard(
  cardsBySelector: Map<string, VirtualCard>,
  selector: string,
): VirtualCard {
  const card = cardsBySelector.get(selector);
  if (!card) {
    throw new SemanticViewValidationError(
      `Card ${selector} 不存在；新 Card 必须用 new:<cardRef> 引用`,
    );
  }
  return card;
}

export function assertSameBusinessView(
  sourceCard: { selector: string; viewKey: string },
  targetCard: { selector: string; viewKey: string },
): void {
  if (sourceCard.viewKey !== targetCard.viewKey) {
    throw new SemanticViewValidationError(
      `禁止跨 Business View SlotBinding：${sourceCard.selector} 属于 ${sourceCard.viewKey}，` +
      `${targetCard.selector} 属于 ${targetCard.viewKey}`,
    );
  }
}

async function validateProposal(
  database: DatabaseClient,
  payload: ViewChangePayload,
  compilationId: string,
  allowedEvidence?: {
    objectIds: ReadonlySet<string>;
    assertionIds: ReadonlySet<string>;
  },
): Promise<ValidatedProposal> {
  const existingCards = await database.semanticCard.findMany({
    where: { compilationId, viewKey: payload.viewKey },
    include: { sourceObject: { select: { canonicalName: true } } },
  });
  const cardsBySelector = new Map<string, VirtualCard>(existingCards.map((card) => [
    card.id,
    {
      selector: card.id,
      id: card.id,
      viewKey: payload.viewKey,
      objectId: card.sourceObjectId,
      objectName: card.sourceObject.canonicalName,
      cardTypeKey: card.cardTypeKey,
    },
  ]));

  const referencedExistingCardIds = [...new Set(payload.changes.flatMap((change) => {
    if (change.type === "CREATE_CARD") return [];
    return [change.card, ...(change.type === "SET_SLOT" ? change.targets : [])]
      .filter((selector) => !selector.startsWith("new:"));
  }))];
  if (referencedExistingCardIds.length) {
    const referencedCards = await database.semanticCard.findMany({
      where: { id: { in: referencedExistingCardIds } },
      select: { id: true, viewKey: true },
    });
    const crossViewCard = referencedCards.find(
      (card) => card.viewKey !== payload.viewKey,
    );
    if (crossViewCard) {
      throw new SemanticViewValidationError(
        `禁止跨 Business View 引用 Card：${crossViewCard.id} 属于 ${crossViewCard.viewKey}，` +
        `当前 Proposal 属于 ${payload.viewKey}`,
      );
    }
  }

  const createChanges = payload.changes.filter(
    (change): change is Extract<ViewChange, { type: "CREATE_CARD" }> =>
      change.type === "CREATE_CARD",
  );
  const createObjectIds = [...new Set(createChanges.map((change) => change.sourceObjectId))];
  if (allowedEvidence) {
    const unseen = createObjectIds.filter((id) => !allowedEvidence.objectIds.has(id));
    if (unseen.length) {
      throw new SemanticViewValidationError(
        `CREATE_CARD 只能使用本轮 Shared Brain 检索中出现的 Object：${unseen.join(", ")}`,
      );
    }
  }
  const objects = await database.memoryGlobalObject.findMany({
    where: { id: { in: createObjectIds }, compilationId },
    select: { id: true, canonicalName: true },
  });
  const objectsById = new Map(objects.map((object) => [object.id, object]));

  const seenNewRefs = new Set<string>();
  for (const change of createChanges) {
    if (seenNewRefs.has(change.cardRef)) {
      throw new SemanticViewValidationError(`重复的 cardRef：${change.cardRef}`);
    }
    seenNewRefs.add(change.cardRef);
    const object = objectsById.get(change.sourceObjectId);
    if (!object) {
      throw new SemanticViewValidationError(
        `Object ${change.sourceObjectId} 不存在于当前 Compilation`,
      );
    }
    const cardType = cardTypeDefinition(payload.viewKey, change.cardTypeKey);
    if (!cardType) {
      throw new SemanticViewValidationError(`不支持的 Card Type：${change.cardTypeKey}`);
    }
    const duplicate = [...cardsBySelector.values()].find(
      (card) =>
        card.objectId === change.sourceObjectId &&
        card.cardTypeKey === change.cardTypeKey,
    );
    if (duplicate) {
      throw new SemanticViewValidationError(
        `${object.canonicalName} 已有 ${change.cardTypeKey}，请直接修改现有 Card`,
      );
    }
    const selector = `new:${change.cardRef}`;
    cardsBySelector.set(selector, {
      selector,
      viewKey: payload.viewKey,
      objectId: object.id,
      objectName: object.canonicalName,
      cardTypeKey: change.cardTypeKey,
    });
  }

  const supportingAssertionIds = allSupportingAssertionIds(payload);
  if (allowedEvidence) {
    const unseen = supportingAssertionIds.filter(
      (id) => !allowedEvidence.assertionIds.has(id),
    );
    if (unseen.length) {
      throw new SemanticViewValidationError(
        `只能引用本轮 Shared Brain 检索中出现的 Assertion：${unseen.join(", ")}`,
      );
    }
  }
  const assertionsById = await loadAssertions(database, supportingAssertionIds);
  const missingAssertions = supportingAssertionIds.filter(
    (id) => !assertionsById.has(id),
  );
  if (missingAssertions.length) {
    throw new SemanticViewValidationError(
      `Assertion 不存在：${missingAssertions.join(", ")}`,
    );
  }
  assertGroundedAssertionSupports(assertionsById.values());

  const touchedDimensions = new Set<string>();
  const touchedSlots = new Set<string>();
  for (const change of payload.changes) {
    if (change.type === "CREATE_CARD") continue;
    const sourceCard = resolveCard(cardsBySelector, change.card);

    if (change.type === "SET_CONTENT_DIMENSION") {
      const key = `${change.card}\u0000${change.name}`;
      if (touchedDimensions.has(key)) {
        throw new SemanticViewValidationError(
          `同一 Proposal 不能重复设置 ContentDimension：${change.name}`,
        );
      }
      touchedDimensions.add(key);
      for (const assertionId of change.supportingAssertionIds) {
        if (!assertionsById.get(assertionId)!.objectIds.has(sourceCard.objectId)) {
          throw new SemanticViewValidationError(
            `Assertion ${assertionId} 没有引用 ${sourceCard.objectName}，不能支撑其 ContentDimension`,
          );
        }
      }
      continue;
    }

    const slotKey = `${change.card}\u0000${change.slotKey}`;
    if (touchedSlots.has(slotKey)) {
      throw new SemanticViewValidationError(
        `同一 Proposal 不能重复设置 Slot：${change.slotKey}`,
      );
    }
    touchedSlots.add(slotKey);
    const sourceType = cardTypeDefinition(sourceCard.viewKey, sourceCard.cardTypeKey);
    const slot = sourceType?.slots[change.slotKey];
    if (!slot) {
      throw new SemanticViewValidationError(
        `${sourceCard.cardTypeKey} 没有定义 Slot ${change.slotKey}`,
      );
    }
    if (slot.cardinality === "one" && change.targets.length > 1) {
      throw new SemanticViewValidationError(`${slot.label} 最多只能连接一张 Card`);
    }
    const targetSelectors = new Set(change.targets);
    if (targetSelectors.size !== change.targets.length) {
      throw new SemanticViewValidationError(`${slot.label} targets 不能重复`);
    }
    for (const targetSelector of change.targets) {
      const targetCard = resolveCard(cardsBySelector, targetSelector);
      assertSameBusinessView(sourceCard, targetCard);
      if (targetCard.selector === sourceCard.selector) {
        throw new SemanticViewValidationError(`${slot.label} 不能连接 Card 自身`);
      }
      if (!slot.allowedTargetCardTypes.includes(targetCard.cardTypeKey)) {
        throw new SemanticViewValidationError(
          `${slot.label} 不能连接 ${targetCard.cardTypeKey}`,
        );
      }
      const jointlySupported = change.supportingAssertionIds.length === 0 ||
        change.supportingAssertionIds.some((assertionId) => {
          const objectIds = assertionsById.get(assertionId)!.objectIds;
          return objectIds.has(sourceCard.objectId) && objectIds.has(targetCard.objectId);
        });
      if (!jointlySupported) {
        throw new SemanticViewValidationError(
          `本次 Proposal 声明的 Assertion 没有同时引用 ${sourceCard.objectName} 与 ${targetCard.objectName}`,
        );
      }
    }
  }

  return { cardsBySelector, assertionsById };
}

function assertionViews(
  ids: string[],
  assertionsById: Map<string, LoadedAssertion>,
): AssertionSupportView[] {
  return ids.map((id) => {
    const assertion = assertionsById.get(id)!;
    return {
      id,
      statement: assertion.statement,
      sources: assertion.sources,
    };
  });
}

export async function getSemanticView(viewKey: string): Promise<SemanticViewState> {
  const view = businessViewDefinition(viewKey);
  if (!view) {
    throw new SemanticViewValidationError(`不支持的 Business View：${viewKey}`);
  }
  const database = getDatabase();
  const compilation = await latestCompilation(database);
  if (!compilation) {
    return {
      viewKey: view.key,
      viewLabel: view.label,
      viewDescription: view.meaning,
      ...(view.specializedLabel ? { specializedLabel: view.specializedLabel } : {}),
      compilationId: null,
      compatible: true,
      cardTypes: supportedCardTypeSummary(view.key),
      cards: [],
    };
  }

  const allViewCards = await database.semanticCard.findMany({
    where: { viewKey: view.key },
    select: { compilationId: true },
  });
  const mismatched = allViewCards.some((card) => card.compilationId !== compilation.id);
  if (mismatched) {
    return {
      viewKey: view.key,
      viewLabel: view.label,
      viewDescription: view.meaning,
      ...(view.specializedLabel ? { specializedLabel: view.specializedLabel } : {}),
      compilationId: compilation.id,
      compatible: false,
      incompatibilityReason:
        `${view.label}来自旧 Compilation；为避免 Object 身份错配，当前已阻止读取和修改。`,
      cardTypes: supportedCardTypeSummary(view.key),
      cards: [],
    };
  }

  const cards = await database.semanticCard.findMany({
    where: { compilationId: compilation.id, viewKey: view.key },
    orderBy: { createdAt: "asc" },
    include: {
      sourceObject: { select: { canonicalName: true } },
      contentDimensions: {
        orderBy: { createdAt: "asc" },
      },
      outgoingSlots: {
        orderBy: [{ slotKey: "asc" }, { createdAt: "asc" }],
        include: {
          targetCard: {
            include: { sourceObject: { select: { canonicalName: true } } },
          },
        },
      },
    },
  });

  for (const card of cards) {
    for (const binding of card.outgoingSlots) {
      if (binding.targetCard.viewKey !== card.viewKey) {
        throw new SemanticViewValidationError(
          `检测到非法跨 Business View SlotBinding：${card.id} → ${binding.targetCardId}`,
        );
      }
    }
  }

  return {
    viewKey: view.key,
    viewLabel: view.label,
    viewDescription: view.meaning,
    ...(view.specializedLabel ? { specializedLabel: view.specializedLabel } : {}),
    compilationId: compilation.id,
    compatible: true,
    cardTypes: supportedCardTypeSummary(view.key),
    cards: cards.map((card) => {
      const cardType = cardTypeDefinition(view.key, card.cardTypeKey);
      const bindingsBySlot = new Map<string, typeof card.outgoingSlots>();
      for (const binding of card.outgoingSlots) {
        const bindings = bindingsBySlot.get(binding.slotKey) ?? [];
        bindings.push(binding);
        bindingsBySlot.set(binding.slotKey, bindings);
      }
      return {
        id: card.id,
        viewKey: view.key,
        cardTypeKey: card.cardTypeKey,
        cardTypeLabel: cardType?.label ?? card.cardTypeKey,
        objectId: card.sourceObjectId,
        objectName: card.sourceObject.canonicalName,
        seedContentDimensions: [...(cardType?.seedContentDimensions ?? [])],
        contentDimensions: card.contentDimensions.map((dimension) => ({
          id: dimension.id,
          name: dimension.name,
          contentMarkdown: dimension.contentMarkdown,
        })),
        slots: Object.values(cardType?.slots ?? {}).map((slot) => ({
          key: slot.key,
          label: slot.label,
          meaning: slot.meaning,
          cardinality: slot.cardinality,
          targets: (bindingsBySlot.get(slot.key) ?? []).map((binding) => ({
            cardId: binding.targetCardId,
            cardTypeKey: binding.targetCard.cardTypeKey,
            objectId: binding.targetCard.sourceObjectId,
            objectName: binding.targetCard.sourceObject.canonicalName,
          })),
        })),
      };
    }),
  };
}

export function getSocietyInformation(): Promise<SemanticViewState> {
  return getSemanticView(SOCIETY_INFORMATION_VIEW);
}

async function presentProposal(
  proposal: {
    id: string;
    status: string;
    reason: string;
    payload: Prisma.JsonValue;
    createdAt: Date;
    failureReason: string | null;
    compilationId: string;
  },
  validated?: ValidatedProposal,
): Promise<ViewProposalPresentation> {
  const payload = viewChangePayloadSchema.parse(proposal.payload);
  const state = validated ?? await validateProposal(
    getDatabase(),
    payload,
    proposal.compilationId,
  );
  const existingDimensions = await getDatabase().semanticContentDimension.findMany({
    where: {
      cardId: {
        in: [...state.cardsBySelector.values()].flatMap((card) => card.id ? [card.id] : []),
      },
    },
  });
  const dimensionByKey = new Map(
    existingDimensions.map((dimension) => [
      `${dimension.cardId}\u0000${dimension.name}`,
      dimension.contentMarkdown,
    ]),
  );
  const existingBindings = await getDatabase().semanticSlotBinding.findMany({
    where: {
      sourceCardId: {
        in: [...state.cardsBySelector.values()].flatMap((card) => card.id ? [card.id] : []),
      },
    },
    include: { targetCard: { include: { sourceObject: true } } },
  });

  return {
    id: proposal.id,
    viewKey: payload.viewKey,
    status: proposal.status as ViewProposalPresentation["status"],
    reason: proposal.reason,
    createdAt: proposal.createdAt.toISOString(),
    ...(proposal.failureReason ? { failureReason: proposal.failureReason } : {}),
    changes: payload.changes.map((change) => {
      if (change.type === "CREATE_CARD") {
        const card = resolveCard(state.cardsBySelector, `new:${change.cardRef}`);
        return {
          type: change.type,
          title: `创建 ${cardTypeDefinition(payload.viewKey, change.cardTypeKey)!.label}`,
          cardSelector: card.selector,
          cardTypeKey: card.cardTypeKey,
          objectId: card.objectId,
          objectName: card.objectName,
          cardTypeLabel: cardTypeDefinition(payload.viewKey, change.cardTypeKey)!.label,
        };
      }
      const card = resolveCard(state.cardsBySelector, change.card);
      const cardLabel = `${card.objectName} · ${cardTypeDefinition(card.viewKey, card.cardTypeKey)?.label ?? card.cardTypeKey}`;
      if (change.type === "SET_CONTENT_DIMENSION") {
        return {
          type: change.type,
          title: `设置「${change.name}」`,
          cardSelector: card.selector,
          ...(card.id ? { cardId: card.id } : {}),
          cardTypeKey: card.cardTypeKey,
          cardLabel,
          dimensionName: change.name,
          before: card.id
            ? dimensionByKey.get(`${card.id}\u0000${change.name}`) ?? null
            : null,
          after: change.contentMarkdown,
          supports: assertionViews(change.supportingAssertionIds, state.assertionsById),
        };
      }
      const slot = cardTypeDefinition(card.viewKey, card.cardTypeKey)!.slots[change.slotKey];
      return {
        type: change.type,
        title: `设置「${slot.label}」`,
        cardSelector: card.selector,
        ...(card.id ? { cardId: card.id } : {}),
        cardTypeKey: card.cardTypeKey,
        cardLabel,
        slotKey: change.slotKey,
        slotLabel: slot.label,
        before: card.id
          ? existingBindings
              .filter((binding) =>
                binding.sourceCardId === card.id && binding.slotKey === change.slotKey
              )
              .map((binding) => ({
                cardSelector: binding.targetCard.id,
                cardId: binding.targetCard.id,
                cardTypeKey: binding.targetCard.cardTypeKey,
                objectId: binding.targetCard.sourceObjectId,
                objectName: binding.targetCard.sourceObject.canonicalName,
              }))
          : [],
        after: change.targets.map((target) => {
          const targetCard = resolveCard(state.cardsBySelector, target);
          return {
            cardSelector: targetCard.selector,
            ...(targetCard.id ? { cardId: targetCard.id } : {}),
            cardTypeKey: targetCard.cardTypeKey,
            objectId: targetCard.objectId,
            objectName: targetCard.objectName,
          };
        }),
        supports: assertionViews(change.supportingAssertionIds, state.assertionsById),
      };
    }),
  };
}

export async function createViewProposal(input: {
  payload: ViewChangePayload;
  evidenceCompilationId?: string;
  allowedObjectIds: ReadonlySet<string>;
  allowedAssertionIds: ReadonlySet<string>;
}): Promise<ViewProposalPresentation> {
  const database = getDatabase();
  const payload = viewChangePayloadSchema.parse(input.payload);
  const compilation = await latestCompilation(database);
  if (!compilation) throw new SemanticViewValidationError("当前没有可用的 Shared Brain Compilation");
  if (
    input.evidenceCompilationId &&
    input.evidenceCompilationId !== compilation.id
  ) {
    throw new SemanticViewValidationError(
      "本轮 Shared Brain 证据与当前 active Compilation 不一致，请重新检索",
    );
  }
  const view = await getSemanticView(payload.viewKey);
  if (!view.compatible) {
    throw new SemanticViewValidationError(view.incompatibilityReason!);
  }
  const validated = await validateProposal(database, payload, compilation.id, {
    objectIds: input.allowedObjectIds,
    assertionIds: input.allowedAssertionIds,
  });
  const proposal = await database.semanticCardProposal.create({
    data: {
      compilationId: compilation.id,
      viewKey: payload.viewKey,
      reason: payload.reason,
      payload: payload as Prisma.InputJsonValue,
    },
  });
  return presentProposal(proposal, validated);
}

function actualCardId(
  selector: string,
  createdCardIds: Map<string, string>,
): string {
  if (!selector.startsWith("new:")) return selector;
  const id = createdCardIds.get(selector);
  if (!id) throw new SemanticViewValidationError(`无法解析 ${selector}`);
  return id;
}

export async function decideViewProposal(
  proposalId: string,
  decision: "approve" | "reject",
): Promise<{ proposal: ViewProposalPresentation; view: SemanticViewState }> {
  const database = getDatabase();
  const proposal = await database.semanticCardProposal.findUnique({
    where: { id: proposalId },
  });
  if (!proposal) throw new SemanticViewValidationError("Proposal 不存在");
  if (proposal.status !== "pending") {
    throw new SemanticViewValidationError(`Proposal 已经是 ${proposal.status} 状态`);
  }
  const payload = viewChangePayloadSchema.parse(proposal.payload);

  if (decision === "reject") {
    await database.semanticCardProposal.update({
      where: { id: proposal.id },
      data: { status: "rejected", decidedAt: new Date() },
    });
    let rejectedPresentation: ViewProposalPresentation;
    try {
      rejectedPresentation = {
        ...await presentProposal(proposal),
        status: "rejected",
      };
    } catch {
      rejectedPresentation = {
        id: proposal.id,
        viewKey: payload.viewKey,
        status: "rejected",
        reason: proposal.reason,
        createdAt: proposal.createdAt.toISOString(),
        changes: [],
      };
    }
    return {
      proposal: rejectedPresentation,
      view: await getSemanticView(payload.viewKey),
    };
  }

  const presentation = await presentProposal(proposal);
  try {
    await database.$transaction(async (transaction) => {
      const current = await transaction.semanticCardProposal.findUnique({
        where: { id: proposal.id },
      });
      if (!current || current.status !== "pending") {
        throw new SemanticViewValidationError("Proposal 已被处理");
      }
      const compilation = await latestCompilation(transaction);
      if (!compilation || compilation.id !== current.compilationId) {
        throw new SemanticViewValidationError(
          "Proposal 来源 Compilation 已不是当前 active Compilation，禁止应用",
        );
      }
      await validateProposal(transaction, payload, compilation.id);
      await transaction.semanticCardProposal.update({
        where: { id: proposal.id },
        data: { status: "approved", decidedAt: new Date() },
      });

      const createdCardIds = new Map<string, string>();
      for (const change of payload.changes) {
        if (change.type !== "CREATE_CARD") continue;
        const card = await transaction.semanticCard.create({
          data: {
            compilationId: compilation.id,
            sourceObjectId: change.sourceObjectId,
            viewKey: payload.viewKey,
            cardTypeKey: change.cardTypeKey,
          },
        });
        createdCardIds.set(`new:${change.cardRef}`, card.id);
      }

      for (const change of payload.changes) {
        if (change.type === "CREATE_CARD") continue;
        const cardId = actualCardId(change.card, createdCardIds);
        if (change.type === "SET_CONTENT_DIMENSION") {
          const dimension = await transaction.semanticContentDimension.upsert({
            where: { cardId_name: { cardId, name: change.name } },
            create: {
              cardId,
              name: change.name,
              contentMarkdown: change.contentMarkdown,
            },
            update: { contentMarkdown: change.contentMarkdown },
          });
          await transaction.semanticContentDimensionSupport.deleteMany({
            where: { contentDimensionId: dimension.id },
          });
          continue;
        }

        await transaction.semanticSlotBinding.deleteMany({
          where: { sourceCardId: cardId, slotKey: change.slotKey },
        });
        for (const target of change.targets) {
          const targetCardId = actualCardId(target, createdCardIds);
          await transaction.semanticSlotBinding.create({
            data: { sourceCardId: cardId, slotKey: change.slotKey, targetCardId },
          });
        }
      }

      await transaction.semanticCardProposal.update({
        where: { id: proposal.id },
        data: { status: "applied", appliedAt: new Date() },
      });
    });
  } catch (error) {
    const failureReason = errorMessage(error);
    await database.semanticCardProposal.updateMany({
      where: { id: proposal.id, status: "pending" },
      data: { status: "failed", failureReason },
    });
    return {
      proposal: {
        ...presentation,
        status: "failed",
        failureReason,
      },
      view: await getSemanticView(payload.viewKey),
    };
  }

  return {
    proposal: { ...presentation, status: "applied" },
    view: await getSemanticView(payload.viewKey),
  };
}

export function supportedCardTypeSummary(
  viewKey: BusinessViewKey = SOCIETY_INFORMATION_VIEW,
) {
  const view = businessViewDefinition(viewKey);
  if (!view) return [];
  return Object.values(view.cardTypes).map((cardType) => ({
    key: cardType.key,
    label: cardType.label,
    meaning: cardType.meaning,
    seedContentDimensions: [...cardType.seedContentDimensions],
    slots: Object.values(cardType.slots).map((slot) => ({
      ...slot,
      allowedTargetCardTypes: [...slot.allowedTargetCardTypes],
    })),
  }));
}
