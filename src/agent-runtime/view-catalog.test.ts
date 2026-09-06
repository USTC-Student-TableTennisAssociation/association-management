import { describe, expect, it } from "vitest";

import {
  buildViewCatalogContext,
  createViewCatalog,
} from "@/agent-runtime/view-catalog";
import { activityOperationsPlugin } from "@/plugins/activity-operations/manifest";
import { competitionRecordsPlugin } from "@/plugins/competition-records/manifest";
import { societyInformationPlugin } from "@/plugins/society-information/manifest";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";

describe("View Catalog", () => {
  it("publishes authoritative definitions without exposing Command contracts", () => {
    const registry = new ExtensionRegistry();
    registry.registerPlugin(activityOperationsPlugin);
    registry.registerPlugin(societyInformationPlugin);
    registry.registerPlugin(competitionRecordsPlugin);

    const catalog = createViewCatalog(registry);
    const context = buildViewCatalogContext(registry);

    expect(catalog).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "activity_operations",
        cardTypes: expect.arrayContaining([
          expect.objectContaining({ key: "ActivityCard" }),
        ]),
        aiWriteCapabilities: expect.arrayContaining([
          expect.stringContaining("具体活动"),
        ]),
      }),
    ]));
    expect(context).toContain("权威静态定义");
    expect(context).toContain("直接依据本 Catalog 回答");
    expect(context).toContain("不要调用业务状态读取工具");
    expect(context).toContain("适用任务");
    expect(context).toContain("准备负责、筹办、举办或推进一次真实活动");
    expect(context).toContain("AI 可提议");
    expect(context).toContain("AI 不能直接创建或修改届次");
    expect(context).toContain("ActivityCard");
    expect(context).not.toContain("activity.create_activity");
  });
});
