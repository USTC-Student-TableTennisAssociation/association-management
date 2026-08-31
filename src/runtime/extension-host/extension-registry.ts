import type {
  PluginManifest,
  PresentationExtension,
  SkillExtension,
  ToolCapabilityContract,
  ToolProviderExtension,
  ViewModule,
  ViewChangePolicy,
} from "@/contracts";
import { isVersionCompatible } from "@sydaris/plugin-sdk";

type ExtensionKind = "view" | "presentation" | "skill" | "tool";

const identifierPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const schemaIdentifierPattern = /^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/;
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export class ExtensionRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionRegistrationError";
  }
}

function requireIdentifier(label: string, value: string): void {
  if (!identifierPattern.test(value)) {
    throw new ExtensionRegistrationError(`${label} 不是合法的稳定标识：${value}`);
  }
}

function requireSemver(label: string, value: string): void {
  if (!semverPattern.test(value)) {
    throw new ExtensionRegistrationError(`${label} 必须是 SemVer：${value}`);
  }
}

function requireSchemaIdentifier(label: string, value: string): void {
  if (!schemaIdentifierPattern.test(value)) {
    throw new ExtensionRegistrationError(`${label} 不是合法的 Schema 标识：${value}`);
  }
}

function assertUnique(
  values: readonly string[],
  label: string,
  owner: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new ExtensionRegistrationError(`${owner} 中存在重复的 ${label}：${value}`);
    }
    seen.add(value);
  }
}

function validateChangePolicy(label: string, policy: ViewChangePolicy | undefined): void {
  if (!policy) return;
  if (!["never", "evaluate", "always"].includes(policy.attention)) {
    throw new ExtensionRegistrationError(`${label}.changePolicy.attention 不合法`);
  }
  if (policy.knowledge !== undefined && !["none", "reconcile"].includes(policy.knowledge)) {
    throw new ExtensionRegistrationError(`${label}.changePolicy.knowledge 不合法`);
  }
  if (policy.timing !== undefined && !["immediate", "after_settle"].includes(policy.timing)) {
    throw new ExtensionRegistrationError(`${label}.changePolicy.timing 不合法`);
  }
  if (
    policy.settleMs !== undefined &&
    (!Number.isSafeInteger(policy.settleMs) || policy.settleMs < 0 || policy.settleMs > 300_000)
  ) {
    throw new ExtensionRegistrationError(`${label}.changePolicy.settleMs 不合法`);
  }
  if (policy.guidance !== undefined && !policy.guidance.trim()) {
    throw new ExtensionRegistrationError(`${label}.changePolicy.guidance 不能为空`);
  }
  if ((policy.guidance?.length ?? 0) > 2_000) {
    throw new ExtensionRegistrationError(`${label}.changePolicy.guidance 不能超过 2000 字符`);
  }
}

