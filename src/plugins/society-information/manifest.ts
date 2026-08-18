import type { EchoPluginManifest } from "@/contracts";
import { societyInformationViewModule } from "@/plugins/society-information/view/schema";

export const societyInformationPlugin: EchoPluginManifest = {
  id: "echo.society-information",
  version: "1.0.0",
  contributes: { views: [societyInformationViewModule] },
};
