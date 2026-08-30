import { afterAll, describe, expect, it } from "vitest";

import { getDatabase } from "@/db";
import { maintainAmbientHigherMemories } from "@/memory/ambient-higher-memory";

const runLive = process.env.SYDARIS_LIVE_AMBIENT_TEST === "1";

describe.runIf(runLive)("ambient Higher Memory live time travel", () => {
  afterAll(async () => {
    await getDatabase().$disconnect();
  });

  it("turns a three-day-ahead activity into useful recent memory", async () => {
    const database = getDatabase();
    await database.memoryAmbientHigherMemory.deleteMany();

    const maintained = await maintainAmbientHigherMemories({
      clientMessageId: "ambient-live-time-travel-maintenance-001",
      submittedAt: "2026-08-12T00:00:00.000Z",
      timezone: "Asia/Shanghai",
      scopes: ["working_set"],
      reason: "用户明确同步了三天后最重要的共同活动及尚未完成的准备工作。",
      semanticContext: {
        conversation: [{
          messageId: "ambient-live-time-travel-maintenance-001",
          role: "user",
          text: "跟你同步一件最近最重要的事：三天后，也就是2026年8月15日上午10点，我们要办一场「Sydaris时旅验收会」。目前还没确认会议室，演示也没准备完，参与者还没全部通知。先记着，之后我们继续推进。",
          submittedAt: "2026-08-12T00:00:00.000Z",
        }],
        systemInstruction: "你是 Sydaris，本轮时间为 2026-08-12，组织时区为 Asia/Shanghai。",
        modelCalls: [],
        toolExecutions: [],
        finalAnswer: "明白，之后继续推进。",
      },
      retrieval: {
        query: "三天后重要活动",
        mode: "object-assertion",
        seedMap: { facets: [], objects: [], assertions: [], connections: [] },
      },
    });

    expect(maintained).toBe(1);
    const recent = await database.memoryAmbientHigherMemory.findUniqueOrThrow({
      where: { scope: "working_set" },
    });
    expect(recent.contentMarkdown).toMatch(/Sydaris\s*时旅验收会/);
    expect(recent.contentMarkdown.length).toBeGreaterThanOrEqual(80);

    await database.memoryAmbientHigherMemory.update({
      where: { scope: "working_set" },
      data: {
        maintainedAt: new Date("2026-08-12T00:00:00.000Z"),
        triggerMessageId: "ambient-live-time-travel-maintenance-001",
      },
    });
  }, 240_000);

  it("replaces resolved preparation risks with the latest progress", async () => {
    const database = getDatabase();
    const maintained = await maintainAmbientHigherMemories({
      clientMessageId: "ambient-live-time-travel-progress-001",
      submittedAt: "2026-08-15T00:05:00.000Z",
      timezone: "Asia/Shanghai",
      scopes: ["working_set"],
      reason: "用户更新了近期最重要活动的全部未结事项，旧 Recent Memory 需要刷新。",
      semanticContext: {
        conversation: [{
          messageId: "ambient-live-time-travel-progress-001",
          role: "user",
          text: "进展更新：会议室已经确认在东区201，演示也全部准备完了，参与者都通知到了。现在三项都已完成。",
          submittedAt: "2026-08-15T00:05:00.000Z",
        }],
        systemInstruction: "你是 Sydaris，本轮时间为 2026-08-15 08:05，组织时区为 Asia/Shanghai。",
        modelCalls: [],
        toolExecutions: [],
        finalAnswer: "收到，三项准备均已完成。",
      },
      retrieval: {
        query: "验收会准备进展",
        mode: "object-assertion",
        seedMap: { facets: [], objects: [], assertions: [], connections: [] },
      },
    });

    expect(maintained).toBe(1);
    const recent = await database.memoryAmbientHigherMemory.findUniqueOrThrow({
      where: { scope: "working_set" },
    });
    expect(recent.contentMarkdown).toMatch(/东区\s*201/);
    expect(recent.contentMarkdown).toMatch(/已.{0,8}(完成|通知|确认)/);
    expect(recent.contentMarkdown.length).toBeGreaterThanOrEqual(80);
  }, 240_000);
});
