export const libraryProcessingCatalog = {
  version: "library-processing-catalog.v1",
  stateDimensions: {
    profile:
      "选择的处理深度；它不表示任务已经执行，也不表示结果已经发布。",
    status:
      "执行状态：idle 表示尚未开始，queued/running 表示处理中，ready 表示本次处理完成，failed 表示失败。",
    publication:
      "发布状态独立于 profile/status；只有 publishedAt 或 publishedContents 明确存在时，结果才已进入 Shared Brain。",
  },
  profiles: {
    catalog: {
      label: "仅归档语义编目",
      purpose: "低成本保留文件并建立轻量语义导航。",
      outputs: ["Reference Assertion", "Object 导航候选"],
      groundedAssertions: false,
      sourceDocument: false,
    },
    coarse: {
      label: "粗编译",
      purpose: "按文档主题建立导航，并提取可脱离原文语境使用的重要事实。",
      outputs: ["Reference Assertion", "Grounded Assertion", "Object"],
      groundedAssertions: true,
      sourceDocument: false,
    },
    deep: {
      label: "深度冷启动",
      purpose: "保留完整来源结构并执行深入语义编译与 Global Object 归并。",
      outputs: ["Source Document", "结构化 Source Region", "Grounded Assertion", "Global Object"],
      groundedAssertions: true,
      sourceDocument: true,
    },
  },
  workflow: {
    compilationSelection: "每份唯一内容独立选择 catalog、coarse 或 deep；不是从 catalog 依次升级到 deep。",
    publication: "成功编译并完成 Global Object 归并后发布到 Shared Brain。",
    businessViews:
      "Worker 不直接写入 Business View；正式业务状态必须通过目标 View 的 Domain Command、Proposal 和用户审批建立或更新。",
  },
} as const;

export function libraryProcessingCatalogInstruction(): string {
  const catalog = libraryProcessingCatalog;
  return [
    "【Library Processing Catalog（权威运行时定义）】",
    `profile：${catalog.stateDimensions.profile}`,
    `status：${catalog.stateDimensions.status}`,
    `publication：${catalog.stateDimensions.publication}`,
    `catalog（${catalog.profiles.catalog.label}）：${catalog.profiles.catalog.purpose} 可形成 ${catalog.profiles.catalog.outputs.join("、")}；不提取 Grounded Assertion。`,
    `coarse（${catalog.profiles.coarse.label}）：${catalog.profiles.coarse.purpose} 可形成 ${catalog.profiles.coarse.outputs.join("、")}。`,
    `deep（${catalog.profiles.deep.label}）：${catalog.profiles.deep.purpose} 可形成 ${catalog.profiles.deep.outputs.join("、")}。`,
    catalog.workflow.compilationSelection,
    catalog.workflow.publication,
    catalog.workflow.businessViews,
    "不得只根据 profile 判断是否处理或发布；必须同时检查 status 与 publishedAt/publishedContents。",
  ].join("\n");
}
