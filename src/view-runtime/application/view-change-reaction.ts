import type { ViewReaction, ViewReactionTarget } from "@sydaris/plugin-sdk";
import type { Prisma, ViewChangeReaction } from "@/generated/prisma/client";

function targets(value: Prisma.JsonValue): ViewReactionTarget[] {
  return Array.isArray(value) ? value as ViewReactionTarget[] : [];
}

export function presentViewChangeReaction(row: ViewChangeReaction): ViewReaction {
  return {
    id: row.id,
    executionId: row.executionId,
    viewKey: row.viewKey,
    stateVersion: row.stateVersion.toString(),
    targets: targets(row.targetsJson),
    attention: {
      policy: row.attentionPolicy as ViewReaction["attention"]["policy"],
      status: row.attentionStatus,
      ...(row.message ? { message: row.message } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
      ...(row.attentionCompletedAt
        ? { completedAt: row.attentionCompletedAt.toISOString() }
        : {}),
    },
    knowledge: {
      policy: row.knowledgePolicy as ViewReaction["knowledge"]["policy"],
      status: row.knowledgeStatus,
      ...(row.knowledgeCompletedAt
        ? { completedAt: row.knowledgeCompletedAt.toISOString() }
        : {}),
    },
    ...(row.seenAt ? { seenAt: row.seenAt.toISOString() } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function configuredViewReactionSettleMs(
  environment: Record<string, string | undefined> = process.env,
): number {
  const raw = environment.VIEW_CHANGE_SETTLE_MS?.trim();
  if (!raw) return 20_000;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 300_000) {
    throw new Error("VIEW_CHANGE_SETTLE_MS 必须是 0 到 300000 之间的整数");
  }
  return value;
}
