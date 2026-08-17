import { z } from "zod";

import { currentAuthUser, unauthorizedResponse } from "@/auth/session";

import {
  decideObjectChangeProposal,
  ObjectManagementValidationError,
} from "@/memory/object-management-service";

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
    return Response.json(
      await decideObjectChangeProposal(proposalId, decision.decision),
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "确认请求格式错误。" }, { status: 400 });
    }
    if (error instanceof ObjectManagementValidationError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    console.error("[object-management.proposal-decision]", error);
    return Response.json(
      { error: "Object Change Proposal 未能安全应用，Object 图没有发生部分修改。" },
      { status: 500 },
    );
  }
}
