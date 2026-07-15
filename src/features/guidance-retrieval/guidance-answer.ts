import type { GuidanceContextItem } from "./guidance-context";

export type GuidanceAnswerCitation = {
  guidelineId: string;
  reason: string;
};

export type GuidanceAnswer = {
  answer: string;
  citations: readonly GuidanceAnswerCitation[];
  unresolved: readonly string[];
};

export const guidanceAnswerSystemPrompt = `
你是高校学生社团的指导助手。

必须遵守：
1. 只能依据用户消息中提供的指导卡片回答。
2. 不得编造制度、期限、联系人或指导卡片。
3. 每一条关键结论都必须引用真实的指导卡片 ID。
4. authority 为 pending_confirmation 的内容只能表述为待确认信息，不能称为正式规定。
5. 如果现有卡片无法回答，应在 unresolved 中说明缺失的信息。
6. answer 正文中不得显示指导卡片 ID;卡片 ID 只能出现在 citations 的 guidelineId 字段中。
7. answer 应直接回答用户问题，避免与 citations 中的引用理由重复。
8. 只返回 JSON 对象，不要输出 Markdown 代码围栏或 JSON 之外的文字。

返回结构：
{
  "answer": "给用户的中文回答",
  "citations": [
    {
      "guidelineId": "指导卡片 ID",
      "reason": "引用这张卡片的原因"
    }
  ],
  "unresolved": ["现有指导信息无法确认的事项"]
}
`;

export function buildGuidanceAnswerUserPrompt(
  question: string,
  context: readonly GuidanceContextItem[],
): string {
  return `用户问题：${question.trim()}

以下是唯一可以使用的指导卡片：
${JSON.stringify(context, null, 2)}`;
}