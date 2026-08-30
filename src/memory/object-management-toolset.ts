import { tool } from "ai";
import { z } from "zod";

import type { ChatAssertionCaptureResult } from "@/memory/chat-assertion";
import {
  createObjectChangeProposal,
  inspectObjectIdentity,
} from "@/memory/object-management-service";
import {
  type ObjectChangeProposalPresentation,
  objectChangePayloadSchema,
} from "@/memory/object-management-types";

export function createObjectManagementToolset(input: {
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
    inputSchema: z.object({ objectId: z.string().uuid() }),
    execute: async ({ objectId }) => {
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
    },
    inspectTool,
    registerPublishedMemory: (result: ChatAssertionCaptureResult) => {
      for (const objectId of result.affectedObjectIds) foregroundObjectIds.add(objectId);
    },
    hasInspectedObject: (objectId: string) =>
      inspectedObjectIds.has(objectId) || foregroundObjectIds.has(objectId),
  };
}