function validateViewModule(view: ViewModule): void {
  requireIdentifier("View key", view.manifest.key);
  if (view.schema.viewKey !== view.manifest.key) {
    throw new ExtensionRegistrationError(
      `View ${view.manifest.key} 的 schema.viewKey 不一致：${view.schema.viewKey}`,
    );
  }
  if (view.schema.schemaVersion !== view.manifest.schemaVersion) {
    throw new ExtensionRegistrationError(
      `View ${view.manifest.key} 的 schemaVersion 不一致`,
    );
  }
  assertUnique(view.schema.cardTypes.map((card) => card.key), "Card Type key", view.manifest.key);
  assertUnique(view.queries.map((query) => query.key), "Query key", view.manifest.key);
  assertUnique(view.commands.map((command) => command.key), "Command key", view.manifest.key);
  assertUnique(view.invariants.map((invariant) => invariant.key), "Invariant key", view.manifest.key);
  assertUnique(view.events.map((event) => `${event.key}@${event.version}`), "Event key/version", view.manifest.key);

  const cardTypeKeys = new Set(view.schema.cardTypes.map((card) => card.key));
  for (const query of view.queries) {
    requireIdentifier(`View ${view.manifest.key} Query key`, query.key);
    requireSemver(`View ${view.manifest.key} Query ${query.key} version`, query.version);
    if (!query.label.trim()) {
      throw new ExtensionRegistrationError(
        `View ${view.manifest.key} Query ${query.key} label 不能为空`,
      );
    }
    if (!query.description.trim()) {
      throw new ExtensionRegistrationError(
        `View ${view.manifest.key} Query ${query.key} description 不能为空`,
      );
    }
  }
  for (const command of view.commands) {
    if (command.allowedInitiators.length === 0) {
      throw new ExtensionRegistrationError(
        `Command ${command.key} 必须声明 allowedInitiators`,
      );
    }
    assertUnique(command.allowedInitiators, "allowed initiator", command.key);
    if (command.allowedInitiators.some((initiator) =>
      !["human", "ai", "system"].includes(initiator)
    )) {
      throw new ExtensionRegistrationError(`Command ${command.key} allowedInitiators 不合法`);
    }
  }
  for (const card of view.schema.cardTypes) {
    requireSchemaIdentifier(`Card Type key (${view.manifest.key})`, card.key);
    assertUnique(card.dimensions.map((dimension) => dimension.key), "Dimension key", card.key);
    assertUnique(card.slots.map((slot) => slot.key), "Slot key", card.key);
    validateChangePolicy(`${view.manifest.key}.${card.key}`, card.changePolicy);
    for (const dimension of card.dimensions) {
      requireSchemaIdentifier(`Dimension key (${card.key})`, dimension.key);
      validateChangePolicy(
        `${view.manifest.key}.${card.key}.${dimension.key}`,
        dimension.changePolicy,
      );
    }
    for (const slot of card.slots) {
      requireSchemaIdentifier(`Slot key (${card.key})`, slot.key);
      const unknownTargets = slot.allowedTargetCardTypes.filter((target) => !cardTypeKeys.has(target));
      if (unknownTargets.length) {
        throw new ExtensionRegistrationError(
          `${view.manifest.key}.${card.key}.${slot.key} 引用了未声明的同 View Card Type：${unknownTargets.join(", ")}`,
        );
      }
      validateChangePolicy(
        `${view.manifest.key}.${card.key}.${slot.key}`,
        slot.changePolicy,
      );
    }
    const policy = card.relatedObjects;
    validateChangePolicy(
      `${view.manifest.key}.${card.key}.relatedObjects`,
      policy?.changePolicy,
    );
    if (policy?.min !== undefined && policy.min < 0) {
      throw new ExtensionRegistrationError(`${card.key}.relatedObjects.min 不能小于 0`);
    }
    if (policy?.max !== undefined && policy.max < 0) {
      throw new ExtensionRegistrationError(`${card.key}.relatedObjects.max 不能小于 0`);
    }
    if (
      policy?.min !== undefined && policy.max !== undefined &&
      policy.min > policy.max
    ) {
      throw new ExtensionRegistrationError(`${card.key}.relatedObjects min 不能大于 max`);
    }
    if (policy?.uniqueCardPerObject && policy.max !== 1) {
      throw new ExtensionRegistrationError(
        `${card.key}.relatedObjects.uniqueCardPerObject 只能与 max: 1 一起使用`,
      );
    }
  }
  for (const event of view.events) {
    validateChangePolicy(`${view.manifest.key}.${event.key}.reaction`, event.reaction);
  }
}

