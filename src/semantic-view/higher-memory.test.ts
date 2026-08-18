import { describe, expect, it } from "vitest";

import { viewHigherMemoryQualityIssue } from "@/semantic-view/higher-memory";

describe("viewHigherMemoryQualityIssue", () => {
  it("rejects repeated corruption", () => {
    const repeated = Array.from(
      { length: 8 },
      () => "重建后的 View Higher Memory 不应重复写入相同内容。",
    ).join("\n");
    expect(viewHigherMemoryQualityIssue(repeated)).toMatch(/重复/);
  });

  it("accepts a concise three-part summary", () => {
    const summary = [
      "## 已有正式内容",
      "活动运营已记录长期活动与对应负责人。",
      "## 明显空白",
      "部分场地申请节点尚缺少当前联系人。",
      "## 时间边界",
      "具体安排会随学期变化，执行前需要核对最新状态。",
    ].join("\n\n");
    expect(viewHigherMemoryQualityIssue(summary)).toBeUndefined();
  });
});
