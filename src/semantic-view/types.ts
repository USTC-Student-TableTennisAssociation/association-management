import { z } from "zod";

export const SOCIETY_INFORMATION_VIEW = "society_information" as const;
export const ACTIVITY_OPERATIONS_VIEW = "activity_operations" as const;
export const businessViewKeySchema = z.union([
  z.literal(SOCIETY_INFORMATION_VIEW),
  z.literal(ACTIVITY_OPERATIONS_VIEW),
]);
export type BusinessViewKey = z.infer<typeof businessViewKeySchema>;

const cardSelectorSchema = z.string().trim().min(1).max(100).describe(
  "已有 Card UUID，或同一 proposal 内 CREATE_CARD 的 new:<cardRef>",
);

const supportingAssertionIdsSchema = z.array(z.string().uuid()).max(20).default([])
  .describe("可选：本轮 Shared Brain 检索结果中真实存在、用于解释本次 Proposal 的 Assertion database ids");

export const createCardChangeSchema = z.object({
  type: z.literal("CREATE_CARD"),
  cardRef: z.string().trim().regex(/^[a-z][a-z0-9_-]*$/).max(50)
    .describe("供同一 proposal 后续 change 以 new:<cardRef> 引用的局部名字"),
  sourceObjectId: z.string().uuid().optional()
    .describe("source-backed Card 使用本轮 Shared Brain 检索结果中的 GlobalObject database id"),
  name: z.string().trim().min(1).max(200).optional()
    .describe("activity_operations 原生 Runtime Card 的名称"),
  cardTypeKey: z.string().trim().min(1).max(100),
}).refine((change) => Boolean(change.sourceObjectId || change.name), {
  message: "CREATE_CARD 必须提供 sourceObjectId 或原生 Card name",
});

export const setContentDimensionChangeSchema = z.object({
  type: z.literal("SET_CONTENT_DIMENSION"),
  card: cardSelectorSchema,
  name: z.string().trim().min(1).max(100),
  contentMarkdown: z.string().trim().min(1).max(5_000),
  supportingAssertionIds: supportingAssertionIdsSchema,
});

export const setSlotChangeSchema = z.object({
  type: z.literal("SET_SLOT"),
  card: cardSelectorSchema,
  slotKey: z.string().trim().min(1).max(100),
  targets: z.array(cardSelectorSchema).max(20),
  supportingAssertionIds: supportingAssertionIdsSchema,
});

export const viewChangeSchema = z.discriminatedUnion("type", [
  createCardChangeSchema,
  setContentDimensionChangeSchema,
  setSlotChangeSchema,
]);

export const viewChangePayloadSchema = z.object({
  viewKey: businessViewKeySchema,
  reason: z.string().trim().min(1).max(1_000),
  changes: z.array(viewChangeSchema).min(1).max(20),
});

export type ViewChangePayload = z.infer<typeof viewChangePayloadSchema>;
export type ViewChange = z.infer<typeof viewChangeSchema>;

export type AssertionSourceView = {
  sourceTitle: string;
  sourceNodeId: string;
  sourceRegionLabel: string;
  sourceBlockId: string;
  pages: number[];
  excerpt: string;
};

export type AssertionSupportView = {
  id: string;
  statement: string;
  sources: AssertionSourceView[];
};

export type SemanticViewCard = {
  id: string;
  viewKey: BusinessViewKey;
  cardTypeKey: string;
  cardTypeLabel: string;
  objectId?: string;
  objectName: string;
  seedContentDimensions: string[];
  contentDimensions: Array<{
    id: string;
    name: string;
    contentMarkdown: string;
  }>;
  slots: Array<{
    key: string;
    label: string;
    meaning: string;
    cardinality: "one" | "many";
    targets: Array<{
      cardId: string;
      viewKey: BusinessViewKey;
      cardTypeKey: string;
      objectId?: string;
      objectName: string;
    }>;
  }>;
};

export type SemanticViewCardType = {
  key: string;
  label: string;
  meaning: string;
  seedContentDimensions: string[];
  slots: Array<{
    key: string;
    label: string;
    meaning: string;
    cardinality: "one" | "many";
    allowedTargetCardTypes: string[];
    allowedTargetViewKey?: BusinessViewKey;
  }>;
};

export type SemanticViewState = {
  viewKey: BusinessViewKey;
  viewLabel: string;
  viewDescription: string;
  specializedLabel?: string;
  compilationId: string | null;
  compatible: boolean;
  incompatibilityReason?: string;
  cardTypes: SemanticViewCardType[];
  cards: SemanticViewCard[];
};

export type SemanticViewReferenceTarget =
  | {
      kind: "view";
      viewKey: BusinessViewKey;
    }
  | {
      kind: "card";
      viewKey: BusinessViewKey;
      cardId: string;
    }
  | {
      kind: "dimension";
      viewKey: BusinessViewKey;
      cardId: string;
      dimensionName: string;
    }
  | {
      kind: "slot";
      viewKey: BusinessViewKey;
      cardId: string;
      slotKey: string;
    };

export type SemanticViewReference = {
  ref: string;
  label: string;
  target: SemanticViewReferenceTarget;
};

export type SemanticViewReferenceBundle = {
  references: SemanticViewReference[];
};

export type SemanticViewReadSnapshot = {
  isFullSnapshot: true;
  ref: string;
  viewKey: BusinessViewKey;
  viewLabel: string;
  viewDescription: string;
  compilationId: string | null;
  compatible: boolean;
  incompatibilityReason?: string;
  cardTypes: SemanticViewCardType[];
  cards: Array<{
    ref: string;
    id: string;
    cardTypeKey: string;
    cardTypeLabel: string;
    objectId?: string;
    objectName: string;
    contentDimensions: Array<{
      ref: string;
      id?: string;
      name: string;
      contentMarkdown: string | null;
      isMissing: boolean;
    }>;
    slots: Array<{
      ref: string;
      key: string;
      label: string;
      meaning: string;
      cardinality: "one" | "many";
      targets: Array<{
        cardId: string;
        viewKey: BusinessViewKey;
        cardTypeKey: string;
        objectId?: string;
        objectName: string;
      }>;
    }>;
  }>;
};

export type SemanticViewFocus = {
  cardId?: string;
  proposalCardSelector?: string;
  dimensionName?: string;
  slotKey?: string;
};

export type BusinessViewPresentation = "overview" | "playbook" | "cards";

export type ViewProposalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "applied"
  | "failed";

export type ViewProposalCardTarget = {
  cardSelector: string;
  cardId?: string;
  cardTypeKey: string;
  objectId?: string;
  objectName: string;
};

export type ViewProposalPresentation = {
  id: string;
  viewKey: BusinessViewKey;
  status: ViewProposalStatus;
  reason: string;
  createdAt: string;
  failureReason?: string;
  changes: Array<
    | {
      type: "CREATE_CARD";
      title: string;
      cardSelector: string;
      cardTypeKey: string;
      objectId?: string;
      objectName: string;
      cardTypeLabel: string;
      }
    | {
        type: "SET_CONTENT_DIMENSION";
      title: string;
      cardSelector: string;
      cardId?: string;
      cardTypeKey: string;
      cardLabel: string;
      dimensionName: string;
      before: string | null;
        after: string;
        supports: AssertionSupportView[];
      }
    | {
        type: "SET_SLOT";
      title: string;
      cardSelector: string;
      cardId?: string;
      cardTypeKey: string;
      cardLabel: string;
      slotKey: string;
      slotLabel: string;
      before: ViewProposalCardTarget[];
      after: ViewProposalCardTarget[];
        supports: AssertionSupportView[];
      }
  >;
};
