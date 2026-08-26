import type { EchoPluginManifest } from "@/contracts";
import { societyOverviewPresentation } from "@/plugins/society-information/presentation/extension";
import { societyInformationViewModule } from "@/plugins/society-information/view/schema";

export const societyInformationPlugin: EchoPluginManifest = {
  id: "echo.society-information",
  version: "1.7.0",
  contributes: {
    views: [societyInformationViewModule],
    presentations: [societyOverviewPresentation],
  },
};
