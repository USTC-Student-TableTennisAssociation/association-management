import { describe, expect, it, vi } from "vitest";

vi.mock("@/shell/composition-root", () => ({
  extensionRegistry: { listViews: () => [] },
}));

import { buildCapabilityInstructions } from "@/ai/capability-instructions";

describe("capability instructions", () => {
  it("separates environment inventory from per-query retrieval counts", () => {
    const instructions = buildCapabilityInstructions({
      preferredKnowledgeLayer: "unknown",
      toolNames: ["inspectKnowledgeEnvironment", "searchMemory"],
    });

    expect(instructions).toContain("知识环境分层盘点");
    expect(instructions).toContain("inventory counts");
    expect(instructions).toContain("只是本次读取命中数");
    expect(instructions).toContain("不要把这些不同口径相加");
  });

  it("teaches proactive but evidence-bound Higher Memory maintenance", () => {
    const instructions = buildCapabilityInstructions({
      preferredKnowledgeLayer: "unknown",
      toolNames: ["queueHigherMemoryMaintenance"],
    });

    expect(instructions).toContain("Object、Ambient、View 与 Actor 四类 Higher Memory");
    expect(instructions).toContain("不要等用户说‘请记住’才维护");
    expect(instructions).toContain("某个 Ambient scope 缺失");
    expect(instructions).toContain("某位用户给 Sydaris 起的私人称呼");
    expect(instructions).toContain("不表示 Higher Memory 已经更新");
  });

  it("separates synchronous natural-language Actor memory from background synthesis", () => {
    const instructions = buildCapabilityInstructions({
      preferredKnowledgeLayer: "unknown",
      toolNames: ["updateActorHigherMemory", "queueActorHigherMemoryMaintenance"],
    });

    expect(instructions).toContain("不要只在文本中答应");
    expect(instructions).toContain("发起者、动作和接受者或对象");
    expect(instructions).toContain("不得把记忆改写成语义 key-value");
    expect(instructions).toContain("不传播到其人物 Object");
    expect(instructions).toContain("它不要求先发布共享 Assertion");
    expect(instructions).toContain("只登记后台综合意图");
    expect(instructions).toContain("不要再排队重复维护");
  });
});
