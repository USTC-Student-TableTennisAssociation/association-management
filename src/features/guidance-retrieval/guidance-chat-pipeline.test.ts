import { describe, expect, it } from "vitest";

import {
  handbookGuidelineLinks,
  handbookGuidelines,
} from "../../../prisma/handbook-guidance.data";
import { buildGuidanceChatContext } from "./guidance-chat-pipeline";

describe("聊天指导上下文流水线", () => {
  it("检索问题、补充关联卡片并标记草稿权威性", () => {
    const context = buildGuidanceChatContext(
      "活动还没有通过二课审批，可以先开始举办吗？",
      handbookGuidelines,
      handbookGuidelineLinks,
      {
        maxSearchItems: 1,
        maxRelatedItems: 10,
        maxContextItems: 10,
      },
    );

    const titles = context.map((item) => item.title);

    expect(titles).toContain("无二课审批不开展活动");
    expect(titles).toContain(
      "大型赛事：活动前至少 7 天提交二课申请",
    );
    expect(titles).toContain(
      "常规活动：活动前 3 天完成系统申报",
    );

    expect(
      context.every(
        (item) => item.authority === "pending_confirmation",
      ),
    ).toBe(true);
  });
});
//这个测试同时检查：用户问题能找到核心卡片；关系扩展能补充相关申报卡片；草稿卡片同时被标记为待确认。