import { defineEchoPlugin } from "@sydaris/plugin-sdk";

import { societyOverviewPresentation } from "./presentation/extension.js";
import { societyInformationViewModule } from "./view/schema.js";

export const societyInformationPlugin = defineEchoPlugin({
  id: "echo.society-information",
  version: "1.8.0",
  contributes: {
    views: [societyInformationViewModule],
    presentations: [societyOverviewPresentation],
    skills: [],
    tools: [],
  },
});
