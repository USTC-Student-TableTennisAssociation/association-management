import { describe, expect, it } from "vitest";

import {
  createRuntimeSkillToolset,
  runtimeSkillCatalog,
} from "@/ai/runtime-skills";

const executionOptions = {
  toolCallId: "tool-call-1",
  messages: [],
  abortSignal: undefined,
  context: {},
};

describe("runtime skills", () => {
  it("advertises graph authoring only for graph-shaped Business View work", () => {
    expect(runtimeSkillCatalog()).toEqual([expect.objectContaining({
      key: "business-view-graph-authoring",
      description: expect.stringContaining("Card/Slot 子图"),
    })]);
    expect(runtimeSkillCatalog()[0].description).toContain("单字段修改不使用");
  });

  it("loads procedural guidance without copying a concrete Card/Slot schema", async () => {
    const skillToolset = createRuntimeSkillToolset();
    const result = await skillToolset.tools.loadSkill.execute!({
      skillKey: "business-view-graph-authoring",
      reason: "建立建议型流程地图",
    }, executionOptions);
    const instructions = skillToolset.instructions();

    expect(result).toMatchObject({ loaded: true, alreadyLoaded: false });
    expect(instructions).toContain("以本轮 readSemanticView/openBusinessContext 返回的实时 cardTypes 为准");
    expect(instructions).toContain("minimumTargetCount");
    expect(instructions).toContain("不得通过删除节点、删除路径");
    expect(instructions).not.toContain("ActivityPlaybookCard");
    expect(instructions).not.toContain("start_nodes");
  });

  it("keeps a loaded skill active and makes repeated loads idempotent", async () => {
    const skillToolset = createRuntimeSkillToolset();
    const input = {
      skillKey: "business-view-graph-authoring" as const,
      reason: "修复不完整子图",
    };
    await skillToolset.tools.loadSkill.execute!(input, executionOptions);
    const repeated = await skillToolset.tools.loadSkill.execute!(input, executionOptions);

    expect(repeated).toMatchObject({ loaded: true, alreadyLoaded: true });
    expect(skillToolset.loadedSkillKeys()).toEqual(["business-view-graph-authoring"]);
    expect(skillToolset.instructions().match(/【Skill：Business View 子图构建】/g))
      .toHaveLength(1);
  });
});
