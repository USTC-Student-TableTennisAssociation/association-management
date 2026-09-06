import { tool } from "ai";
import { z } from "zod";

import type { ChatAssertionCaptureResult } from "@/memory/chat-assertion";
import {
  createActorObjectBindingProposal,
  createObjectChangeProposal,
  inspectObjectIdentity,
} from "@/memory/object-management-service";
import {
  type ObjectChangeProposalPresentation,
  objectChangePayloadSchema,
} from "@/memory/object-management-types";

export function createObjectManagementToolset(input: {
  authUser: {
    userId: string;
  };
  resolveObjectReference: (
    reference: string,
  ) => { id: string; canonicalName: string } | undefined;
  conversationUserMessages: Array<{ messageId: string; text: string }>;
  onProposal?: (proposal: ObjectChangeProposalPresentation) => void;
}) {
  const inspectedObjectIds = new Set<string>();
  const foregroundObjectIds = new Set<string>();

  const inspectTool = tool({
    description: [
      "读取一个 GlobalObject 的身份构成，不是普通事实检索。",
      "返回主名称、每个可精确操作的 Surface 来源、每个 Assertion 引用、Higher Memory 和正式 View 依赖。",
      "当新名称与已有 Object 重叠、怀疑旧 surface_forms 错误、或考虑改名/合并/拆分时先调用。",
      "Surface/Reference id 只用于精确表达后续 Object Change Proposal，不能当作事实证据。",
    ].join("\n"),
    inputSchema: z.object({
      objectRef: z.string().trim().regex(/^O\d+$/)
        .describe("必须原样使用本轮 Shared Brain 或 View 读取返回的 O#"),
    }),
    execute: async ({ objectRef }) => {
      const resolved = input.resolveObjectReference(objectRef);
      if (!resolved) throw new Error(`本轮无法解析 Object 引用 ${objectRef}`);
      const objectId = resolved.id;
      const inspection = await inspectObjectIdentity(objectId);
      inspectedObjectIds.add(objectId);
      return inspection;
    },
  });

  return {
    tools: {
      inspectObjectIdentity: inspectTool,
      proposeObjectChange: tool({
        description: [
          "提出 Object 身份修改建议；这是可审计 Proposal，调用本身不会修改数据库。",
          "每个涉及的 Object 必须先调用 inspectObjectIdentity。",
          "REMOVE_SURFACE 纠正错误别名归属；SET_CANONICAL_NAME 只能选择已有真实名称来源；",
          "MERGE_OBJECTS 把 Surface、聊天名称来源和 Assertion 引用迁移到 survivor；",
          "SPLIT_OBJECT 用 inspect 返回的精确 Surface/Reference ids 把混合身份拆成两个 Object。",
          "合并/拆分会使相关 Higher Memory 失效，不能拼接旧文本；若存在正式 Business View Card，",
          "当前版本会在批准时阻止危险应用，应先向用户说明依赖。",
          "只有用户明确要求管理身份，或新事实的 Object 创建确实被身份重叠阻塞时才提议；不要把近似名称自动当成同一身份。",
        ].join("\n"),
        inputSchema: objectChangePayloadSchema,
        execute: async (payload) => {
          const proposal = await createObjectChangeProposal({
            payload,
            allowedObjectIds: new Set([...inspectedObjectIds, ...foregroundObjectIds]),
          });
          input.onProposal?.(proposal);
          return {
            proposalId: proposal.id,
            status: proposal.status,
            invalidatesHigherMemory: proposal.invalidatesHigherMemory,
            message: "Object Change Proposal 已进入当前 Chat；只有用户批准后才会原子修改 Object 身份。",
          };
        },
      }),
      proposeActorObjectBinding: tool({
        description: [
          "为当前登录账号提出 Actor Object 身份关联建议；调用本身不会修改数据库。",
          "只在用户明确表示自己就是本轮已发现的某个 O# 人物，并要求建立关联时使用。",
          "同名、账号显示名、资料署名或模型推断都不构成确认。confirmationQuote 必须逐字复制本次对话中用户亲口作出的身份确认。",
          "Runtime 会读取账号当前锚点、目标 Object 及两者真实 View 依赖；批准后才会绑定，必要时原子合并旧的独立账号锚点。",
        ].join("\n"),
        inputSchema: z.object({
          targetObjectRef: z.string().trim().regex(/^O\d+$/)
            .describe("用户明确确认是自己的目标人物 O#"),
          confirmationQuote: z.string().trim().min(1).max(1_000)
            .describe("用户关于自己就是该人物的逐字原话，不能改写"),
          reason: z.string().trim().min(1).max(1_000),
        }),
        execute: async ({ targetObjectRef, confirmationQuote, reason }) => {
          const resolved = input.resolveObjectReference(targetObjectRef);
          if (!resolved) throw new Error(`本轮无法解析 Object 引用 ${targetObjectRef}`);
          const confirmedByUser = input.conversationUserMessages.some(
            (message) => message.text.includes(confirmationQuote),
          );
          if (!confirmedByUser) {
            throw new Error("confirmationQuote 不是本次对话中用户的逐字原话。");
          }
          const proposal = await createActorObjectBindingProposal({
            authUserId: input.authUser.userId,
            targetObjectId: resolved.id,
            confirmationQuote,
            reason,
          });
          input.onProposal?.(proposal);
          return {
            proposalId: proposal.id,
            status: proposal.status,
            message: "身份关联 Proposal 已进入当前 Chat；只有用户批准后才会绑定或合并 Actor Object。",
          };
        },
      }),
    },
    inspectTool,
    registerPublishedMemory: (result: ChatAssertionCaptureResult) => {
      for (const objectId of result.affectedObjectIds) foregroundObjectIds.add(objectId);
    },
    hasInspectedObject: (objectId: string) =>
      inspectedObjectIds.has(objectId) || foregroundObjectIds.has(objectId),
  };
}
