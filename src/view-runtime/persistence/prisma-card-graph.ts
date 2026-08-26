import { Prisma, type PrismaClient } from "@/generated/prisma/client";

import type {
  CardTypeDefinition,
  DimensionDefinition,
  RelatedObjectPolicy,
  SlotDefinition,
  ViewCardState,
  ViewModule,
  ViewTransaction,
} from "@/contracts";
import { ViewRuntimeError } from "@/view-runtime/domain/errors";
import {
  validateCardDimensionValues,
  validateDimensionValue,
} from "@/view-runtime/domain/dimension-value";

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export class PrismaCardGraphTransaction implements ViewTransaction {
  private readonly cardTypes: Map<string, CardTypeDefinition>;

  constructor(
    private readonly database: DatabaseClient,
    private readonly view: ViewModule,
  ) {
    this.cardTypes = new Map(view.schema.cardTypes.map((card) => [card.key, card]));
  }

  async getCard(cardId: string): Promise<ViewCardState | undefined> {
    const card = await this.database.viewCard.findFirst({
      where: { id: cardId, viewKey: this.view.manifest.key },
      include: {
        dimensions: true,
        outgoingSlots: {
          orderBy: [{ slotKey: "asc" }, { position: "asc" }, { createdAt: "asc" }],
        },
        relatedObjects: { orderBy: { createdAt: "asc" } },
      },
    });
    return card ? this.toState(card) : undefined;
  }

  async queryCards(query: {
    cardTypeKey?: string;
    relatedObjectId?: string;
  } = {}): Promise<ViewCardState[]> {
    const cards = await this.database.viewCard.findMany({
      where: {
        viewKey: this.view.manifest.key,
        ...(query.cardTypeKey ? { cardTypeKey: query.cardTypeKey } : {}),
        ...(query.relatedObjectId
          ? { relatedObjects: { some: { objectId: query.relatedObjectId } } }
          : {}),
      },
      orderBy: { createdAt: "asc" },
      include: {
        dimensions: true,
        outgoingSlots: {
          orderBy: [{ slotKey: "asc" }, { position: "asc" }, { createdAt: "asc" }],
        },
        relatedObjects: { orderBy: { createdAt: "asc" } },
      },
    });
    return cards.map((card) => this.toState(card));
  }

  async createCard(input: {
    cardTypeKey: string;
    dimensions?: Readonly<Record<string, unknown>>;
    relatedObjectIds?: readonly string[];
  }): Promise<string> {
    const cardType = this.requireCardType(input.cardTypeKey);
    const dimensions = validateCardDimensionValues(cardType.dimensions, input.dimensions ?? {});
    const relatedObjectIds = unique(input.relatedObjectIds ?? []);
    if (relatedObjectIds.length !== (input.relatedObjectIds?.length ?? 0)) {
      throw new ViewRuntimeError("Related Object IDs 不能重复");
    }
    await this.validateRelatedObjects(cardType, relatedObjectIds);

    const card = await this.database.viewCard.create({
      data: {
        viewKey: this.view.manifest.key,
        cardTypeKey: cardType.key,
        dimensions: {
          create: Object.entries(dimensions).map(([dimensionKey, value]) => ({
            dimensionKey,
            valueJson: jsonValue(value),
          })),
        },
        relatedObjects: {
          create: relatedObjectIds.map((objectId) => ({ objectId })),
        },
      },
      select: { id: true },
    });
    return card.id;
  }

  async deleteCard(cardId: string): Promise<void> {
    await this.requireCard(cardId);
    await this.database.viewCard.delete({ where: { id: cardId } });
  }

  async setDimension(cardId: string, key: string, value: unknown): Promise<void> {
    const card = await this.requireCard(cardId);
    const definition = this.requireDimension(card.cardTypeKey, key);
    const normalized = validateDimensionValue(definition, value);
    await this.database.viewDimensionValue.upsert({
      where: { cardId_dimensionKey: { cardId, dimensionKey: key } },
      create: { cardId, dimensionKey: key, valueJson: jsonValue(normalized) },
      update: { valueJson: jsonValue(normalized) },
    });
  }

  async clearDimension(cardId: string, key: string): Promise<void> {
    const card = await this.requireCard(cardId);
    const definition = this.requireDimension(card.cardTypeKey, key);
    if (definition.required) {
      throw new ViewRuntimeError(`必填 Dimension 不能清空：${key}`);
    }
    await this.database.viewDimensionValue.deleteMany({ where: { cardId, dimensionKey: key } });
  }

  async setSlot(cardId: string, key: string, targets: readonly string[]): Promise<void> {
    const source = await this.requireCard(cardId);
    const definition = this.requireSlot(source.cardTypeKey, key);
    const targetIds = unique(targets);
    if (targetIds.length !== targets.length) throw new ViewRuntimeError(`Slot ${key} targets 不能重复`);
    if (definition.cardinality === "one" && targetIds.length > 1) {
      throw new ViewRuntimeError(`Slot ${key} 最多只能有一个 target`);
    }
    if (definition.required && targetIds.length === 0) {
      throw new ViewRuntimeError(`Slot ${key} 是必填项`);
    }
    const targetCards = targetIds.length
      ? await this.database.viewCard.findMany({
          where: { id: { in: targetIds } },
          select: { id: true, viewKey: true, cardTypeKey: true },
        })
      : [];
    if (targetCards.length !== targetIds.length) {
      throw new ViewRuntimeError(`Slot ${key} 存在不存在的 target Card`);
    }
    for (const target of targetCards) {
      if (target.viewKey !== this.view.manifest.key) {
        throw new ViewRuntimeError(`Slot ${key} 不允许跨 View 连接`);
      }
      if (!definition.allowedTargetCardTypes.includes(target.cardTypeKey)) {
        throw new ViewRuntimeError(`Slot ${key} 不允许 target ${target.cardTypeKey}`);
      }
    }
    await this.database.viewSlotBinding.deleteMany({ where: { sourceCardId: cardId, slotKey: key } });
    if (targetIds.length) {
      await this.database.viewSlotBinding.createMany({
        data: targetIds.map((targetCardId, position) => ({
          sourceCardId: cardId,
          slotKey: key,
          targetCardId,
          position,
        })),
      });
    }
  }

  async setRelatedObjects(cardId: string, objectIds: readonly string[]): Promise<void> {
    const card = await this.requireCard(cardId);
    const cardType = this.requireCardType(card.cardTypeKey);
    const ids = unique(objectIds);
    if (ids.length !== objectIds.length) throw new ViewRuntimeError("Related Object IDs 不能重复");
    await this.validateRelatedObjects(cardType, ids, cardId);
    await this.database.viewCardRelatedObject.deleteMany({ where: { cardId } });
    if (ids.length) {
      await this.database.viewCardRelatedObject.createMany({
        data: ids.map((objectId) => ({ cardId, objectId })),
      });
    }
  }

  private requireCardType(cardTypeKey: string): CardTypeDefinition {
    const cardType = this.cardTypes.get(cardTypeKey);
    if (!cardType) {
      throw new ViewRuntimeError(
        `View ${this.view.manifest.key} 没有声明 Card Type ${cardTypeKey}`,
      );
    }
    return cardType;
  }

  private requireDimension(cardTypeKey: string, key: string): DimensionDefinition {
    const definition = this.requireCardType(cardTypeKey).dimensions.find(
      (dimension) => dimension.key === key,
    );
    if (!definition) throw new ViewRuntimeError(`${cardTypeKey} 没有声明 Dimension ${key}`);
    return definition;
  }

  private requireSlot(cardTypeKey: string, key: string): SlotDefinition {
    const definition = this.requireCardType(cardTypeKey).slots.find((slot) => slot.key === key);
    if (!definition) throw new ViewRuntimeError(`${cardTypeKey} 没有声明 Slot ${key}`);
    return definition;
  }

  private async requireCard(cardId: string): Promise<{ id: string; cardTypeKey: string }> {
    const card = await this.database.viewCard.findFirst({
      where: { id: cardId, viewKey: this.view.manifest.key },
      select: { id: true, cardTypeKey: true },
    });
    if (!card) throw new ViewRuntimeError(`Card 不存在于 ${this.view.manifest.key}：${cardId}`);
    return card;
  }

  private async validateRelatedObjects(
    cardType: CardTypeDefinition,
    objectIds: readonly string[],
    excludingCardId?: string,
  ): Promise<void> {
    const policy: RelatedObjectPolicy | undefined = cardType.relatedObjects;
    if (!policy && objectIds.length) {
      throw new ViewRuntimeError(`${cardType.key} 不允许 Related Objects`);
    }
    if ((policy?.min ?? 0) > objectIds.length) {
      throw new ViewRuntimeError(`${cardType.key} 至少需要 ${policy!.min} 个 Related Objects`);
    }
    if (policy?.max !== undefined && objectIds.length > policy.max) {
      throw new ViewRuntimeError(`${cardType.key} 最多允许 ${policy.max} 个 Related Objects`);
    }
    if (objectIds.length) {
      const existingObjects = await this.database.memoryGlobalObject.findMany({
        where: { id: { in: [...objectIds] } },
        select: { id: true },
      });
      if (existingObjects.length !== objectIds.length) {
        const existingIds = new Set(existingObjects.map((object) => object.id));
        const missingIds = objectIds.filter((objectId) => !existingIds.has(objectId));
        throw new ViewRuntimeError(`Related Objects 不存在：${missingIds.join(", ")}`);
      }
    }
    if (policy?.uniqueCardPerObject && objectIds.length) {
      const duplicate = await this.database.viewCard.findFirst({
        where: {
          viewKey: this.view.manifest.key,
          cardTypeKey: cardType.key,
          ...(excludingCardId ? { id: { not: excludingCardId } } : {}),
          relatedObjects: { some: { objectId: objectIds[0] } },
        },
        select: { id: true },
      });
      if (duplicate) {
        throw new ViewRuntimeError(
          `${cardType.key} 已有关联 Object ${objectIds[0]} 的 Card`,
        );
      }
    }
  }

  private toState(card: {
    id: string;
    viewKey: string;
    cardTypeKey: string;
    dimensions: Array<{ dimensionKey: string; valueJson: Prisma.JsonValue }>;
    outgoingSlots: Array<{ slotKey: string; targetCardId: string; position: number }>;
    relatedObjects: Array<{ objectId: string }>;
  }): ViewCardState {
    const slots: Record<string, string[]> = {};
    for (const binding of card.outgoingSlots) {
      (slots[binding.slotKey] ??= []).push(binding.targetCardId);
    }
    return {
      id: card.id,
      viewKey: card.viewKey,
      cardTypeKey: card.cardTypeKey,
      dimensions: Object.fromEntries(
        card.dimensions.map((dimension) => [dimension.dimensionKey, dimension.valueJson]),
      ),
      slots,
      relatedObjectIds: card.relatedObjects.map((relation) => relation.objectId),
    };
  }
}
