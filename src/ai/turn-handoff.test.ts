import { describe, expect, it } from "vitest";

import { resolveTurnHandoff } from "@/ai/turn-handoff";

describe("resolveTurnHandoff", () => {
  const currentUserText = "周五的活动已经改到东区体育馆举行。";

  it("accepts an explicit review request with verbatim user evidence", () => {
    expect(resolveTurnHandoff({
      currentUserText,
      handoff: {
        reviewNeeded: true,
        candidateQuotes: ["已经改到东区体育馆举行"],
      },
    })).toEqual({
      handoffIsValid: true,
      reviewNeeded: true,
      candidateQuotes: ["已经改到东区体育馆举行"],
      reviewSource: "handoff",
    });
  });

  it("accepts an explicit decision that no review is needed", () => {
    expect(resolveTurnHandoff({
      currentUserText: "活动在哪里举行？",
      handoff: { reviewNeeded: false, candidateQuotes: [] },
    })).toEqual({
      handoffIsValid: true,
      reviewNeeded: false,
      candidateQuotes: [],
      reviewSource: "handoff",
    });
  });

  it("does nothing when the handoff is missing", () => {
    expect(resolveTurnHandoff({ currentUserText })).toEqual({
      handoffIsValid: false,
      reviewNeeded: false,
      candidateQuotes: [],
      reviewSource: "missing_or_invalid",
    });
  });

  it("does nothing when the proposed evidence is not verbatim user text", () => {
    expect(resolveTurnHandoff({
      currentUserText,
      handoff: {
        reviewNeeded: true,
        candidateQuotes: ["活动改到西区体育馆"],
      },
    })).toEqual({
      handoffIsValid: false,
      reviewNeeded: false,
      candidateQuotes: [],
      reviewSource: "missing_or_invalid",
    });
  });

  it("rejects a review request without quoted evidence", () => {
    expect(resolveTurnHandoff({
      currentUserText,
      handoff: { reviewNeeded: true, candidateQuotes: [] },
    })).toMatchObject({
      handoffIsValid: false,
      reviewNeeded: false,
      reviewSource: "missing_or_invalid",
    });
  });
});
