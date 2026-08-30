import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  AgentSkillSession,
  createAgentSkillToolset,
  SkillRuntimeError,
} from "@/agent-runtime/skill-runtime";
import { zodContractSchema, type PluginManifest } from "@/contracts";
import { activityOperationsPlugin } from "@/plugins/activity-operations/manifest";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import { ToolRuntime } from "@/runtime/tool-runtime/tool-runtime";

const skillId = "sydaris.test.activity-curator";

const skillPlugin: PluginManifest = {
  id: "sydaris.test-skills",
  version: "1.0.0",
  requires: [{ pluginId: "sydaris.activity-operations", versions: "^1.0.0" }],
  contributes: {
    skills: [{
      id: skillId,
      version: "1.0.0",
      label: "活动整理",
      description: "整理已有活动资料。",
      inputSchema: zodContractSchema(z.object({ focus: z.string().min(1) })),
      instructions: "核对资料后，只调用 activity.update_activity。",
      viewAccess: [{
        viewKey: "activity_operations",
        schemaVersion: activityOperationsPlugin.contributes.views?.[0]?.manifest.schemaVersion ?? "1",
        mode: "write",
        commands: ["activity.update_activity"],
      }],
      requiresCapabilities: [],
    }],
  },
};

function fixture() {
  const registry = new ExtensionRegistry();
  registry.registerPlugin(activityOperationsPlugin);
  registry.registerPlugin(skillPlugin);
  const session = new AgentSkillSession(registry, new ToolRuntime());
  return {
    session,
    toolset: createAgentSkillToolset({ session }),
  };
}

describe("Agent Skill Runtime", () => {
  it("activates a workflow with parsed semantic input", async () => {
    const { session, toolset } = fixture();
    const execute = toolset.tools.activateSkill.execute as unknown as (
      input: { skillId: string; input: unknown },
    ) => Promise<unknown>;

    const result = await execute({
      skillId,
      input: { focus: "秋季活动" },
    });
    expect(result).toMatchObject({
      activated: true,
      input: { focus: "秋季活动" },
      skill: { id: skillId },
    });
    expect(result).not.toHaveProperty("knowledge");

    expect(session.active()?.input).toEqual({ focus: "秋季活动" });
    expect(session.instructions()).toContain("activity.update_activity");
    expect(session.instructions()).toContain("只调用 activity.update_activity");
    expect(session.instructions()).not.toContain("知识层：");
  });

  it("enforces the declared View and Command boundary", () => {
    const { session } = fixture();
    session.activate(skillId, { focus: "秋季活动" });

    expect(session.canReadView("activity_operations")).toBe(true);
    expect(session.canReadView("society_information")).toBe(false);
    expect(session.canRunCommand(
      "activity_operations",
      "activity.update_activity",
    )).toBe(true);
    expect(session.canRunCommand(
      "activity_operations",
      "activity.create_activity",
    )).toBe(false);
    expect(session.canOpenAction("business_view", "activity_operations")).toBe(true);
    expect(session.canOpenAction("business_view", "society_information")).toBe(false);
    expect(session.canOpenAction("object")).toBe(false);
    expect(session.canOpenAction("library")).toBe(false);
  });

  it("allows idempotent activation but rejects switching workflows mid-turn", () => {
    const { session } = fixture();
    const first = session.activate(skillId, { focus: "秋季活动" });
    expect(session.activate(skillId, { focus: "秋季活动" })).toBe(first);

    expect(() => session.activate(skillId, { focus: "春季活动" }))
      .toThrow(SkillRuntimeError);
  });

  it("treats Capability requirements as activation-time availability checks", () => {
    const requiredSkillId = "sydaris.test.requires-calendar";
    const registry = new ExtensionRegistry();
    registry.registerPlugin(activityOperationsPlugin);
    registry.registerPlugin({
      ...skillPlugin,
      id: "sydaris.test-capability-skill",
      contributes: {
        skills: [{
          ...skillPlugin.contributes.skills![0],
          id: requiredSkillId,
          requiresCapabilities: [{ key: "calendar.read", versions: "^1.0.0" }],
        }],
      },
    });
    const session = new AgentSkillSession(registry, new ToolRuntime());

    expect(() => session.activate(requiredSkillId, { focus: "秋季活动" }))
      .toThrow(/Capability 不可用/);
  });
});
