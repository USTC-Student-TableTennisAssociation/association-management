import { describe, expect, it, vi } from "vitest";

import type { CommandDefinition, ViewTransaction } from "@/contracts";
import { activityOperationsCommands } from "@/plugins/activity-operations/view/commands";

const objectId = "00000000-0000-4000-8000-000000000101";

function createActivityCommand(): CommandDefinition<Record<string, unknown>> {
  const command = activityOperationsCommands.find(
    (candidate) => candidate.key === "activity.create_activity",
  );
  if (!command) throw new Error("activity.create_activity command is missing");
  return command as CommandDefinition<Record<string, unknown>>;
}

function transactionFixture() {
  return {
    createCard: vi.fn().mockResolvedValue("00000000-0000-4000-8000-000000000201"),
  } as unknown as ViewTransaction;
}

async function executeCreateActivity(
  transaction: ViewTransaction,
  input: Record<string, unknown>,
) {
  const command = createActivityCommand();
  const parsed = command.inputSchema.parse(input);
  return command.execute({
    viewKey: "activity_operations",
    actor: { permissions: ["view.write"] },
    initiator: "human",
    transaction,
  }, parsed);
}

describe("activity.create_activity", () => {
  it("links a new ActivityCard to the supplied stable Object", async () => {
    const transaction = transactionFixture();

    await executeCreateActivity(transaction, {
      objectId,
      name: "Echo 验收赛",
      status: "PLANNING",
    });

    expect(transaction.createCard).toHaveBeenCalledWith(expect.objectContaining({
      cardTypeKey: "ActivityCard",
      relatedObjectIds: [objectId],
      dimensions: expect.objectContaining({ name: "Echo 验收赛", status: "PLANNING" }),
    }));
  });

  it("keeps legacy activity creation without an Object compatible", async () => {
    const transaction = transactionFixture();

    await executeCreateActivity(transaction, { name: "人工录入活动" });

    expect(transaction.createCard).toHaveBeenCalledWith(expect.objectContaining({
      cardTypeKey: "ActivityCard",
      relatedObjectIds: [],
    }));
  });

  it("rejects a malformed Object ID before executing the command", () => {
    const command = createActivityCommand();

    expect(() => command.inputSchema.parse({
      objectId: "not-a-uuid",
      name: "Echo 验收赛",
    })).toThrow();
  });
});
