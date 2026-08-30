import { defineEchoPlugin } from "@sydaris/plugin-sdk";

import { competitionRecordsPresentation } from "./presentation/extension.js";
import { competitionSeriesCuratorSkill } from "./skill.js";
import {
  competitionToolCapabilityContracts,
} from "./tools/contracts.js";
import {
  competitionEditionProjectionProvider,
} from "./tools/edition-provider.js";
import {
  ustcttaCompetitionSourceProvider,
} from "./tools/source-provider.js";
import { competitionRecordsViewModule } from "./view/schema.js";

export const competitionRecordsPlugin = defineEchoPlugin({
  id: "echo.competition-records",
  version: "0.3.0",
  requires: [{
    pluginId: "echo.society-information",
    versions: "^1.10.0",
  }],
  contributes: {
    views: [competitionRecordsViewModule],
    presentations: [competitionRecordsPresentation],
    skills: [competitionSeriesCuratorSkill],
    toolCapabilities: competitionToolCapabilityContracts,
    tools: [ustcttaCompetitionSourceProvider, competitionEditionProjectionProvider],
  },
});
