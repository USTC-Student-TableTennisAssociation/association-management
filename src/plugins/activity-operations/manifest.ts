import { definePlugin } from "@sydaris/plugin-sdk";

import { activityOperationsPresentation } from "./presentation/extension.js";
import {
  activityPlaybookDesignerSkill,
  activityTaskMapPlannerSkill,
} from "./skill.js";
import { activityOperationsViewModule } from "./view/schema.js";

export const activityOperationsPlugin = definePlugin({
  id: "sydaris.activity-operations",
  version: "1.3.1",
  contributes: {
    views: [activityOperationsViewModule],
    presentations: [activityOperationsPresentation],
    skills: [activityPlaybookDesignerSkill, activityTaskMapPlannerSkill],
    tools: [],
  },
});
