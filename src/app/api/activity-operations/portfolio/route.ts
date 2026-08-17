import { Prisma } from "@/generated/prisma/client";
import { after } from "next/server";
import { ZodError } from "zod";

import { currentAuthUser, unauthorizedResponse } from "@/auth/session";

import {
  executeActivityPortfolioAction,
  getActivityPortfolio,
} from "@/semantic-view/activity-operations-service";
import {
  activityPortfolioActionSchema,
} from "@/semantic-view/activity-portfolio";
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
    console.error("[activity-operations.portfolio.schema]", error);
    return Response.json({
      error: "Activity Operations 数据库结构尚未更新，请先应用最新 Prisma 迁移。",
    }, { status: 503 });
  }
  console.error("[activity-operations.portfolio]", error);
  return Response.json({ error: "无法更新活动运营状态。" }, { status: 500 });
}

export async function GET() {
  try {
    if (!await currentAuthUser()) return unauthorizedResponse();
    return Response.json(await getActivityPortfolio());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    if (!await currentAuthUser()) return unauthorizedResponse();
    const action = activityPortfolioActionSchema.parse(await request.json());
    const result = await executeActivityPortfolioAction(action);
    after(async () => {
      try {
        await maintainViewHigherMemory(
          ACTIVITY_OPERATIONS_VIEW,
          `Activity Portfolio 操作：${action.type}`,
        );
      } catch (error) {
        console.error("[activity-operations.view-higher-memory]", error);
      }
    });
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
