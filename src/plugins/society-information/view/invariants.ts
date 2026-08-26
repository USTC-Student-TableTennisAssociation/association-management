import type { BusinessInvariant, ViewCardState } from "@sydaris/plugin-sdk";

const relatedObjectCardTypes = new Set([
  "SocietyCard",
  "PersonCard",
  "ActivityCard",
  "PlatformCard",
]);

function assertExactlyOneRelatedObject(card: ViewCardState): void {
  if (relatedObjectCardTypes.has(card.cardTypeKey) && card.relatedObjectIds.length !== 1) {
    throw new Error(`${card.cardTypeKey} ${card.id} 必须关联且仅关联一个 Object`);
  }
}

export const societyInformationInvariants: readonly BusinessInvariant[] = [
  {
    key: "society.single_overview_graph",
    description: "社团概览最多有一个主 SocietyCard，团队、活动与平台必须属于它的正式 Slot。",
    async validate(transaction) {
      const cards = await transaction.queryCards();
      const societies = cards.filter((card) => card.cardTypeKey === "SocietyCard");
      if (societies.length > 1) throw new Error("社团概览只能有一个主 SocietyCard");
      if (!societies.length) {
        if (cards.length) throw new Error("没有 SocietyCard 时不能存在其他社团概览 Card");
        return;
      }

      const society = societies[0];
      const referencedCards: Record<string, ReadonlySet<string>> = {
        PersonCard: new Set([
          ...(society.slots.advisor ?? []),
          ...(society.slots.team ?? []),
        ]),
        ActivityCard: new Set(society.slots.activities ?? []),
        PlatformCard: new Set(society.slots.platforms ?? []),
      };
      for (const card of cards) {
        if (!relatedObjectCardTypes.has(card.cardTypeKey)) {
          throw new Error(`社团概览存在未声明或已移除的 Card Type：${card.cardTypeKey}`);
        }
        assertExactlyOneRelatedObject(card);
        if (
          (card.cardTypeKey === "ActivityCard" || card.cardTypeKey === "PlatformCard") &&
          !referencedCards[card.cardTypeKey].has(card.id)
        ) {
          throw new Error(`${card.cardTypeKey} ${card.id} 没有归属于主 SocietyCard`);
        }
      }

      for (const [cardTypeKey, referencedIds] of Object.entries(referencedCards)) {
        const cardsOfType = new Set(
          cards.filter((card) => card.cardTypeKey === cardTypeKey).map((card) => card.id),
        );
        for (const referencedId of referencedIds) {
          if (!cardsOfType.has(referencedId)) {
            throw new Error(`SocietyCard Slot 引用了不存在的 ${cardTypeKey}：${referencedId}`);
          }
        }
      }
    },
  },
];
