import { describe, expect, it } from "vitest";

import { buildViewOrientationContext } from "@/agent-runtime/view-orientation";
import { activityOperationsPlugin } from "@/plugins/activity-operations/manifest";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";

describe("Business View Compass", () => {
  it("uses the View-provided retrieval description without exposing Commands", () => {
    const registry = new ExtensionRegistry();
    registry.registerPlugin(activityOperationsPlugin);

    const context = buildViewOrientationContext(registry);

    expect(context).toContain(activityOperationsPlugin.contributes.views![0]
      .manifest.retrievalDescription);
    expect(context).not.toContain("公开操作");
    expect(context).not.toContain("activity.create_activity");
  });
});
