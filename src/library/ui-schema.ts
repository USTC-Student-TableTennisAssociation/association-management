import { z } from "zod";

import { libraryPlanOperationSchema } from "@/library/types";

export const libraryPlanPresentationSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["pending", "rejected", "applied", "failed"]),
  reason: z.string(),
  createdAt: z.string(),
  failureReason: z.string().optional(),
  operations: z.array(z.intersection(
    libraryPlanOperationSchema,
    z.object({ description: z.string() }),
  )),
});
