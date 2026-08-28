import type { EchoPluginManifest } from "@/contracts";
import { competitionRecordsPresentation } from "@/plugins/competition-records/presentation/extension";
import { competitionSeriesCuratorSkill } from "@/plugins/competition-records/skill";
import {
  competitionToolCapabilityContracts,
} from "@/plugins/competition-records/tools/contracts";
import {
  competitionEditionProjectionProvider,
} from "@/plugins/competition-records/tools/edition-provider";
import {
  ustcttaCompetitionSourceProvider,
} from "@/plugins/competition-records/tools/source-provider";
import { competitionRecordsViewModule } from "@/plugins/competition-records/view/schema";

export const competitionRecordsPlugin: EchoPluginManifest = {
  id: "echo.competition-records",
  version: "0.1.0",
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
};
