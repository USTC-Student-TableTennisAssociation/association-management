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
  private readonly activated = new Map<string, ActivatedSkill>();

  constructor(
    private readonly registry: ExtensionRegistry,
    private readonly toolRuntime: ToolRuntime,
  ) {}

  list(): readonly SkillExtension[] {
    return this.registry.listSkills();
  }

  active(): ActivatedSkill | undefined {
    return this.activations().at(-1);
  }

  activations(): readonly ActivatedSkill[] {
    return [...this.activated.values()];
  }

  activeSkillIds(): string[] {
    return this.activations().map(({ extension }) => extension.id);
  }

  activate(skillId: string, rawInput: unknown): ActivatedSkill {
    const skill = this.list().find((candidate) => candidate.id === skillId);
    if (!skill) throw new SkillRuntimeError(`Skill 未安装或未启用：${skillId}`);
    const input = skill.inputSchema.parse(rawInput);
    this.toolRuntime.assertRequirementsAvailable(skill.requiresCapabilities);
    const existing = this.activated.get(skill.id);
    if (existing) {
      if (stableJson(existing.input) === stableJson(input)) return existing;
      throw new SkillRuntimeError(
        `本轮已使用另一组输入激活 Skill ${skill.id}，不能重复改变同一工作流的输入`,
      );
    }
    const activation = { extension: skill, input };
    this.activated.set(skill.id, activation);
    return activation;
  }

  canReadView(viewKey: string): boolean {
    if (this.activated.size === 0) return true;
    return this.activations().some(({ extension }) =>
      extension.viewAccess.some((access) => access.viewKey === viewKey)
    );
  }

  canRunCommand(viewKey: string, commandKey: string): boolean {
    if (this.activated.size === 0) return true;
    return Boolean(this.authorizingSkillForCommand(viewKey, commandKey));
  }

  authorizingSkillForCommand(
    viewKey: string,
    commandKey: string,
  ): ActivatedSkill | undefined {
    return this.activations().find(({ extension }) =>
      extension.viewAccess.some((access) =>
        access.mode === "write" &&
        access.viewKey === viewKey &&
        access.commands.includes(commandKey)
      )
    );
  }

  canUseResourceOperation(resource: string, operation: string): boolean {
    if (this.activated.size === 0) return true;
    return Boolean(this.authorizingSkillForResourceOperation(resource, operation));
  }

  authorizingSkillForResourceOperation(
    resource: string,
    operation: string,
  ): ActivatedSkill | undefined {
    return this.activations().find(({ extension }) =>
      (extension.resourceAccess ?? []).some((access) =>
        access.resource === resource && access.operations.includes(operation)
      )
    );
  }

  canOpenAction(
    area: "business_view" | "object" | "library",
    businessViewKey?: string,
  ): boolean {
    if (this.activated.size === 0) return true;
    if (area === "library") {
      return this.canUseResourceOperation("library", "propose_plan");
    }
    if (area === "object") {
      return this.canUseResourceOperation("object", "propose_change");
    }
    if (!businessViewKey) return false;
    return this.activations().some(({ extension }) =>
      extension.viewAccess.some((access) =>
        access.mode === "write" && access.viewKey === businessViewKey
      )
    );
  }

  instructions(): string {
    if (this.activated.size === 0) return "";
    const blocks = this.activations().map(({ extension, input }) => {
      const viewScope = extension.viewAccess.map((access) =>
        access.mode === "write"
          ? `${access.viewKey}@${access.schemaVersion} (write: ${access.commands.join(", ")})`
          : `${access.viewKey}@${access.schemaVersion} (read)`
      ).join("\n");
      const resourceScope = (extension.resourceAccess ?? []).map((access) =>
        `${access.resource} (${access.operations.join(", ")})`
      ).join("\n");
      return [
        `【已激活 Skill】${extension.label} (${extension.id}@${extension.version})`,
        extension.description,
        `本轮 Skill 输入：${JSON.stringify(input)}`,
        `View 权限：\n${viewScope || "（无）"}`,
        `Resource 权限：\n${resourceScope || "（无）"}`,
        "Skill 权限由 Runtime 强制执行；不得调用未声明的 View Command 或 Resource Operation。",
        extension.instructions,
      ].join("\n\n");
    });
    return [
      "【本轮已激活的可组合 Skills】",
      "同时遵守以下工作流；权限按声明取并集，任何未声明的副作用仍被 Runtime 拒绝。",
      ...blocks,
    ].join("\n\n");
  }
}

type ActivationRequest = {
  skillId: string;
  input: unknown;
};

function activationJsonSchema(skills: readonly SkillExtension[]): JSONSchema7 {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      skillId: {
        type: "string",
        enum: skills.map((skill) => skill.id),
        description: "要激活的已安装 Skill ID。",
      },
      input: {
        type: "object",
        additionalProperties: true,
        description: "传给所选 Skill 的输入对象；具体字段由该 Skill 的输入契约决定。",
      },
    },
    required: ["skillId", "input"],
  };
}

export function createAgentSkillToolset(input: {
  session: AgentSkillSession;
  onActivate?: (activation: ActivatedSkill) => void;
}): { tools: ToolSet; toolNames: string[] } {
  const skills = input.session.list();
  if (skills.length === 0) return { tools: {}, toolNames: [] };
  const catalog = skills.map((skill) =>
    [
      `${skill.id}（${skill.label}）：${skill.description}`,
      `input JSON Schema：${JSON.stringify(skill.inputSchema.jsonSchema)}`,
    ].join("\n")
  ).join("\n");
  const tools: ToolSet = {
    activateSkill: tool({
      description: [
        "激活一个已安装的 Sydaris Skill，将其专用指令、View 边界与 Command 权限应用到本轮后续步骤。",
        "当用户明确点名 Skill，或当前任务与某个 Skill 的职责高度匹配时调用。不同 Skill 可以在同一轮组合；同一 Skill 不能用不同输入重复激活。",
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
          resourceAccess: activation.extension.resourceAccess ?? [],
          activeSkills: input.session.activeSkillIds(),
          next:
            "按所有已激活 Skill 指令打开必要 Context，核对证据后使用已声明的 View Command 或 Resource Operation。",
        };
      },
    }),
  };
  return { tools, toolNames: Object.keys(tools) };
}
