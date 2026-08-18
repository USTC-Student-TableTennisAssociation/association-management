import { z } from "zod";

export const viewInformationReferenceSchema = z.object({
  ref: z.string().regex(/^V\d+$/),
  label: z.string(),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("view"), viewKey: z.string() }),
    z.object({ kind: z.literal("card"), viewKey: z.string(), cardId: z.string().uuid() }),
  ]),
});

export const viewReferenceBundleSchema = z.object({
  references: z.array(viewInformationReferenceSchema),
});

export const viewCommandProposalNoticeSchema = z.object({
  proposalId: z.string().uuid(),
  viewKey: z.string(),
  commandKey: z.string(),
  commandVersion: z.string(),
  stateVersion: z.string(),
  input: z.unknown(),
});

export type ViewInformationReference = z.infer<typeof viewInformationReferenceSchema>;
export type ViewReferenceBundle = z.infer<typeof viewReferenceBundleSchema>;
export type ViewCommandProposalNotice = z.infer<typeof viewCommandProposalNoticeSchema>;
