import type { ContractSchema } from "@/contracts/schema";
import type { ToolCapabilityRequirement } from "@/contracts/tool";
import type { ViewKey } from "@/contracts/view";

export interface SkillExtension<Input = unknown> {
  id: string;
  version: string;
  targetView: { viewKey: ViewKey; schemaVersion: string };
  readableViews?: ReadonlyArray<{
    viewKey: ViewKey;
    schemaVersion: string;
  }>;
  requiresCapabilities: readonly ToolCapabilityRequirement[];
  inputSchema: ContractSchema<Input>;
}
