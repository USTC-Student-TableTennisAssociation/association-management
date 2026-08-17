import { z } from "zod";
import { after } from "next/server";

import { currentAuthUser, unauthorizedResponse } from "@/auth/session";

import {
  decideViewProposal,
  SemanticViewValidationError,
} from "@/semantic-view/service";
import { maintainViewHigherMemory } from "@/semantic-view/higher-memory";

const decisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ proposalId: string }> },
) {
  try {
    if (!await currentAuthUser()) return unauthorizedResponse();
    const { proposalId } = await context.params;
    const decision = decisionSchema.parse(await request.json());
    const result = await decideViewProposal(proposalId, decision.decision);
    if (result.proposal.status === "applied") {
      after(async () => {
        try {
          await maintainViewHigherMemory(
            result.proposal.viewKey,
            `Business View Proposal ${result.proposal.id} 已应用`,
          );
        } catch (error) {
          console.error("[semantic-view.higher-memory.maintain]", error);
        }
      });
    }
    return Response.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "确认请求格式错误。" }, { status: 400 });
    }
    if (error instanceof SemanticViewValidationError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    console.error("[semantic-view.proposal-decision]", error);
    return Response.json(
      { error: "Proposal 未能安全应用，正式 Business View 没有发生部分修改。" },
      { status: 500 },
    );
  }
}
