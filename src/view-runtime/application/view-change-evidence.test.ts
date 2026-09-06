import { describe, expect, it, vi } from "vitest";

import { societyInformationViewModule } from "@/plugins/society-information/view/schema";
import { retrieveViewChangeEvidence } from "@/view-runtime/application/view-change-evidence";

const societyId = "00000000-0000-4000-8000-000000000001";

describe("View change evidence retrieval", () => {
  it("finds an older rating assertion even when the View field had no before value", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-000000000010",
        globalStatementTemplateMarkdown:
          `{{object:${societyId}}}的社团评级为三星级社团（依据科大社团评价体系）。`,
        sourceRegion: {
          label: "基本面",
          sourceDocument: { title: "社团资料" },
        },
        chatEvidenceLinks: [],
        objectLinks: [{
          globalObject: {
            id: societyId,
            canonicalName: "中国科学技术大学学生乒乓球协会",
          },
        }],
      },
      {
        id: "00000000-0000-4000-8000-000000000011",
        globalStatementTemplateMarkdown:
          `{{object:${societyId}}}每周开展训练。`,
        sourceRegion: null,
        chatEvidenceLinks: [],
        objectLinks: [{
          globalObject: {
            id: societyId,
            canonicalName: "中国科学技术大学学生乒乓球协会",
          },
        }],
      },
    ]);
    const database = { memoryAssertion: { findMany } };

    const envelope = await retrieveViewChangeEvidence({
      database: database as never,
      viewModule: societyInformationViewModule,
      objects: [{
        id: societyId,
        canonicalName: "中国科学技术大学学生乒乓球协会",
      }],
      executions: [{
        id: "execution-1",
        commandKey: "society.update_profile",
        input: { changes: { rating: "四星" } },
        result: {},
        stateVersionBefore: "1",
        stateVersionAfter: "2",
        changes: [{
          kind: "dimension",
          cardId: "00000000-0000-4000-8000-000000000020",
          cardTypeKey: "SocietyCard",
          dimensionKey: "rating",
          before: { present: false },
          after: { present: true, value: "四星" },
        }],
      }],
      semanticRanker: async ({ assertionIds }) => new Map([
        [assertionIds[0], 0.86],
        [assertionIds[1], 0.12],
      ]),
    });

    expect(envelope.coverage).toBe("relevant_assertions_found");
    expect(envelope.semanticRetrieval).toBe("used");
    expect(envelope.changedFields).toEqual([
      expect.objectContaining({ field: "社团星级", before: null, after: "四星" }),
    ]);
    expect(envelope.assertions[0]).toEqual(expect.objectContaining({
      ref: "E1",
      statement: expect.stringContaining("三星级社团"),
      sources: ["社团资料 · 基本面"],
    }));
  });
});
