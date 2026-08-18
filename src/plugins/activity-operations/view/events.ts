import { z } from "zod";

import type { DomainEventDefinition } from "@/contracts";
import { zodContractSchema } from "@/contracts";

const cardEventSchema = z.object({ cardId: z.string().uuid() });

export const activityOperationsEvents: readonly DomainEventDefinition[] = [
  {
    key: "activity.activity_created",
    version: "1",
    payloadSchema: zodContractSchema(cardEventSchema),
  },
  {
    key: "activity.work_package_added",
    version: "1",
    payloadSchema: zodContractSchema(cardEventSchema.extend({ activityId: z.string().uuid() })),
  },
  {
    key: "activity.task_added",
    version: "1",
    payloadSchema: zodContractSchema(cardEventSchema.extend({ workPackageId: z.string().uuid() })),
  },
  {
    key: "activity.owner_assigned",
    version: "1",
    payloadSchema: zodContractSchema(cardEventSchema.extend({
      targetCardId: z.string().uuid(),
      objectId: z.string().uuid(),
    })),
  },
  {
    key: "activity.activity_updated",
    version: "1",
    payloadSchema: zodContractSchema(cardEventSchema),
  },
];