function validateSkill(
  skill: SkillExtension,
  availableViews: ReadonlyMap<string, ViewModule>,
): void {
  if (!skill.label.trim()) {
    throw new ExtensionRegistrationError(`Skill ${skill.id} label 不能为空`);
  }
  if (!skill.description.trim()) {
    throw new ExtensionRegistrationError(`Skill ${skill.id} description 不能为空`);
  }
  if (!skill.instructions.trim()) {
    throw new ExtensionRegistrationError(`Skill ${skill.id} instructions 不能为空`);
  }
  if (skill.instructions.length > 20_000) {
    throw new ExtensionRegistrationError(`Skill ${skill.id} instructions 过长`);
  }
  const accessKeys = skill.viewAccess.map((access) => access.viewKey);
  assertUnique(accessKeys, "View access", skill.id);
  for (const access of skill.viewAccess) {
    const view = availableViews.get(access.viewKey);
    if (!view) {
      throw new ExtensionRegistrationError(
        `Skill ${skill.id} 引用了未注册 View：${access.viewKey}`,
      );
    }
    if (view.manifest.schemaVersion !== access.schemaVersion) {
      throw new ExtensionRegistrationError(
        `Skill ${skill.id} 需要 ${access.viewKey} schemaVersion ${access.schemaVersion}，` +
          `当前为 ${view.manifest.schemaVersion}`,
      );
    }
    if (access.mode === "write") {
      if (access.commands.length === 0) {
        throw new ExtensionRegistrationError(
          `Skill ${skill.id} 的可写 View ${access.viewKey} 必须声明 Commands`,
        );
      }
      assertUnique(access.commands, "Command access", `${skill.id}/${access.viewKey}`);
      const commandKeys = new Set(view.commands.map((command) => command.key));
      const unknownCommands = access.commands.filter((command) => !commandKeys.has(command));
      if (unknownCommands.length) {
        throw new ExtensionRegistrationError(
          `Skill ${skill.id} 引用了 ${access.viewKey} 未声明的 Commands：` +
            unknownCommands.join(", "),
        );
      }
      const nonAgentCommands = access.commands.filter((commandKey) =>
        !view.commands.find((command) => command.key === commandKey)
          ?.allowedInitiators.includes("ai")
      );
      if (nonAgentCommands.length) {
        throw new ExtensionRegistrationError(
          `Skill ${skill.id} 引用了不允许 AI 调用的 Commands：` +
            nonAgentCommands.join(", "),
        );
      }
    }
  }
  assertUnique(
    skill.requiresCapabilities.map((requirement) => requirement.key),
    "Capability requirement",
    skill.id,
  );
  for (const requirement of skill.requiresCapabilities) {
    requireIdentifier(`Skill ${skill.id} Capability key`, requirement.key);
    if (!requirement.versions.trim()) {
      throw new ExtensionRegistrationError(
        `Skill ${skill.id} Capability ${requirement.key} 的 versions 不能为空`,
      );
    }
  }
}

function validateToolCapability(contract: ToolCapabilityContract): void {
  requireIdentifier("Tool Capability key", contract.key);
  requireSemver(`Tool Capability ${contract.key} version`, contract.version);
  if (!contract.description.trim()) {
    throw new ExtensionRegistrationError(`Tool Capability ${contract.key} description 不能为空`);
  }
  if (!contract.semanticContract.trim()) {
    throw new ExtensionRegistrationError(
      `Tool Capability ${contract.key} semanticContract 不能为空`,
    );
  }
  if (contract.allowedCallers.length === 0) {
    throw new ExtensionRegistrationError(
      `Tool Capability ${contract.key} 必须声明 allowedCallers`,
    );
  }
  if (contract.allowedCallers.some((caller) =>
    !["view", "automation", "agent"].includes(caller)
  )) {
    throw new ExtensionRegistrationError(
      `Tool Capability ${contract.key} allowedCallers 不合法`,
    );
  }
  assertUnique(contract.allowedCallers, "allowed caller", contract.key);
  assertUnique(contract.requiredPermissions, "required permission", contract.key);
}

type Registered<T> = {
  pluginId: string;
  pluginVersion: string;
  extension: T;
};

export class ExtensionRegistry {
  private readonly plugins = new Map<string, PluginManifest>();
  private readonly views = new Map<string, Registered<ViewModule>>();
  private readonly presentations = new Map<string, Registered<PresentationExtension>>();
  private readonly skills = new Map<string, Registered<SkillExtension>>();
  private readonly toolCapabilities = new Map<string, Registered<ToolCapabilityContract>>();
  private readonly tools = new Map<string, Registered<ToolProviderExtension>>();

