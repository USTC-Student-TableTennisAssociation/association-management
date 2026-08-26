import { generateText } from "ai";
import { z } from "zod";

import { getChatModel } from "@/ai/provider";
import {
  readStructuredSubmission,
  structuredSubmissionTool,
} from "@/ai/structured-submission";
import { modelHistoryMessageText } from "@/ai/ui-message-text";
import type { ClubChatMessage } from "@/ai/types";
import type { ViewCardState, ViewModule, ViewReadSnapshot } from "@/contracts";

const decisionSchema = z.object({
  action: z.enum(["silent", "respond"]),
  message: z.string().trim().max(800)
    .describe("silent 时必须为空字符串；respond 时必须填写一条用户可见的中文消息"),
  reason: z.string().trim().min(1).max(500),
}).superRefine((decision, context) => {
  if (decision.action !== "silent" && !decision.message) {
    context.addIssue({
      code: "custom",
      path: ["message"],
      message: "respond 决定必须提供用户可见消息",
    });
  }
  if (decision.action === "silent" && decision.message) {
    context.addIssue({
      code: "custom",
      path: ["message"],
      message: "silent 决定不能附带用户可见消息",
    });
  }
});

export type ViewChangeAttentionDecision = z.output<typeof decisionSchema>;

export type ViewChangeExecution = {
  id: string;
  commandKey: string;
  input: unknown;
  result: unknown;
  stateVersionBefore: string;
  stateVersionAfter: string;
};

export type ViewChangeEvent = {
  type: string;
  payload: unknown;
  stateVersion: string;
};

export type ViewRelatedObject = {
  id: string;
  canonicalName: string;
  cognitiveMemory?: unknown;
};

export type ViewChangeObserverInput = {
  viewModule: ViewModule;
  snapshot: ViewReadSnapshot;
  executions: readonly ViewChangeExecution[];
  events: readonly ViewChangeEvent[];
  objects: readonly ViewRelatedObject[];
  conversation: readonly ClubChatMessage[];
};

const databaseId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function logicalValue(
  value: unknown,
  cardRefs: ReadonlyMap<string, string>,
  objectRefs: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === "string") {
    return cardRefs.get(value) ?? objectRefs.get(value) ?? (databaseId.test(value) ? "内部引用" : value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => logicalValue(item, cardRefs, objectRefs));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    logicalValue(item, cardRefs, objectRefs),
  ]));
}

function presentCard(
  card: ViewCardState,
  index: number,
  viewModule: ViewModule,
  cardRefs: ReadonlyMap<string, string>,
  objectRefs: ReadonlyMap<string, string>,
) {
  const cardType = viewModule.schema.cardTypes.find((candidate) => candidate.key === card.cardTypeKey);
  const dimensions = Object.entries(card.dimensions).map(([key, value]) => {
    const definition = cardType?.dimensions.find((candidate) => candidate.key === key);
    return {
      key,
      label: definition?.label ?? key,
      description: definition?.description ?? null,
      value,
    };
  });
  return {
    ref: cardRefs.get(card.id) ?? `V${index + 1}`,
    type: cardType?.label ?? card.cardTypeKey,
    dimensions,
    slots: Object.fromEntries(Object.entries(card.slots).map(([key, ids]) => [
      cardType?.slots.find((slot) => slot.key === key)?.label ?? key,
      ids.flatMap((id) => cardRefs.get(id) ?? []),
    ])),
    relatedObjects: card.relatedObjectIds.flatMap((id) => objectRefs.get(id) ?? []),
  };
}

