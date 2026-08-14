import { Prisma } from "@/generated/prisma/client";
import { ZodError } from "zod";

import {
  executeActivityPlaybookAction,
  getActivityPlaybooks,
} from "@/semantic-view/activity-playbook-service";
import { activityPlaybookActionSchema } from "@/semantic-view/activity-playbook";
import { SemanticViewValidationError } from "@/semantic-view/service";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  if (error instanceof ZodError || error instanceof SemanticViewValidationError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    ["P2011", "P2022"].includes(error.code)
  ) {
    return Response.json({ error: "Activity Operations 数据库结构尚未更新。" }, { status: 503 });
  }
  console.error("[activity-operations.playbooks]", error);
  return Response.json({ error: "无法更新操作手册。" }, { status: 500 });
}

export async function GET() {
  try {
    return Response.json(await getActivityPlaybooks());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const action = activityPlaybookActionSchema.parse(await request.json());
    return Response.json(await executeActivityPlaybookAction(action));
  } catch (error) {
    return errorResponse(error);
  }
}
