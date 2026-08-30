import type { PresentationExtension } from "@sydaris/plugin-sdk";

import { ACTIVITY_OPERATIONS_VIEW_KEY } from "../view/schema.js";
import { ACTIVITY_OPERATIONS_LOADER } from "./constants.js";

export const activityOperationsPresentation: PresentationExtension = {
  id: "sydaris.activity-operations.workspace",
  version: "2.0.0",
  targetView: ACTIVITY_OPERATIONS_VIEW_KEY,
  schemaVersion: "3",
  presentations: [{
    key: "workspace",
    label: "活动方法与任务版图",
    loader: ACTIVITY_OPERATIONS_LOADER,
  }],
};
