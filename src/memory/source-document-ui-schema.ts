import { z } from "zod";

const sourceDocumentMetadataSchema = z.object({
  id: z.string(),
  title: z.string(),
  sha256: z.string(),
  parser: z.string(),
  pageCount: z.number().int(),
  blockCount: z.number().int(),
});

export const sourceDocumentReferenceBundleSchema = z.object({
  references: z.array(z.object({
    ref: z.string().regex(/^S\d+$/),
    label: z.string(),
    document: sourceDocumentMetadataSchema,
    selection: z.object({
      mode: z.enum(["outline", "around", "section", "range", "full"]),
      label: z.string(),
      startOrder: z.number().int().optional(),
      endOrder: z.number().int().optional(),
    }),
    startBlockId: z.string(),
    endBlockId: z.string(),
    blockCount: z.number().int().positive(),
    pages: z.array(z.number().int()),
  })),
});
