import { z } from "zod";

import {
  decideViewProposal,
  SemanticViewValidationError,
} from "@/semantic-view/service";

const decisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ proposalId: string }> },
) {
  try {
    const { proposalId } = await context.params;
    const decision = decisionSchema.parse(await request.json());
    return Response.json(
      await decideViewProposal(proposalId, decision.decision),
    );
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
