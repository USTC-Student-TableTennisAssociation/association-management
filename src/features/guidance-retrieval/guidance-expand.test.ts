import { describe, expect, it } from "vitest";

import {
  handbookGuidelineLinks,
  handbookGuidelines,
} from "../../../prisma/handbook-guidance.data";
import { expandGuidanceResults } from "./guidance-expand";
import { searchGuidelines } from "./guidance-search";

describe("指导卡片关系扩展", () => {
  it("根据未审批门禁补充一层直接关联的申报规则", () => {
    const searchResults = searchGuidelines(
      "活动还没有通过二课审批，可以先开始举办吗？",
      handbookGuidelines,
    ).slice(0, 1);

    const expandedResults = expandGuidanceResults(
      searchResults,
      handbookGuidelines,
      handbookGuidelineLinks,
    );

    const titles = expandedResults.map(
      (result) => result.guideline.title,
    );

    expect(titles).toContain("无二课审批不开展活动");
    expect(titles).toContain(
      "大型赛事：活动前至少 7 天提交二课申请",
    );
    expect(titles).toContain(
      "常规活动：活动前 3 天完成系统申报",
    );
  });

  //保留关联卡片的关系类型和方向
    it("保留关联卡片的关系类型和方向", () => {
    const searchResults = searchGuidelines(
      "活动还没有通过二课审批，可以先开始举办吗？",
      handbookGuidelines,
    ).slice(0, 1);

    const expandedResults = expandGuidanceResults(
      searchResults,
      handbookGuidelines,
      handbookGuidelineLinks,
    );

    const relatedResult = expandedResults.find(
      (result) =>
        result.guideline.title ===
        "大型赛事：活动前至少 7 天提交二课申请",
    );

    expect(relatedResult?.source).toBe("relation");
    expect(relatedResult?.relation?.relationType).toBe("triggers");
    expect(relatedResult?.relation?.fromGuidelineId).toBe(
      searchResults[0]?.guideline.id,
    );
    expect(relatedResult?.relation?.toGuidelineId).toBe(
      relatedResult?.guideline.id,
    );
  });

  //验证同一张指导卡片不会重复出现
    it("不会重复添加同一张指导卡片", () => {
    const firstResult = searchGuidelines(
      "活动还没有通过二课审批，可以先开始举办吗？",
      handbookGuidelines,
    )[0];

    if (!firstResult) {
      throw new Error("预期至少检索到一张指导卡片");
    }

    const expandedResults = expandGuidanceResults(
      [firstResult, firstResult],
      handbookGuidelines,
      handbookGuidelineLinks,
    );

    const guidelineIds = expandedResults.map(
      (result) => result.guideline.id,
    );

    expect(new Set(guidelineIds).size).toBe(guidelineIds.length);
  });

  //验证只补充一层关系，不继续扩展第二层
    it("只补充一层关系，不继续扩展第二层", () => {
    const searchResults = searchGuidelines(
      "活动还没有通过二课审批，可以先开始举办吗？",
      handbookGuidelines,
    ).slice(0, 1);

    const expandedResults = expandGuidanceResults(
      searchResults,
      handbookGuidelines,
      handbookGuidelineLinks,
    );

    const titles = expandedResults.map(
      (result) => result.guideline.title,
    );

    expect(titles).toContain("大型赛事四阶段筹备流程");
    expect(titles).not.toContain("活动前确认预算与支出边界");
  });
  //验证关联卡片数量上限
    it("限制补充的关联卡片数量", () => {
    const searchResults = searchGuidelines(
      "活动还没有通过二课审批，可以先开始举办吗？",
      handbookGuidelines,
    ).slice(0, 1);

    const expandedResults = expandGuidanceResults(
      searchResults,
      handbookGuidelines,
      handbookGuidelineLinks,
      { maxRelatedItems: 1 },
    );

    const relatedResults = expandedResults.filter(
      (result) => result.source === "relation",
    );

    expect(relatedResults).toHaveLength(1);
  });
});