import { describe, expect, it } from "vitest";

import { AgentSkillSession } from "@/agent-runtime/skill-runtime";
import { activityOperationsPlugin } from "@/plugins/activity-operations/manifest";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import { ToolRuntime } from "@/runtime/tool-runtime/tool-runtime";

function fixture() {
  const registry = new ExtensionRegistry();
  registry.registerPlugin(activityOperationsPlugin);
  return new AgentSkillSession(registry, new ToolRuntime());
}

describe("Activity Operations Skills", () => {
  it("registers separate method-design and execution-map workflows", () => {
    const session = fixture();
    expect(session.list().map((skill) => skill.id)).toEqual([
      "sydaris.activity-operations.design-playbook",
      "sydaris.activity-operations.plan-task-map",
    ]);
  });

  it("keeps discussion-only playbook work inside method commands", () => {
    const session = fixture();
    const activation = session.activate(
      "sydaris.activity-operations.design-playbook",
      { operation: "design", phase: "discuss" },
    );

    expect(activation.input).toEqual({ operation: "design", phase: "discuss" });
    expect(session.instructions()).toContain("phase=discuss");
    expect(session.instructions()).toContain("不得打开 Actions");
    expect(session.canRunCommand("activity_operations", "activity.create_playbook")).toBe(true);
    expect(session.canRunCommand("activity_operations", "activity.apply_playbook")).toBe(false);
    expect(session.canRunCommand("activity_operations", "activity.create_activity")).toBe(false);
  });

  it("allows execution planning without granting Playbook editing", () => {
    const session = fixture();
    session.activate("sydaris.activity-operations.plan-task-map", {
      operation: "plan",
      phase: "propose",
    });

    expect(session.canRunCommand("activity_operations", "activity.apply_playbook")).toBe(true);
    expect(session.canRunCommand("activity_operations", "activity.add_task")).toBe(true);
    expect(session.canRunCommand("activity_operations", "activity.create_playbook")).toBe(false);
  });
});

