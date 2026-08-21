export type TurnHandoff = {
  reviewNeeded: boolean;
  candidateQuotes: string[];
};

export type TurnHandoffResolution = {
  handoffIsValid: boolean;
  reviewNeeded: boolean;
  candidateQuotes: string[];
  reviewSource: "handoff" | "fallback" | "question_guard";
};

const QUESTION_LEAD =
  /^(?:请问|我想(?:问|知道|了解)(?:一下)?|想(?:问|知道|了解)(?:一下)?|能否|可否|是否|有没有|有无|谁|什么|哪(?:个|些|里|儿|一)|何时|什么时候|为何|为什么|怎么|怎样|如何|几(?:个|点|时|次|天)?|多少)/u;
const QUESTION_TAIL =
  /(?:是什么|是谁|在哪里|在哪儿|在哪|何时|什么时候|怎么样|如何|为什么|怎么回事|是否|有没有|有吗|吗|呢|么)[?？。.!！]*$/u;
const DECLARATIVE_CLAUSE_BEFORE_QUESTION =
  /(?:已经|已于|确定|改为|改到|变成|举行|开始|结束|完成|成功|失败|存在|生效|发布|落地|批准|通过|更新|负责|担任|属于|保持不变|仍由|将于|位于)[^，,]*[，,]/u;

/** Conservative guard for turns that contain only a request for information. */
export function isPureQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const firstQuestionMark = trimmed.search(/[?？]/u);
  const questionPrefix = firstQuestionMark >= 0
    ? trimmed.slice(0, firstQuestionMark)
    : trimmed;
  if (/[。.!！]/u.test(questionPrefix)) return false;
  if (DECLARATIVE_CLAUSE_BEFORE_QUESTION.test(questionPrefix)) return false;

  const normalized = trimmed
    .replace(/^(?:你好|您好|麻烦你|麻烦|劳驾)[，,。.!！\s]*/u, "")
    .trim();
  return QUESTION_LEAD.test(normalized) || QUESTION_TAIL.test(normalized) || /[?？]\s*$/u.test(normalized);
}

export function resolveTurnHandoff(input: {
  handoff?: TurnHandoff;
  currentUserText: string;
}): TurnHandoffResolution {
  const handoffIsValid = Boolean(
    input.handoff &&
      input.handoff.candidateQuotes.every((quote) => input.currentUserText.includes(quote)) &&
      (input.handoff.reviewNeeded
        ? input.handoff.candidateQuotes.length > 0
        : input.handoff.candidateQuotes.length === 0),
  );

  if (handoffIsValid) {
    return {
      handoffIsValid: true,
      reviewNeeded: Boolean(input.handoff?.reviewNeeded),
      candidateQuotes: input.handoff?.candidateQuotes ?? [],
      reviewSource: "handoff",
    };
  }

  if (isPureQuestion(input.currentUserText)) {
    return {
      handoffIsValid: false,
      reviewNeeded: false,
      candidateQuotes: [],
      reviewSource: "question_guard",
    };
  }

  return {
    handoffIsValid: false,
    reviewNeeded: true,
    candidateQuotes: [],
    reviewSource: "fallback",
  };
}
