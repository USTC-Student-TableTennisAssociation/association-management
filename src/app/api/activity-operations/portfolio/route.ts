import { Prisma } from "@/generated/prisma/client";
import { ZodError } from "zod";

import {
  executeActivityPortfolioAction,
  getActivityPortfolio,
} from "@/semantic-view/activity-operations-service";
import {
  activityPortfolioActionSchema,
} from "@/semantic-view/activity-portfolio";
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
    return Response.json(await getActivityPortfolio());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const action = activityPortfolioActionSchema.parse(await request.json());
    return Response.json(await executeActivityPortfolioAction(action));
  } catch (error) {
    return errorResponse(error);
  }
}
