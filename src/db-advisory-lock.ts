import { Prisma } from "@/generated/prisma/client";

/**
 * PostgreSQL advisory lock returns `void`. Selecting it directly makes Prisma
 * try to deserialize an unsupported column, so execute it in FROM and expose
 * only a supported integer result.
 */
export function transactionAdvisoryLockQuery(lockKey: string) {
  return Prisma.sql`
    SELECT 1 AS "locked"
    FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
  `;
}
