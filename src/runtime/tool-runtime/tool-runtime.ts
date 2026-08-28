import type {
  ToolCapabilityContract,
  ToolCapabilityRequirement,
  ToolContext,
  ToolProviderExtension,
} from "@/contracts";
import { isVersionCompatible } from "@sydaris/plugin-sdk";

export class ToolRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRuntimeError";
  }
}

const forbiddenContractKeys = [
  "inputSchema",
  "outputSchema",
  "semanticContract",
  "sideEffect",
  "allowedCallers",
  "requiredPermissions",
] as const;

export class ToolRuntime {
  private readonly contracts = new Map<string, ToolCapabilityContract>();
  private readonly providers = new Map<string, ToolProviderExtension>();

  registerContract(contract: ToolCapabilityContract): void {
    const key = this.contractKey(contract.key, contract.version);
    if (this.contracts.has(key)) {
      throw new ToolRuntimeError(`Capability Contract 已注册：${key}`);
    }
    this.contracts.set(key, contract);
  }

  registerProvider(provider: ToolProviderExtension): void {
    if (this.providers.has(provider.id)) {
      throw new ToolRuntimeError(`Tool Provider 已注册：${provider.id}`);
    }
    const implementations = new Set<string>();
    for (const implementation of provider.implementations) {
      for (const key of forbiddenContractKeys) {
        if (key in implementation) {
          throw new ToolRuntimeError(
            `Provider ${provider.id} 不能重新声明 Capability ${key}`,
          );
        }
      }
      const contractKey = this.contractKey(
        implementation.capability.key,
        implementation.capability.version,
      );
      if (!this.contracts.has(contractKey)) {
        throw new ToolRuntimeError(
          `Provider ${provider.id} 实现了未注册的 Capability Contract：${contractKey}`,
        );
      }
      if (implementations.has(contractKey)) {
        throw new ToolRuntimeError(`Provider ${provider.id} 重复实现 ${contractKey}`);
      }
      implementations.add(contractKey);
    }
    this.providers.set(provider.id, provider);
  }

  listContracts(): readonly ToolCapabilityContract[] {
    return [...this.contracts.values()];
  }

  getContract(key: string, version: string): ToolCapabilityContract | undefined {
    return this.contracts.get(this.contractKey(key, version));
  }

  listProviders(): readonly ToolProviderExtension[] {
    return [...this.providers.values()];
  }

  assertRequirementsAvailable(
    requirements: readonly ToolCapabilityRequirement[],
  ): void {
    for (const requirement of requirements) {
      const available = [...this.contracts.values()].some((contract) =>
        contract.key === requirement.key &&
        isVersionCompatible(contract.version, requirement.versions) &&
        [...this.providers.values()].some((provider) =>
          provider.implementations.some((implementation) =>
            implementation.capability.key === contract.key &&
            implementation.capability.version === contract.version
          )
        )
      );
      if (!available) {
        throw new ToolRuntimeError(
          `Skill 所需 Capability 不可用：${requirement.key}@${requirement.versions}`,
        );
      }
    }
  }

  async execute(input: {
    capabilityKey: string;
    capabilityVersion: string;
    providerId: string;
    context: ToolContext;
    value: unknown;
  }): Promise<unknown> {
    const key = this.contractKey(input.capabilityKey, input.capabilityVersion);
    const contract = this.contracts.get(key);
    if (!contract) throw new ToolRuntimeError(`Capability Contract 不存在：${key}`);
    if (!contract.allowedCallers.includes(input.context.caller.kind)) {
      throw new ToolRuntimeError(
        `${key} 不允许 ${input.context.caller.kind} 调用`,
      );
    }
    const provider = this.providers.get(input.providerId);
    if (!provider) throw new ToolRuntimeError(`Tool Provider 不存在：${input.providerId}`);
    const implementation = provider.implementations.find(
      (candidate) => this.contractKey(
        candidate.capability.key,
        candidate.capability.version,
      ) === key,
    );
    if (!implementation) {
      throw new ToolRuntimeError(`Provider ${provider.id} 没有实现 ${key}`);
    }
    const missingPermissions = contract.requiredPermissions.filter(
      (permission) => !input.context.permissions.includes(permission),
    );
    if (missingPermissions.length) {
      throw new ToolRuntimeError(`缺少 Tool 权限：${missingPermissions.join(", ")}`);
    }
    if (input.context.dryRun && !contract.supportsDryRun) {
      throw new ToolRuntimeError(`${key} 不支持 dry run`);
    }
    const parsedInput = contract.inputSchema.parse(input.value);
    const output = await implementation.execute(input.context, parsedInput);
    return contract.outputSchema.parse(output);
  }

  private contractKey(key: string, version: string): string {
    return `${key}@${version}`;
  }
}
