import { describe, expect, it } from "vitest";

import activityDescriptor from "@/plugins/activity-operations/echo.plugin.json";
import { activityOperationsPlugin } from "@/plugins/activity-operations/manifest";
import societyDescriptor from "@/plugins/society-information/echo.plugin.json";
import { societyInformationPlugin } from "@/plugins/society-information/manifest";

describe.each([
  [activityDescriptor, activityOperationsPlugin],
  [societyDescriptor, societyInformationPlugin],
] as const)("installed Plugin descriptor", (descriptor, plugin) => {
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
    expect(descriptor.contributes.tools).toEqual(
      (plugin.contributes.tools ?? []).map((provider) => provider.id),
    );
  });
});
