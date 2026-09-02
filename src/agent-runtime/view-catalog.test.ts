import { describe, expect, it } from "vitest";

import {
  buildViewCatalogContext,
  createViewCatalog,
} from "@/agent-runtime/view-catalog";
import { activityOperationsPlugin } from "@/plugins/activity-operations/manifest";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";

describe("View Catalog", () => {
  it("publishes authoritative definitions without exposing Command contracts", () => {
    const registry = new ExtensionRegistry();
    registry.registerPlugin(activityOperationsPlugin);

    const catalog = createViewCatalog(registry);
    const context = buildViewCatalogContext(registry);

    expect(catalog).toEqual([
      expect.objectContaining({
        key: "activity_operations",
        cardTypes: expect.arrayContaining([
          expect.objectContaining({ key: "ActivityCard" }),
        ]),
      }),
    ]);
    expect(context).toContain("权威静态定义");
    expect(context).toContain("直接依据本 Catalog 回答");
    expect(context).toContain("不要调用业务状态读取工具");
    expect(context).toContain("ActivityCard");
    expect(context).not.toContain("activity.create_activity");
  });
});
