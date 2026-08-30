import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";

import type { SkillExtension } from "@/contracts";
import type { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import type { ToolRuntime } from "@/runtime/tool-runtime/tool-runtime";

export type ActivatedSkill = {
  extension: SkillExtension;
  input: unknown;
};

export class SkillRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillRuntimeError";
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export class AgentSkillSession {
  private activated?: ActivatedSkill;

  constructor(
    private readonly registry: ExtensionRegistry,
    private readonly toolRuntime: ToolRuntime,
  ) {}

  list(): readonly SkillExtension[] {
    return this.registry.listSkills();
  }

  active(): ActivatedSkill | undefined {
    return this.activated;
  }

  activate(skillId: string, rawInput: unknown): ActivatedSkill {
    const skill = this.list().find((candidate) => candidate.id === skillId);
    if (!skill) throw new SkillRuntimeError(`Skill 未安装或未启用：${skillId}`);
    const input = skill.inputSchema.parse(rawInput);
    this.toolRuntime.assertRequirementsAvailable(skill.requiresCapabilities);
    if (this.activated) {
      if (
        this.activated.extension.id === skill.id &&
        stableJson(this.activated.input) === stableJson(input)
      ) {
        return this.activated;
      }
      throw new SkillRuntimeError(
        `本轮已激活 Skill ${this.activated.extension.id}，不能在同一轮切换工作流`,
      );
    }
    this.activated = { extension: skill, input };
    return this.activated;
  }

  canReadView(viewKey: string): boolean {
    if (!this.activated) return true;
    return this.activated.extension.viewAccess.some((access) =>
      access.viewKey === viewKey
    );
  }

  canRunCommand(viewKey: string, commandKey: string): boolean {
    if (!this.activated) return true;
    return this.activated.extension.viewAccess.some((access) =>
      access.mode === "write" &&
      access.viewKey === viewKey &&
      access.commands.includes(commandKey)
    );
  }

  canOpenAction(
    area: "business_view" | "object" | "library",
    businessViewKey?: string,
  ): boolean {
    if (!this.activated) return true;
    if (area !== "business_view" || !businessViewKey) return false;
    return this.activated.extension.viewAccess.some((access) =>
      access.mode === "write" && access.viewKey === businessViewKey
    );
  }

  instructions(): string {
    if (!this.activated) return "";
    const { extension, input } = this.activated;
    const viewScope = extension.viewAccess.map((access) =>
      access.mode === "write"
        ? `${access.viewKey}@${access.schemaVersion} (write: ${access.commands.join(", ")})`
        : `${access.viewKey}@${access.schemaVersion} (read)`
    ).join("\n");
    return [
      `【已激活 Skill】${extension.label} (${extension.id}@${extension.version})`,
      extension.description,
      `本轮 Skill 输入：${JSON.stringify(input)}`,
      `View 权限：\n${viewScope || "（无）"}`,
      "Skill 的写入范围由 Runtime 强制执行；不得调用未声明的 View Command。",
      extension.instructions,
    ].join("\n\n");
  }
}

type ActivationRequest = {
  skillId: string;
  input: unknown;
};

function activationJsonSchema(skills: readonly SkillExtension[]): JSONSchema7 {
  return {
    oneOf: skills.map((skill) => ({
      type: "object" as const,
      additionalProperties: false,
      properties: {
        skillId: { const: skill.id },
        input: skill.inputSchema.jsonSchema as JSONSchema7,
      },
      required: ["skillId", "input"],
    })),
  };
}

export function createAgentSkillToolset(input: {
  session: AgentSkillSession;
  onActivate?: (activation: ActivatedSkill) => void;
}): { tools: ToolSet; toolNames: string[] } {
  const skills = input.session.list();
  if (skills.length === 0) return { tools: {}, toolNames: [] };
  const catalog = skills.map((skill) =>
    `${skill.id}（${skill.label}）：${skill.description}`
  ).join("\n");
  const tools: ToolSet = {
    activateSkill: tool({
      description: [
        "激活一个已安装的 Sydaris Skill，将其专用指令、View 边界与 Command 权限应用到本轮后续步骤。",
        "当用户明确点名 Skill，或当前任务与某个 Skill 的职责高度匹配时调用。每轮只能激活一个 Skill。",
        `已安装 Skills：\n${catalog}`,
      ].join("\n"),
      inputSchema: jsonSchema<ActivationRequest>(activationJsonSchema(skills)),
      execute: async ({ skillId, input: skillInput }) => {
        const activation = input.session.activate(skillId, skillInput);
        input.onActivate?.(activation);
        return {
          activated: true,
          skill: {
            id: activation.extension.id,
            version: activation.extension.version,
            label: activation.extension.label,
            description: activation.extension.description,
          },
          input: activation.input,
          viewAccess: activation.extension.viewAccess,
          next:
            "按已激活 Skill 指令打开必要的 Business Context，核对证据后使用允许的 View Command。",
        };
      },
    }),
  };
  return { tools, toolNames: Object.keys(tools) };
}
