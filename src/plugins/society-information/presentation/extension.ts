import type { PresentationExtension } from "@sydaris/plugin-sdk";

import { SOCIETY_OVERVIEW_LOADER } from "./constants.js";
import { SOCIETY_INFORMATION_VIEW_KEY } from "../view/schema.js";

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
