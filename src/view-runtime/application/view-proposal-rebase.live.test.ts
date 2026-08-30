import "dotenv/config";

import { afterAll, describe, expect, it } from "vitest";

import { getDatabase } from "@/db";
import { viewCommandBus, viewReadPort } from "@/shell/composition-root";

const runLive = process.env.SYDARIS_LIVE_VIEW_PROPOSAL_REBASE_TEST === "1";
const viewKey = "activity_operations";
const activityNames = [
  "Sydaris Proposal Rebase 验收活动 A",
  "Sydaris Proposal Rebase 验收活动 B",
] as const;

function resultCardId(summary: unknown): string | undefined {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return undefined;
  const cardId = (summary as Record<string, unknown>).cardId;
  return typeof cardId === "string" ? cardId : undefined;
}

describe.runIf(runLive)("View Proposal approval rebase", () => {
  afterAll(async () => {
    await getDatabase().$disconnect();
  });

  it("applies two independently approved Proposals created from the same View state", async () => {
    const database = getDatabase();
    const actor = { permissions: ["view.read", "view.write", "view.approve"] };
    const initial = await viewReadPort.query({ viewKey, actor });
    const baselineStateVersion = BigInt(initial.stateVersion);
    const proposalIds: string[] = [];
    const executionIds: string[] = [];
    const cardIds: string[] = [];
    let finalStateVersion = baselineStateVersion;

    try {
      for (const name of activityNames) {
        const proposal = await viewCommandBus.dispatch({
          viewKey,
          commandKey: "activity.create_activity",
          commandVersion: "1",
          input: { name, status: "PLANNING" },
          actor,
          initiator: "ai",
          expectedStateVersion: baselineStateVersion.toString(),
        });
        expect(proposal.kind).toBe("proposed");
        if (proposal.kind !== "proposed") throw new Error("AI Command 没有创建 Proposal");
        proposalIds.push(proposal.proposalId);
        expect(proposal.stateVersion).toBe(baselineStateVersion.toString());
      }

      for (const proposalId of proposalIds) {
        const approved = await viewCommandBus.decideProposal({
          proposalId,
          decision: "approve",
          actor,
        });
        expect(approved.kind).toBe("executed");
        if (approved.kind !== "executed") throw new Error("Proposal 没有执行");
        executionIds.push(approved.executionId);
        finalStateVersion = BigInt(approved.stateVersion);
        const cardId = resultCardId(approved.summary);
        if (!cardId) throw new Error("Command 没有返回 Card ID");
        cardIds.push(cardId);
      }

      expect(finalStateVersion).toBe(baselineStateVersion + BigInt(2));
      await expect(database.viewCommandProposal.findMany({
        where: { id: { in: proposalIds } },
        orderBy: { createdAt: "asc" },
        select: { status: true, expectedStateVersion: true },
      })).resolves.toEqual([
        { status: "applied", expectedStateVersion: baselineStateVersion },
        { status: "applied", expectedStateVersion: baselineStateVersion },
      ]);
      await expect(database.viewCard.count({
        where: { id: { in: cardIds } },
      })).resolves.toBe(2);
    } finally {
      await database.$transaction(async (transaction) => {
        if (finalStateVersion !== baselineStateVersion) {
          await transaction.installedView.updateMany({
            where: { viewKey, stateVersion: finalStateVersion },
            data: { stateVersion: baselineStateVersion },
          });
        }
        if (cardIds.length) {
          await transaction.viewCard.deleteMany({ where: { id: { in: cardIds } } });
        }
        if (proposalIds.length) {
          await transaction.viewCommandProposal.deleteMany({ where: { id: { in: proposalIds } } });
        }
        if (executionIds.length) {
          await transaction.viewCommandExecution.deleteMany({ where: { id: { in: executionIds } } });
        }
      });
    }
  });
});
