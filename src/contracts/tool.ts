import type { ContractSchema } from "@/contracts/schema";
import type { SemVer, VersionRange } from "@/contracts/view";

export type ToolCapabilityKey = string;

export interface ToolCapabilityContract<Input = unknown, Output = unknown> {
  key: ToolCapabilityKey;
  version: SemVer;
  description: string;
  semanticContract: string;
  inputSchema: ContractSchema<Input>;
  outputSchema: ContractSchema<Output>;
  sideEffect: "none" | "reversible" | "external_irreversible";
  requiredPermissions: readonly string[];
  supportsDryRun?: boolean;
}

export interface ToolCapabilityRequirement {
  key: ToolCapabilityKey;
  versions: VersionRange;
}

export interface ToolContext {
  actorId?: string;
  permissions: readonly string[];
  dryRun?: boolean;
}

export interface ToolCapabilityImplementation {
  capability: {
    key: ToolCapabilityKey;
    version: SemVer;
  };
  execute(context: ToolContext, input: unknown): Promise<unknown>;
}

export interface ToolProviderExtension {
  id: string;
  version: SemVer;
  implementations: readonly ToolCapabilityImplementation[];
}
