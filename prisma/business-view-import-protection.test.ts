import { describe, expect, it } from "vitest";

import { protectedBusinessViewImportMessage } from "./business-view-import-protection";

describe("cold-start Business View protection", () => {
  it("allows replacement when no Business View state exists", () => {
    expect(protectedBusinessViewImportMessage([])).toBeUndefined();
  });

  it("explains why formal Views and Proposals block Compilation replacement", () => {
    expect(protectedBusinessViewImportMessage([
      { viewKey: "society_information", cardCount: 14 },
    ], 8)).toBe(
      "数据库中已有正式 Business View：society_information (14 张正式 Card)；8 条 Business View Proposal。" +
        "cold-start 导入会替换整个 Shared Brain Compilation，当前禁止直接覆盖；" +
        "请先完成 Business View 状态到新 Compilation 的迁移或明确清理这些状态。",
    );
  });

  it("also protects Proposal-only state", () => {
    expect(protectedBusinessViewImportMessage([], 2)).toContain(
      "2 条 Business View Proposal",
    );
  });
});
