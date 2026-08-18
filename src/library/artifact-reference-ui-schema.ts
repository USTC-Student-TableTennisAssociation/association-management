import { z } from "zod";

const artifactReferenceTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("search"),
    queryTitle: z.string(),
    matchedCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  z.object({
    kind: z.literal("artifact"),
    nodeId: z.string(),
    name: z.string(),
    path: z.string().nullable(),
    profile: z.string(),
    status: z.string(),
    sharedBrainStatus: z.enum(["published", "not_published"]),
    publishedAssertionCount: z.number().int().nonnegative(),
    publishedObjectCount: z.number().int().nonnegative(),
  }),
]);

export const artifactReferenceBundleSchema = z.object({
  references: z.array(z.object({
    ref: z.string().regex(/^F\d+$/),
    label: z.string(),
    target: artifactReferenceTargetSchema,
  })),
});
