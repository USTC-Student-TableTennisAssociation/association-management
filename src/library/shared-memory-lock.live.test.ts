import "dotenv/config";

import { afterAll, describe, expect, it } from "vitest";

import { getDatabase } from "@/db";
import { acquireSharedMemoryPublicationLock } from "@/library/shared-memory-publisher";

describe.skipIf(process.env.RUN_LIVE_SHARED_MEMORY_LOCK !== "1")(
  "Shared Brain publication advisory lock",
  () => {
    const database = getDatabase();

    afterAll(async () => {
      await database.$disconnect();
    });

    it("returns a Prisma-supported scalar instead of PostgreSQL void", async () => {
      const result = await database.$transaction(async (transaction) => {
        await acquireSharedMemoryPublicationLock(transaction);
        return "locked";
      });
      expect(result).toBe("locked");
    });
  },
);