  registerPlugin(plugin: PluginManifest): void {
    requireIdentifier("Plugin id", plugin.id);
    requireSemver(`Plugin ${plugin.id} version`, plugin.version);
    if (this.plugins.has(plugin.id)) {
      throw new ExtensionRegistrationError(`Plugin 已注册：${plugin.id}`);
    }
    for (const requirement of plugin.requires ?? []) {
      const installed = this.plugins.get(requirement.pluginId);
      if (!installed) {
        throw new ExtensionRegistrationError(
          `Plugin ${plugin.id} 需要先注册 ${requirement.pluginId}@${requirement.versions}`,
        );
      }
      if (!isVersionCompatible(installed.version, requirement.versions)) {
        throw new ExtensionRegistrationError(
          `Plugin ${plugin.id} 需要 ${requirement.pluginId}@${requirement.versions}，` +
            `当前为 ${installed.version}`,
        );
      }
    }

    const additions: Array<{
      kind: ExtensionKind;
      id: string;
      extension: ViewModule | PresentationExtension | SkillExtension | ToolProviderExtension;
    }> = [];
    const pluginToolCapabilities = plugin.contributes.toolCapabilities ?? [];
    const capabilityKeys = pluginToolCapabilities.map((contract) =>
      `${contract.key}@${contract.version}`
    );
    assertUnique(capabilityKeys, "Tool Capability key/version", plugin.id);
    for (const contract of pluginToolCapabilities) {
      validateToolCapability(contract);
      const key = `${contract.key}@${contract.version}`;
      if (this.toolCapabilities.has(key)) {
        throw new ExtensionRegistrationError(
          `Tool Capability 已由其他 Plugin 注册：${key}`,
        );
      }
    }
    const pluginViews = plugin.contributes.views ?? [];
    const availableViews = new Map<string, ViewModule>([
      ...[...this.views.entries()].map(([viewKey, registered]) =>
        [viewKey, registered.extension] as const
      ),
      ...pluginViews.map((view) => [view.manifest.key, view] as const),
    ]);
    for (const view of pluginViews) {
      validateViewModule(view);
      additions.push({ kind: "view", id: view.manifest.key, extension: view });
    }
    for (const presentation of plugin.contributes.presentations ?? []) {
      requireIdentifier("Presentation id", presentation.id);
      requireSemver(`Presentation ${presentation.id} version`, presentation.version);
      if (!presentation.schemaVersion.trim()) {
        throw new ExtensionRegistrationError(
          `Presentation ${presentation.id} 必须声明目标 schemaVersion`,
        );
      }
      additions.push({ kind: "presentation", id: presentation.id, extension: presentation });
    }
    for (const skill of plugin.contributes.skills ?? []) {
      requireIdentifier("Skill id", skill.id);
      requireSemver(`Skill ${skill.id} version`, skill.version);
      validateSkill(skill, availableViews);
      additions.push({ kind: "skill", id: skill.id, extension: skill });
    }
    for (const tool of plugin.contributes.tools ?? []) {
      requireIdentifier("Tool Provider id", tool.id);
      requireSemver(`Tool Provider ${tool.id} version`, tool.version);
      additions.push({ kind: "tool", id: tool.id, extension: tool });
    }

    assertUnique(additions.map(({ kind, id }) => `${kind}:${id}`), "Extension id", plugin.id);
    for (const addition of additions) {
      const registry = this.registryFor(addition.kind);
      if (registry.has(addition.id)) {
        throw new ExtensionRegistrationError(
          `${addition.kind} Extension 已由其他 Plugin 注册：${addition.id}`,
        );
      }
    }

    this.plugins.set(plugin.id, plugin);
    for (const contract of pluginToolCapabilities) {
      this.toolCapabilities.set(`${contract.key}@${contract.version}`, {
        pluginId: plugin.id,
        pluginVersion: plugin.version,
        extension: contract,
      });
    }
    for (const addition of additions) {
      const registered = {
        pluginId: plugin.id,
        pluginVersion: plugin.version,
        extension: addition.extension,
      };
      this.registryFor(addition.kind).set(addition.id, registered as never);
    }
  }

  listPlugins(): readonly PluginManifest[] {
    return [...this.plugins.values()];
  }

  listViews(): readonly ViewModule[] {
    return [...this.views.values()].map((registered) => registered.extension);
  }

  getView(viewKey: string): ViewModule | undefined {
    return this.views.get(viewKey)?.extension;
  }

  getViewOwner(viewKey: string): { pluginId: string; pluginVersion: string } | undefined {
    const registered = this.views.get(viewKey);
    return registered
      ? { pluginId: registered.pluginId, pluginVersion: registered.pluginVersion }
      : undefined;
  }

  listPresentations(): readonly PresentationExtension[] {
    return [...this.presentations.values()].map((registered) => registered.extension);
  }

  listSkills(): readonly SkillExtension[] {
    return [...this.skills.values()].map((registered) => registered.extension);
  }

  listToolProviders(): readonly ToolProviderExtension[] {
    return [...this.tools.values()].map((registered) => registered.extension);
  }

  listToolCapabilityContracts(): readonly ToolCapabilityContract[] {
    return [...this.toolCapabilities.values()].map((registered) => registered.extension);
  }

  private registryFor(kind: ExtensionKind): Map<string, Registered<never>> {
    if (kind === "view") return this.views as Map<string, Registered<never>>;
    if (kind === "presentation") return this.presentations as Map<string, Registered<never>>;
    if (kind === "skill") return this.skills as Map<string, Registered<never>>;
    return this.tools as Map<string, Registered<never>>;
  }

}