export function buildViewChangeObserverPrompt(input: ViewChangeObserverInput): string {
  const cardRefs = new Map(input.snapshot.cards.map((card, index) => [card.id, `V${index + 1}`]));
  const objectRefs = new Map(input.objects.map((object, index) => [object.id, `O${index + 1}`]));
  const commandsByKey = new Map(input.viewModule.commands.map((command) => [command.key, command]));
  const recentConversation = input.conversation.slice(-8).flatMap((message) => {
    const text = modelHistoryMessageText(message).trim();
    return text ? [{ role: message.role, text }] : [];
  });

  return [
    "你是 Echo 的后台 View Change Observer。用户刚刚亲自在正式 Business View 中完成了修改。你只判断是否值得主动打扰用户，不执行任何写入，也不把操作日志当作新的知识证据。",
    "默认选择 silent。只有变化与现有认知明显冲突、可能遗漏重要联动、产生真实歧义，或你能提出具体且有价值的下一步时，才选择 respond。respond 的内容可以是信息、问题或建议，不需要给它们继续分类。",
    "用户已经明确完成的修改不需要再次确认。措辞润色、错别字、合理补空和纯展示排序应保持 silent。不要只说‘我注意到你修改了……’，也不要为了显得主动而制造建议。",
    "相关 Object 没有 Cognitive Higher Memory 本身不是打扰理由。只有 View 自己提供的 Card、Dimension 或 Slot 语义明确表明本次变化是重要、可长期复用的正式事实，而且不沉淀会形成明显知识缺口时，才可以提出一次简短的 Shared Brain 一致性检查建议；这不是重新确认 View 修改，也不能声称知识一定冲突。",
    "如果正式 View 的新状态与旧 Higher Memory 不一致，可以建议后续审查或同步知识，但不得声称已经更新 Shared Brain。",
    "用户可见消息应自然、简短、具体，使用中文，最多一个问题或建议。形成判断后必须调用 submitViewAttentionDecision。",
    JSON.stringify({
      view: {
        key: input.snapshot.viewKey,
        label: input.viewModule.manifest.label,
        description: input.viewModule.manifest.description,
        semanticInstructions: input.viewModule.manifest.aiSemanticInstructions ?? null,
        stateVersion: input.snapshot.stateVersion,
        cards: input.snapshot.cards.map((card, index) =>
          presentCard(card, index, input.viewModule, cardRefs, objectRefs)
        ),
      },
      relatedObjects: input.objects.map((object) => ({
        ref: objectRefs.get(object.id),
        canonicalName: object.canonicalName,
        cognitiveHigherMemory: object.cognitiveMemory ?? null,
      })),
      humanChanges: input.executions.map((execution) => ({
        command: commandsByKey.get(execution.commandKey)?.label ?? execution.commandKey,
        fromStateVersion: execution.stateVersionBefore,
        toStateVersion: execution.stateVersionAfter,
        input: logicalValue(execution.input, cardRefs, objectRefs),
        result: logicalValue(execution.result, cardRefs, objectRefs),
        events: input.events.filter((event) => event.stateVersion === execution.stateVersionAfter)
          .map((event) => ({
            type: event.type,
            payload: logicalValue(event.payload, cardRefs, objectRefs),
          })),
      })),
      recentConversation,
    }),
  ].join("\n\n");
}

export async function observeViewChanges(
  input: ViewChangeObserverInput,
): Promise<ViewChangeAttentionDecision> {
  const result = await generateText({
    model: getChatModel(),
    tools: {
      submitViewAttentionDecision: structuredSubmissionTool({
        description: "提交是否应就本批人工 View 修改主动联系用户的最终决定",
        schema: decisionSchema,
      }),
    },
    toolChoice: { type: "tool", toolName: "submitViewAttentionDecision" },
    prompt: buildViewChangeObserverPrompt(input),
    temperature: 0.2,
    maxOutputTokens: 2_000,
    timeout: { totalMs: 1_800_000, stepMs: 1_800_000 },
  });
  const decision = readStructuredSubmission({
    toolCalls: result.toolCalls,
    toolName: "submitViewAttentionDecision",
    schema: decisionSchema,
  });
  if (!decision) throw new Error("View Change Observer 没有提交结构化决定");
  return decision;
}
