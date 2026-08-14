import { describe, expect, it } from "vitest";

import { transactionAdvisoryLockQuery } from "@/db-advisory-lock";

describe("transactionAdvisoryLockQuery", () => {
  it("does not expose PostgreSQL's void advisory-lock result to Prisma", () => {
    const query = transactionAdvisoryLockQuery("object-management:test");

    expect(query.sql).toContain('SELECT 1 AS "locked"');
    expect(query.sql).toContain("FROM pg_advisory_xact_lock");
    expect(query.sql).not.toContain("SELECT pg_advisory_xact_lock");
    expect(query.values).toEqual(["object-management:test"]);
  });
});
