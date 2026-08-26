import type { PresentationExtension } from "@/contracts";
import { SOCIETY_OVERVIEW_LOADER } from "@/plugins/society-information/presentation/constants";
import { SOCIETY_INFORMATION_VIEW_KEY } from "@/plugins/society-information/view/schema";

export const societyOverviewPresentation: PresentationExtension = {
  id: "echo.society-information.overview",
  version: "1.4.0",
  targetView: SOCIETY_INFORMATION_VIEW_KEY,
  schemaVersion: "5",
  presentations: [{
    key: "overview",
    label: "沉浸式社团概览",
    loader: SOCIETY_OVERVIEW_LOADER,
  }],
};
