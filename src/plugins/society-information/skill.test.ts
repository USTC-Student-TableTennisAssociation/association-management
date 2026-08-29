import { describe, expect, it } from "vitest";

import { AgentSkillSession } from "@/agent-runtime/skill-runtime";
import { societyInformationPlugin } from "@/plugins/society-information/manifest";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import { ToolRuntime } from "@/runtime/tool-runtime/tool-runtime";

describe("Society Information Skill", () => {
  it("moves overview curation into a registered, bounded workflow", () => {
    const registry = new ExtensionRegistry();
    registry.registerPlugin(societyInformationPlugin);
    const session = new AgentSkillSession(registry, new ToolRuntime());
    const activation = session.activate(
      "echo.society-information.maintain-overview",
      { operation: "fill-topic", topic: "指导老师" },
    );

    expect(activation.input).toEqual({
      operation: "fill-topic",
      phase: "propose",
      topic: "指导老师",
    });
    expect(session.canRunCommand("society_information", "society.set_advisors")).toBe(true);
    expect(session.canRunCommand("activity_operations", "activity.create_activity")).toBe(false);
  });
});

