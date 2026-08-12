import { z } from "zod";

const supportSchema = z.object({
  id: z.string(),
  statement: z.string(),
  sources: z.array(z.object({
    sourceTitle: z.string(),
    sourceNodeId: z.string(),
    sourceRegionLabel: z.string(),
    sourceBlockId: z.string(),
    pages: z.array(z.number()),
    excerpt: z.string(),
  })),
});

const proposalCardTargetSchema = z.object({
  cardSelector: z.string(),
  cardId: z.string().optional(),
  cardTypeKey: z.string(),
  objectId: z.string(),
  objectName: z.string(),
});

export const viewProposalPresentationSchema = z.object({
  id: z.string(),
  viewKey: z.literal("society_information"),
  status: z.enum(["pending", "approved", "rejected", "applied", "failed"]),
  reason: z.string(),
  createdAt: z.string(),
  failureReason: z.string().optional(),
  changes: z.array(z.discriminatedUnion("type", [
    z.object({
      type: z.literal("CREATE_CARD"),
      title: z.string(),
      cardSelector: z.string(),
      cardTypeKey: z.string(),
      objectId: z.string(),
      objectName: z.string(),
      cardTypeLabel: z.string(),
    }),
    z.object({
      type: z.literal("SET_CONTENT_DIMENSION"),
      title: z.string(),
      cardSelector: z.string(),
      cardId: z.string().optional(),
      cardTypeKey: z.string(),
      cardLabel: z.string(),
      dimensionName: z.string(),
      before: z.string().nullable(),
      after: z.string(),
      supports: z.array(supportSchema),
    }),
    z.object({
      type: z.literal("SET_SLOT"),
      title: z.string(),
      cardSelector: z.string(),
      cardId: z.string().optional(),
      cardTypeKey: z.string(),
      cardLabel: z.string(),
      slotKey: z.string(),
      slotLabel: z.string(),
      before: z.array(proposalCardTargetSchema),
      after: z.array(proposalCardTargetSchema),
      supports: z.array(supportSchema),
    }),
  ])),
});

const viewReferenceTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("view"),
    viewKey: z.literal("society_information"),
  }),
  z.object({
    kind: z.literal("card"),
    viewKey: z.literal("society_information"),
    cardId: z.string(),
  }),
  z.object({
    kind: z.literal("dimension"),
    viewKey: z.literal("society_information"),
    cardId: z.string(),
    dimensionName: z.string(),
  }),
  z.object({
    kind: z.literal("slot"),
    viewKey: z.literal("society_information"),
    cardId: z.string(),
    slotKey: z.string(),
  }),
]);

export const semanticViewReferenceBundleSchema = z.object({
  references: z.array(z.object({
    ref: z.string().regex(/^V\d+$/),
    label: z.string(),
    target: viewReferenceTargetSchema,
  })),
});
