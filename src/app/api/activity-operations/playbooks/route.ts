import { Prisma } from "@/generated/prisma/client";
import { after } from "next/server";
import { ZodError } from "zod";

import { currentAuthUser, unauthorizedResponse } from "@/auth/session";

import {
  executeActivityPlaybookAction,
  getActivityPlaybooks,
} from "@/semantic-view/activity-playbook-service";
import { activityPlaybookActionSchema } from "@/semantic-view/activity-playbook";
import { SemanticViewValidationError } from "@/semantic-view/service";
import { maintainViewHigherMemory } from "@/semantic-view/higher-memory";
import { ACTIVITY_OPERATIONS_VIEW } from "@/semantic-view/types";

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
    if (!await currentAuthUser()) return unauthorizedResponse();
    return Response.json(await getActivityPlaybooks());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    if (!await currentAuthUser()) return unauthorizedResponse();
    const action = activityPlaybookActionSchema.parse(await request.json());
    const result = await executeActivityPlaybookAction(action);
    after(async () => {
      try {
        await maintainViewHigherMemory(
          ACTIVITY_OPERATIONS_VIEW,
          `Activity Playbook 操作：${action.type}`,
        );
      } catch (error) {
        console.error("[activity-playbook.view-higher-memory]", error);
      }
    });
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
