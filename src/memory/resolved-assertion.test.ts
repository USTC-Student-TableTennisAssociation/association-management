import { describe, expect, it } from "vitest";

import {
  renderResolvedAssertion,
  ResolvedAssertionIntegrityError,
} from "@/memory/resolved-assertion";

describe("renderResolvedAssertion", () => {
  it("renders every occurrence with its resolved GlobalObject identity", () => {
    const rendered = renderResolvedAssertion({
      assertionKey: "region-1\u0000claim-1",
      globalStatementTemplateMarkdown:
        "{{object:global-event}}由{{object:global-student-union}}与{{object:global-club}}联合举办。",
      references: [
        {
          globalObjectId: "global-event",
          canonicalName: "继往开来",
        },
        {
          globalObjectId: "global-student-union",
          canonicalName: "学生会",
        },
        {
          globalObjectId: "global-club",
          canonicalName: "社团",
        },
      ],
    });

    expect(rendered).toBe("继往开来由学生会与社团联合举办。");
    expect(rendered).not.toContain("fragment:");
  });

  it("renders repeated reference atoms while preserving their multiplicity", () => {
    const rendered = renderResolvedAssertion({
      globalStatementTemplateMarkdown:
        "{{object:global-shared}}与{{object:global-shared}}在该语境中指向同一对象。",
      references: [
        {
          globalObjectId: "global-shared",
          canonicalName: "共同对象",
        },
        {
          globalObjectId: "global-shared",
          canonicalName: "共同对象",
        },
      ],
    });

    expect(rendered).toBe("共同对象与共同对象在该语境中指向同一对象。");
  });

  it("fails fast instead of guessing when references are incomplete", () => {
    expect(() =>
      renderResolvedAssertion({
        assertionKey: "region-1\u0000claim-incomplete",
        globalStatementTemplateMarkdown:
          "{{object:global-event}}由{{object:global-organizer}}举办。",
        references: [
          {
            globalObjectId: "global-event",
            canonicalName: "继往开来",
          },
        ],
      }),
    ).toThrow(ResolvedAssertionIntegrityError);
  });

  it("rejects a Global template that still contains source-local fragments", () => {
    expect(() =>
      renderResolvedAssertion({
        globalStatementTemplateMarkdown: "{{fragment:local-object}}仍未完成解析。",
        references: [],
      }),
    ).toThrow(ResolvedAssertionIntegrityError);
  });
});
