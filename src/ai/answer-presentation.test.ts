import { describe, expect, it } from "vitest";

import { ANSWER_PRESENTATION_INSTRUCTIONS } from "@/ai/answer-presentation";

describe("answer presentation instructions", () => {
  it("keeps internal evidence protocol out of ordinary prose", () => {
    expect(ANSWER_PRESENTATION_INSTRUCTIONS).toContain("先直接回答");
    expect(ANSWER_PRESENTATION_INSTRUCTIONS).toContain("不要固定套用");
    expect(ANSWER_PRESENTATION_INSTRUCTIONS).toContain("matchedCardCount");
    expect(ANSWER_PRESENTATION_INSTRUCTIONS).toContain("不要在每个回答末尾机械追加");
  });
});
