import { defineEchoPlugin } from "@sydaris/plugin-sdk";

import { activityOperationsPresentation } from "./presentation/extension.js";
import {
  activityPlaybookDesignerSkill,
  activityTaskMapPlannerSkill,
} from "./skill.js";
import { activityOperationsViewModule } from "./view/schema.js";

export const activityOperationsPlugin = defineEchoPlugin({
  id: "echo.activity-operations",
  version: "1.3.0",
  contributes: {
    views: [activityOperationsViewModule],
    presentations: [activityOperationsPresentation],
    skills: [activityPlaybookDesignerSkill, activityTaskMapPlannerSkill],
    tools: [],
  },
});
