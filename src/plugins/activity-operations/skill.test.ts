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
    expect(session.list()[0].description).toContain("优先使用");
    expect(session.list()[1].description).toContain("方法已经选定");
  });

  it("enforces discussion-only playbook work as read-only", () => {
    const session = fixture();
    const activation = session.activate(
      "sydaris.activity-operations.design-playbook",
      { operation: "design", phase: "discuss" },
    );

    expect(activation.input).toEqual({ operation: "design", phase: "discuss" });
    expect(session.instructions()).toContain("phase=discuss");
    expect(session.instructions()).toContain("Runtime 禁止副作用");
    expect(session.canRunCommand("activity_operations", "activity.create_playbook_graph")).toBe(false);
    expect(session.canOpenAction("business_view", "activity_operations")).toBe(false);
    expect(session.canRunCommand("activity_operations", "activity.apply_playbook")).toBe(false);
    expect(session.canRunCommand("activity_operations", "activity.create_activity")).toBe(false);
  });

  it("allows an atomic method graph proposal in propose mode", () => {
    const session = fixture();
    session.activate("sydaris.activity-operations.design-playbook", {
      operation: "design",
      phase: "propose",
    });

    expect(session.canOpenAction("business_view", "activity_operations")).toBe(true);
    expect(session.canRunCommand("activity_operations", "activity.create_playbook_graph")).toBe(true);
    expect(session.canRunCommand(
      "activity_operations",
      "activity.create_playbook_from_blueprint",
    )).toBe(true);
    expect(session.canRunCommand("activity_operations", "activity.create_playbook")).toBe(false);
  });

  it("allows execution planning without granting Playbook editing", () => {
    const session = fixture();
    session.activate("sydaris.activity-operations.plan-task-map", {
      operation: "plan",
      phase: "propose",
      workflowBasis: "confirmed_playbook",
    });

    expect(session.canRunCommand("activity_operations", "activity.apply_playbook")).toBe(true);
    expect(session.canRunCommand("activity_operations", "activity.add_task")).toBe(true);
    expect(session.canRunCommand("activity_operations", "activity.create_playbook")).toBe(false);
  });

  it("requires an explicit workflow basis before entering execution planning", () => {
    const session = fixture();
    expect(() => session.activate("sydaris.activity-operations.plan-task-map", {
      operation: "plan",
      phase: "discuss",
    })).toThrow();
  });
});
