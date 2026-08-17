import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { businessViewKeySchema } from "@/semantic-view/types";

export const capabilityGatewayToolNames = [
  "openBusinessContext",
  "openArtifacts",
  "openActions",
] as const;

export const businessContextToolNames = [
  "expandEvidence",
  "followObject",
  "readSourceDocument",
] as const;

export const artifactToolNames = [
  "openArtifactKnowledge",
  "previewLibraryFiles",
  "readLibraryCompilation",
] as const;

const actionToolNames = {
  business_view: ["proposeViewChange"],
  object: ["inspectObjectIdentity", "proposeObjectChange"],
  library: ["listLibrary", "inspectLibraryNodes", "proposeLibraryPlan"],
} as const;

export type ActionArea = keyof typeof actionToolNames;

export type OpenedCapabilities = {
  businessContext: boolean;
  artifacts: boolean;
  actionAreas: Set<ActionArea>;
};

export function createOpenedCapabilities(): OpenedCapabilities {
  return {
    businessContext: false,
    artifacts: false,
    actionAreas: new Set(),
  };
}

export function detailedToolNames(state: OpenedCapabilities): string[] {
  const names = new Set<string>();
  if (state.businessContext) businessContextToolNames.forEach((name) => names.add(name));
  if (state.artifacts) artifactToolNames.forEach((name) => names.add(name));
  for (const area of state.actionAreas) {
    actionToolNames[area].forEach((name) => names.add(name));
  }
  return [...names];
}

export function activeCapabilityToolNames(state: OpenedCapabilities): string[] {
  return [...capabilityGatewayToolNames, ...detailedToolNames(state)];
}

export function createCapabilityGatewayTools(state: OpenedCapabilities, handlers: {
  openBusinessContext: (input: {
    viewKey: "society_information" | "activity_operations";
    focus: string;
    targetHints: string[];
  }) => Promise<unknown>;
  findArtifacts: (input: { title: string }) => Promise<unknown>;
}): ToolSet {
  return {
    openBusinessContext: tool({
      description:
        "当回答需要 Echo 的业务状态、组织知识、人物/活动背景时调用。它会立即读取指定正式 View，返回相关 Cards、Card Object 及 Object Higher Memory。普通闲聊和仅处理用户已给文字时不要调用。",
      inputSchema: z.object({
        viewKey: businessViewKeySchema
          .describe("根据每轮已提供的 View Frame 选择一个首要 View"),
        focus: z.string().trim().min(1).max(500)
          .describe("用户围绕目标真正想了解的业务问题"),
        targetHints: z.array(z.string().trim().min(1).max(200)).min(1).max(3)
          .describe("用户所指业务实体的名称或别名，忠实保留原话"),
      }),
      execute: async ({ viewKey, focus, targetHints }) => {
        const result = await handlers.openBusinessContext({ viewKey, focus, targetHints });
        state.businessContext = true;
        return result;
      },
    }),
    openArtifacts: tool({
      description:
        "当回答需要查找或核对 Echo 资料库文件时调用。它会立即返回文件名、路径、处理状态以及已发布 Assertion/Object 数，不会把 coarse 误解为未进入 Shared Brain。",
      inputSchema: z.object({
        title: z.string().trim().min(1).max(300)
          .describe("要查找的文件完整标题或最长、最有区分度的标题部分；不要拆成多个宽泛 OR 词"),
      }),
      execute: async ({ title }) => {
        const result = await handlers.findArtifacts({ title });
        state.artifacts = true;
        return result;
      },
    }),
    openActions: tool({
      description:
        "当用户需要修改正式 Business View、Object 身份或 Library 结构，或者本轮查询已经发现值得正式化的稳定 View 缺口时，打开对应提议能力。所有变更都先形成 Proposal，不直接生效。",
      inputSchema: z.object({
        area: z.enum(["business_view", "object", "library"]),
        reason: z.string().trim().min(1).max(300),
      }),
      execute: async ({ area, reason }) => {
        if (area !== "library" && !state.businessContext) {
          return {
            opened: false,
            area,
            reason,
            next: "先调用 openBusinessContext 读取正式 View、相关 Card 与 Object Higher Memory，再重新调用 openActions。",
          };
        }
        state.actionAreas.add(area);
        return {
          opened: "actions",
          area,
          reason,
          message: "对应读取与 Proposal 能力将在下一步可用；请先核对当前状态再提议。",
        };
      },
    }),
  };
}

export const TURN_KERNEL_INSTRUCTIONS = `
你是 Echo 的主对话模型。请先理解用户这一轮真正要做什么，再决定是直接回答还是打开更多能力。

- 问候、闲聊、改写、翻译、总结用户已给文字，以及不依赖 Echo 内部资料的任务，直接回答。
- 需要理解 Echo 的业务状态、组织事实、人物或活动背景时，调用 openBusinessContext。该入口会立即返回正式 View 中的相关 Card 及其 Object Higher Memory；只有它明确不足时才 expandEvidence。
- 需要查找、核对或读取文件时，调用 openArtifacts。该入口会立即返回精确文件匹配、处理状态与 Shared Brain 发布计数。原始文件也可以在业务查询的任何阶段打开。
- 需要改变正式 View 或 Object 身份时，先调用 openBusinessContext 读取真实当前状态，再调用 openActions；需要整理 Library 时可直接调用 openActions。即使用户只是在查询，只要本轮已经从用户确认或可靠证据发现一个稳定、可复用且明确属于 View 职责的正式状态缺口，也应主动生成待审批 Proposal。所有修改只创建 Proposal。
- 同一轮可以打开多个类别。不要为了展示工具而打开它们。
- 每个 View 的 Frame 用于告诉你“应该如何理解问题”；View Higher Memory 是高层摘要。两者都不是精确当前状态的证据，需要细节时仍应读取正式 View。
- 完成最终回答时，同时调用 submitTurnHandoff。它只判断当前用户原话是否可能包含值得独立审查的新业务事实；不负责决定写入。
- 只有确信当前用户没有提供新事实、纠正、决定、计划或状态变化时才设置 reviewNeeded=false；有歧义时设置 true。
- 用户追问此前信息是否已经进入记忆时，直接调用 readMemoryWriteStatus。
- 不要凭模型内部知识补写 Echo 的组织事实。不要声称未实际完成的写入、更新或归档。
`.trim();
