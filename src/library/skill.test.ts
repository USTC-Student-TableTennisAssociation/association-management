import { describe, expect, it } from "vitest";

import { AgentSkillSession } from "@/agent-runtime/skill-runtime";
import { libraryBuiltinPlugin } from "@/runtime/builtin-extensions";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import { ToolRuntime } from "@/runtime/tool-runtime/tool-runtime";

describe("Library Triage Skill", () => {
  it("registers as a generic Resource Skill and opens only Library proposals", () => {
    const registry = new ExtensionRegistry();
    registry.registerPlugin(libraryBuiltinPlugin);
    const session = new AgentSkillSession(registry, new ToolRuntime());

    const activation = session.activate("sydaris.library.triage", {});

    expect(activation.input).toEqual({ phase: "recommend" });
    expect(session.canOpenAction("library")).toBe(true);
    expect(session.canOpenAction("object")).toBe(false);
    expect(session.canReadView("activity_operations")).toBe(false);
    expect(session.instructions()).toContain("不得说成‘从内容看’");
    expect(session.instructions()).toContain("phase=recommend");
  });
});
