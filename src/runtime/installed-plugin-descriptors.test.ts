import { describe, expect, it } from "vitest";

import type { PluginManifest } from "@/contracts";
import activityDescriptor from "@/plugins/activity-operations/sydaris.plugin.json";
import { activityOperationsPlugin } from "@/plugins/activity-operations/dist/manifest";
import competitionDescriptor from "@/plugins/competition-records/sydaris.plugin.json";
import { competitionRecordsPlugin } from "@/plugins/competition-records/manifest";
import societyDescriptor from "@/plugins/society-information/sydaris.plugin.json";
import { societyInformationPlugin } from "@/plugins/society-information/dist/manifest";

type Descriptor = {
  id: string;
  version: string;
  contributes: {
    views: string[];
    presentations: Array<{ loader: string }>;
    skills: string[];
    toolCapabilities: string[];
    tools: string[];
  };
};

describe.each([
  [activityDescriptor, activityOperationsPlugin],
  [competitionDescriptor, competitionRecordsPlugin],
  [societyDescriptor, societyInformationPlugin],
] as readonly (readonly [Descriptor, PluginManifest])[])("installed Plugin descriptor", (descriptor, plugin) => {
  it(`${plugin.id} keeps purge ownership and runtime contributions aligned`, () => {
    expect(descriptor.id).toBe(plugin.id);
    expect(descriptor.version).toBe(plugin.version);
    expect(descriptor.contributes.views).toEqual(
      (plugin.contributes.views ?? []).map((view) => view.manifest.key),
    );
    expect(descriptor.contributes.presentations.map((presentation) => presentation.loader)).toEqual(
      (plugin.contributes.presentations ?? []).flatMap((extension) =>
        extension.presentations.map((presentation) => presentation.loader)
      ),
    );
    expect(descriptor.contributes.skills).toEqual(
      (plugin.contributes.skills ?? []).map((skill) => skill.id),
    );
    expect(descriptor.contributes.toolCapabilities).toEqual(
      (plugin.contributes.toolCapabilities ?? []).map((contract) => contract.key),
    );
    expect(descriptor.contributes.tools).toEqual(
      (plugin.contributes.tools ?? []).map((provider) => provider.id),
    );
  });
});
