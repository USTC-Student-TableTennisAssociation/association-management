import type { PresentationExtension } from "@sydaris/plugin-sdk";

export const competitionRecordsPresentation: PresentationExtension = {
  id: "echo.competition-records.presentation",
  version: "0.1.0",
  targetView: "competition_records",
  schemaVersion: "1",
  presentations: [{
    key: "workspace",
    label: "赛事数据工作区",
    loader: "competition-records/workspace",
  }],
};
