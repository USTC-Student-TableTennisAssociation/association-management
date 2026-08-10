import { describe, expect, it } from "vitest";

import { handbookGuidelines } from "../../../prisma/handbook-guidance.data";
import { searchGuidelines } from "./guidance-search";

describe("指导层检索", () => {
    it("把大型赛事二课申请规则排在第一位", () => {
        const results = searchGuidelines(
            "大型赛事只剩 5 天了，我还没提交二课申请，怎么办？",
            handbookGuidelines,
        );

        expect(results[0]?.guideline.title).toBe(
            "大型赛事：活动前至少 7 天提交二课申请",
        );
    });

    it("把未审批不得开展活动的规则排在第一位", () => {
        const results = searchGuidelines(
            "活动还没有通过二课审批，可以先开始举办吗？",
            handbookGuidelines,
        );

        expect(results[0]?.guideline.title).toBe(
            "无二课审批不开展活动",
        );
    });

    it("能检索到常规活动三天前申报规则", () => {
        const results = searchGuidelines(
            "普通训练活动应该提前几天在系统中申报？",
            handbookGuidelines,
        );

        expect(results[0]?.guideline.title).toBe(
            "常规活动：活动前 3 天完成系统申报",
        );
    });

    it("聚餐问题能检索到预算与支出边界", () => {
        const results = searchGuidelines(
            "社团定期聚餐应该去哪个餐厅？",
            handbookGuidelines,
        );

        expect(results[0]?.guideline.title).toBe(
            "活动前确认预算与支出边界",
        );
    });

    it("对指导层无法回答的问题不返回结果", () => {
        const results = searchGuidelines(
            "明天合肥会不会下雨？",
            handbookGuidelines,
        );

        expect(results).toEqual([]);
    });

});