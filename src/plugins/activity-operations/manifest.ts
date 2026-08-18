import type { EchoPluginManifest } from "@/contracts";
import { activityOperationsViewModule } from "@/plugins/activity-operations/view/schema";

export const activityOperationsPlugin: EchoPluginManifest = {
  id: "echo.activity-operations",
  version: "1.0.0",
  contributes: {
    views: [activityOperationsViewModule],
  },
};
