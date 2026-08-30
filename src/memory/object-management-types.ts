import { z } from "zod";

export const objectSurfaceIdSchema = z.string().trim().regex(
  /^(?:document:[0-9a-f-]{36}:\d+|chat:[0-9a-f-]{36}:\d+)$/i,
  "Surface id 必须来自 inspectObjectIdentity",
);

export const objectReferenceIdSchema = z.string().trim().regex(
  /^(?:assertion|coverage):[0-9a-f-]{36}$/i,
  "Reference id 必须来自 inspectObjectIdentity",
);

export const removeObjectSurfaceChangeSchema = z.object({
  type: z.literal("REMOVE_SURFACE"),
  objectId: z.string().uuid(),
  surfaceId: objectSurfaceIdSchema,
});

export const setObjectCanonicalNameChangeSchema = z.object({
  type: z.literal("SET_CANONICAL_NAME"),
  objectId: z.string().uuid(),
  canonicalName: z.string().trim().min(2).max(200),
});

export const mergeObjectsChangeSchema = z.object({
  type: z.literal("MERGE_OBJECTS"),
  survivorObjectId: z.string().uuid(),
  mergedObjectIds: z.array(z.string().uuid()).min(1).max(20),
});

export const splitObjectChangeSchema = z.object({
  type: z.literal("SPLIT_OBJECT"),
  sourceObjectId: z.string().uuid(),
  sourceCanonicalName: z.string().trim().min(2).max(200),
  newCanonicalName: z.string().trim().min(2).max(200),
  moveSurfaceIds: z.array(objectSurfaceIdSchema).min(1).max(100),
  moveReferenceIds: z.array(objectReferenceIdSchema).max(200).default([]),
});

export const objectChangeSchema = z.discriminatedUnion("type", [
  removeObjectSurfaceChangeSchema,
  setObjectCanonicalNameChangeSchema,
  mergeObjectsChangeSchema,
  splitObjectChangeSchema,
]);

export const objectChangePayloadSchema = z.object({
  reason: z.string().trim().min(1).max(1_000),
  changes: z.array(objectChangeSchema).min(1).max(20),
});

export type ObjectChangePayload = z.infer<typeof objectChangePayloadSchema>;
export type ObjectChange = z.infer<typeof objectChangeSchema>;

export type ObjectIdentitySurface = {
  id: string;
  kind: "document" | "chat";
  surfaceForm: string;
  source: string;
  excerpt?: string;
};

export type ObjectIdentityReference = {
  id: string;
  kind: "assertion" | "coverage";
  assertionId: string;
  statement: string;
};

export type ObjectIdentityInspection = {
  object: {
    id: string;
    canonicalName: string;
  };
  surfaces: ObjectIdentitySurface[];
  references: ObjectIdentityReference[];
  dependencies: {
    higherMemory: boolean;
    relatedViewCards: Array<{
      id: string;
      viewKey: string;
      cardTypeKey: string;
    }>;
  };
};

export const objectChangeProposalPresentationSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["pending", "rejected", "applied", "failed"]),
  reason: z.string(),
  createdAt: z.string(),
  failureReason: z.string().optional(),
  invalidatesHigherMemory: z.boolean(),
  changes: z.array(z.object({
    type: z.enum([
      "REMOVE_SURFACE",
      "SET_CANONICAL_NAME",
      "MERGE_OBJECTS",
      "SPLIT_OBJECT",
    ]),
    title: z.string(),
    details: z.array(z.string()),
  })),
});

export type ObjectChangeProposalPresentation = z.infer<
  typeof objectChangeProposalPresentationSchema
>;
