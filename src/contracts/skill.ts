import type { ContractSchema } from "@/contracts/schema";
import type { ToolCapabilityRequirement } from "@/contracts/tool";
import type { VersionRange, ViewKey } from "@/contracts/view";

export interface SkillExtension<Input = unknown> {
  id: string;
  version: string;
  targetView: { viewKey: ViewKey; moduleVersions: VersionRange };
  readableViews?: ReadonlyArray<{
    viewKey: ViewKey;
    moduleVersions: VersionRange;
  }>;
  requiresCapabilities: readonly ToolCapabilityRequirement[];
  inputSchema: ContractSchema<Input>;
}
