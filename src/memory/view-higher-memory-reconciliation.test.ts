import { beforeEach, describe, expect, it, vi } from "vitest";

const aiState = vi.hoisted(() => ({ generateText: vi.fn() }));
const databaseState = vi.hoisted(() => ({ database: undefined as unknown }));

vi.mock("ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("ai")>();
  return { ...original, generateText: aiState.generateText };
});
vi.mock("@/ai/provider", () => ({ getChatModel: () => ({}) }));
vi.mock("@/db", () => ({ getDatabase: () => databaseState.database }));

import { reconcileViewHigherMemoryFromViewChange } from "@/memory/view-higher-memory-reconciliation";
import { activityOperationsViewModule } from "@/plugins/activity-operations/view/schema";

const changedCardId = "00000000-0000-4000-8000-000000000001";
const otherCardId = "00000000-0000-4000-8000-000000000002";
const executionId = "00000000-0000-4000-8000-000000000003";
const maintainedAt = new Date("2026-08-20T00:00:00.000Z");

function input() {
  return {
    viewModule: activityOperationsViewModule,
    snapshot: {
      viewKey: "activity_operations",
      pluginVersion: "1.10.0",
      schemaVersion: activityOperationsViewModule.manifest.schemaVersion,
      stateVersion: "3",
      observedAt: "2026-08-30T00:00:00.000Z",
      cards: [{
        id: changedCardId,
        viewKey: "activity_operations",
        cardTypeKey: "ActivityCard",
        dimensions: { name: "本地业务活动", status: "ACTIVE" },
        slots: {},
        relatedObjectIds: [],
      }, {
        id: otherCardId,
        viewKey: "activity_operations",
        cardTypeKey: "TaskCard",
        dimensions: { name: "场地与审批", status: "NOT_STARTED" },
        slots: {},
        relatedObjectIds: [],
      }],
    },
    executions: [{
      id: executionId,
      commandKey: "activity.update_activity",
      input: { activityId: changedCardId, status: "ACTIVE" },
      result: { cardId: changedCardId },
      stateVersionBefore: "2",
      stateVersionAfter: "3",
      changes: [{
        kind: "dimension" as const,
        cardId: changedCardId,
        cardTypeKey: "ActivityCard",
        dimensionKey: "status",
        before: { present: true as const, value: "PLANNING" },
        after: { present: true as const, value: "ACTIVE" },
      }],
    }],
    events: [{
      type: "activity.activity_updated",
      version: "1",
      payload: { cardId: changedCardId, changedDimensions: ["status"] },
      stateVersion: "3",
    }],
    objects: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const upsert = vi.fn().mockResolvedValue({ id: "view-memory" });
  const transaction = {
    installedView: {
      findUnique: vi.fn().mockResolvedValue({ stateVersion: BigInt(3) }),
    },
    viewHigherMemory: { upsert },
  };
  databaseState.database = {
    viewHigherMemory: {
      findUnique: vi.fn().mockResolvedValue({
        contentMarkdown: "## 旧摘要\n\n此前活动仍处于筹备阶段，场地与审批是需要持续推进的工作方向。",
        maintainedAt,
      }),
    },
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<void>) =>
      callback(transaction)
    ),
    __transaction: transaction,
  };
  aiState.generateText.mockResolvedValue({
    toolCalls: [{
      toolName: "submitViewHigherMemory",
      input: {
        memory: {
          contentMarkdown: "## 当前阶段\n\n该活动运营视图目前已从筹备转入执行阶段；场地与审批仍是需要持续推进的工作方向，后续协作应继续以视图实时读取结果为准。这个摘要只保留阶段、模式和未结方向，不替代具体卡片状态。",
        },
      },
    }],
  });
});

describe("View Higher Memory reconciliation after a View change", () => {
  it("writes a View-scoped summary for View-local Cards without Object anchors", async () => {
    await expect(reconcileViewHigherMemoryFromViewChange(input())).resolves.toBe(1);

    const call = aiState.generateText.mock.calls[0][0];
    expect(call.tools).toHaveProperty("submitViewHigherMemory");
    expect(call.toolChoice).toEqual({ type: "tool", toolName: "submitViewHigherMemory" });
    expect(call.prompt).toContain("本地业务活动");
    expect(call.prompt).toContain("场地与审批");
    expect(call.prompt).toContain("此前活动仍处于筹备阶段");
    expect(call.prompt).toContain("不要求存在 Object anchor");
    expect(call.prompt).not.toContain(changedCardId);
    expect(call.prompt).not.toContain(otherCardId);

    const transaction = (databaseState.database as {
      __transaction: { viewHigherMemory: { upsert: ReturnType<typeof vi.fn> } };
    }).__transaction;
    expect(transaction.viewHigherMemory.upsert).toHaveBeenCalledWith({
      where: { viewKey: "activity_operations" },
      create: expect.objectContaining({
        viewKey: "activity_operations",
        contentMarkdown: expect.stringContaining("从筹备转入执行阶段"),
        maintenanceReason: expect.stringContaining("更新活动概况与阶段"),
      }),
      update: expect.objectContaining({
        contentMarkdown: expect.stringContaining("不替代具体卡片状态"),
      }),
    });
  });

  it("keeps the previous View memory when there is no useful replacement", async () => {
    aiState.generateText.mockResolvedValue({
      toolCalls: [{
        toolName: "submitViewHigherMemory",
        input: { memory: null },
      }],
    });

    await expect(reconcileViewHigherMemoryFromViewChange(input())).resolves.toBe(0);

    const database = databaseState.database as { $transaction: ReturnType<typeof vi.fn> };
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it("does not overwrite memory generated for a newer View state", async () => {
    const database = databaseState.database as {
      __transaction: {
        installedView: { findUnique: ReturnType<typeof vi.fn> };
        viewHigherMemory: { upsert: ReturnType<typeof vi.fn> };
      };
    };
    database.__transaction.installedView.findUnique.mockResolvedValue({
      stateVersion: BigInt(4),
    });

    await expect(reconcileViewHigherMemoryFromViewChange(input()))
      .rejects.toThrow("在 Higher Memory 生成期间已改变");
    expect(database.__transaction.viewHigherMemory.upsert).not.toHaveBeenCalled();
  });
});
