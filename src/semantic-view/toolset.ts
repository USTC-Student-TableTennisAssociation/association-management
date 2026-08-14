import { tool } from "ai";

import { MemoryEvidenceAccumulator } from "@/memory/evidence-accumulator";
import type { ChatAssertionCaptureResult } from "@/memory/chat-assertion";
import {
  businessViewDefinitions,
  cardTypePromptContract,
} from "@/semantic-view/card-types";
import { createSemanticViewReferenceRegistry } from "@/semantic-view/read-snapshot";
import {
  createViewProposal,
  getSemanticView,
  SemanticViewValidationError,
} from "@/semantic-view/service";
import {
  type BusinessViewKey,
  type ViewProposalPresentation,
  viewChangePayloadSchema,
} from "@/semantic-view/types";

export function createSemanticViewToolset(input: {
  evidence: MemoryEvidenceAccumulator;
  onProposal?: (proposal: ViewProposalPresentation) => void;
}) {
  const inspectedViewKeys = new Set<BusinessViewKey>();
  const inspectedObjectIds = new Set<string>();
  const foregroundObjectIds = new Set<string>();
  const foregroundAssertionIds = new Set<string>();
  const viewReferences = createSemanticViewReferenceRegistry();

  const tools = {
    readSemanticView: tool({
      description:
        "读取指定 Business View 当前已经批准的完整正式状态，包括全部 Card Types、Cards、" +
        "ContentDimensions（含缺失的 seed dimensions）以及 Slots（含空 Slots）。" +
        "当前支持 society_information 和 activity_operations。命中其业务范围的问题应优先调用。" +
        "isFullSnapshot=true 只表示没有检索遗漏；空字段只表示正式 View 当前没有记录，" +
        "不表示现实世界不存在。返回的 V# 可在最终回答中引用。",
      inputSchema: viewChangePayloadSchema.pick({ viewKey: true }),
      execute: async ({ viewKey }) => {
        const view = await getSemanticView(viewKey);
        inspectedViewKeys.add(viewKey);
        for (const card of view.cards) {
          if (card.objectId) inspectedObjectIds.add(card.objectId);
          for (const slot of card.slots) {
            for (const target of slot.targets) {
              if (target.objectId) inspectedObjectIds.add(target.objectId);
            }
          }
        }
        return viewReferences.buildSnapshot(view);
      },
    }),

    proposeViewChange: tool({
      description: [
        "把当前 Chat AI 已经形成的 Business View 修改判断表达成结构化 Proposal。",
        "这是一个笨工具：它不检索、不分析、不调用另一个模型，也绝不会修改正式 View。",
        "调用前必须先读取 readSemanticView。用户在当前对话中明确确认的业务修改可以直接提议，",
        "不要求先检索 Assertion；如果建议来自 Shared Brain fallback，可以把本轮真实 Assertion ids",
        "作为本次 Proposal 的可选依据。source-backed Card 使用本轮检索到、或由前台 Chat → Assertion 成功发布后返回的 GlobalObject id；activity_operations",
        "的原生 Runtime Card 可以直接使用 name 建立业务身份。",
        "只有稳定、可复用且属于当前 View 职责的缺口才应主动吸收；ContentDimension 是开放结构；",
        "Slot key 只能使用开发者合同。",
        "支持的合同：",
        ...Object.values(businessViewDefinitions).map((view) =>
          cardTypePromptContract(view.key)
        ),
      ].join("\n"),
      inputSchema: viewChangePayloadSchema,
      execute: async (payload) => {
        if (!inspectedViewKeys.has(payload.viewKey)) {
          throw new SemanticViewValidationError(
            `提出 ${payload.viewKey} Proposal 前必须先调用 readSemanticView`,
          );
        }
        const evidence = input.evidence.snapshot();
        const proposal = await createViewProposal({
          payload,
          evidenceCompilationId: evidence.compilationId,
          allowedObjectIds: new Set(
            [
              ...evidence.seedMap.objects.map((object) => object.id),
              ...foregroundObjectIds,
            ],
          ),
          allowedAssertionIds: new Set(
            [
              ...evidence.seedMap.assertions.flatMap((assertion) =>
                assertion.id ? [assertion.id] : []
              ),
              ...foregroundAssertionIds,
            ],
          ),
        });
        input.onProposal?.(proposal);
        return {
          proposalId: proposal.id,
          status: proposal.status,
          message: "Proposal 已进入当前 Chat，只有用户点击批准后才会修改正式 Business View。",
        };
      },
    }),
  };

  return {
    tools,
    registerPublishedMemory: (result: ChatAssertionCaptureResult) => {
      for (const objectId of result.affectedObjectIds) foregroundObjectIds.add(objectId);
      for (const assertionId of result.publishedAssertionIds) {
        foregroundAssertionIds.add(assertionId);
      }
    },
    hasInspectedObject: (globalObjectId: string) =>
      inspectedObjectIds.has(globalObjectId) || foregroundObjectIds.has(globalObjectId),
    citedReferences: viewReferences.citedReferences,
  };
}
