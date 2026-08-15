import { beforeEach, describe, expect, it, vi } from "vitest";

const maintenanceState = vi.hoisted(() => ({
  object: vi.fn(),
  ambient: vi.fn(),
}));

vi.mock("@/memory/object-higher-memory", () => ({
  maintainObjectHigherMemories: maintenanceState.object,
}));
vi.mock("@/memory/ambient-higher-memory", () => ({
  maintainAmbientHigherMemories: maintenanceState.ambient,
}));

import { maintainHigherMemories } from "@/memory/higher-memory-maintenance";

beforeEach(() => {
  vi.clearAllMocks();
  maintenanceState.object.mockResolvedValue(1);
  maintenanceState.ambient.mockResolvedValue(2);
});

describe("maintainHigherMemories", () => {
  it("dispatches one chat-triggered decision to Object and ambient maintainers", async () => {
    const input = {
      clientMessageId: "message-1",
      submittedAt: "2026-08-15T00:00:00.000Z",
      timezone: "Asia/Shanghai",
      semanticContext: {
        conversation: [],
        systemInstruction: "main system",
        modelCalls: [],
        toolExecutions: [],
        finalAnswer: "answer",
      },
      retrieval: {
        query: "test",
        mode: "fixture" as const,
        seedMap: { facets: [], objects: [], assertions: [], connections: [] },
      },
      queueDecision: {
        targets: [
          { scope: "workspace" as const },
          { scope: "recent" as const },
          {
            scope: "object" as const,
            globalObjectId: "00000000-0000-4000-8000-000000000001",
          },
        ],
        reason: "本轮形成了多个 scope 的高层理解",
      },
    };

    await expect(maintainHigherMemories(input)).resolves.toEqual({
      objectMemories: 1,
      ambientMemories: 2,
    });
    expect(maintenanceState.object).toHaveBeenCalledWith(
      expect.objectContaining({
        queueDecision: {
          objectIds: ["00000000-0000-4000-8000-000000000001"],
          reason: "本轮形成了多个 scope 的高层理解",
        },
      }),
      undefined,
    );
    expect(maintenanceState.ambient).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: ["workspace", "recent"],
        reason: "本轮形成了多个 scope 的高层理解",
      }),
      undefined,
    );
  });

  it("does not start an unrelated maintainer when the decision has one scope kind", async () => {
    await maintainHigherMemories({
      clientMessageId: "message-2",
      submittedAt: "2026-08-15T00:00:00.000Z",
      timezone: "Asia/Shanghai",
      semanticContext: {
        conversation: [],
        systemInstruction: "main system",
        modelCalls: [],
        toolExecutions: [],
        finalAnswer: "answer",
      },
      retrieval: {
        query: "test",
        mode: "fixture",
        seedMap: { facets: [], objects: [], assertions: [], connections: [] },
      },
      queueDecision: {
        targets: [{ scope: "recent" }],
        reason: "近期焦点发生变化",
      },
    });

    expect(maintenanceState.object).not.toHaveBeenCalled();
    expect(maintenanceState.ambient).toHaveBeenCalledOnce();
  });
});
