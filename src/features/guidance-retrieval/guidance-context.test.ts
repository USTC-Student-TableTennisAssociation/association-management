import { describe, expect, it } from "vitest";

import { handbookGuidelines } from "../../../prisma/handbook-guidance.data";
import { buildGuidanceContext } from "./guidance-context";
import { searchGuidelines } from "./guidance-search";

describe("指导层安全上下文", () => {
  it("把草稿卡片标记为待确认内容", () => {
    const results = searchGuidelines(
      "大型赛事只剩 5 天了，我还没提交二课申请，怎么办？",
      handbookGuidelines,
    );

    const context = buildGuidanceContext(results, 1);

    expect(context[0]).toMatchObject({
      title: "大型赛事：活动前至少 7 天提交二课申请",
      kind: "rule",
      status: "draft",
      authority: "pending_confirmation",
      isMandatory: true,
    });
  });

  it("把已发布卡片标记为正式指导", () => {
    const results = searchGuidelines(
      "活动还没有通过二课审批，可以先开始举办吗？",
      handbookGuidelines,
    );
    const firstResult = results[0];

    expect(firstResult).toBeDefined();

    if (!firstResult) {
      return;
    }

    const publishedResult = {
      ...firstResult,
      guideline: {
        ...firstResult.guideline,
        status: "published" as const,
      },
    };

    const context = buildGuidanceContext([publishedResult]);

    expect(context[0]?.authority).toBe("official");
  });

  it("限制进入上下文的卡片数量", () => {
    const results = searchGuidelines(
      "大型赛事活动审批、预算、场地和复盘应该怎样准备？",
      handbookGuidelines,
    );

    const context = buildGuidanceContext(results, 2);

    expect(context).toHaveLength(2);
  });
});