import type {
  EchoPluginManifest,
  ExtensionActivation,
  ExtensionKind,
  PresentationExtension,
  SkillExtension,
  ToolProviderExtension,
  ViewModule,
} from "@/contracts";

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

function validateViewModule(view: ViewModule): void {
  requireIdentifier("View key", view.manifest.key);
  requireSemver(`View ${view.manifest.key} version`, view.manifest.version);
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
  assertUnique(view.commands.map((command) => command.key), "Command key", view.manifest.key);
  assertUnique(view.invariants.map((invariant) => invariant.key), "Invariant key", view.manifest.key);
  assertUnique(view.events.map((event) => `${event.key}@${event.version}`), "Event key/version", view.manifest.key);

  const cardTypeKeys = new Set(view.schema.cardTypes.map((card) => card.key));
  for (const card of view.schema.cardTypes) {
    requireSchemaIdentifier(`Card Type key (${view.manifest.key})`, card.key);
    assertUnique(card.dimensions.map((dimension) => dimension.key), "Dimension key", card.key);
    assertUnique(card.slots.map((slot) => slot.key), "Slot key", card.key);
    for (const dimension of card.dimensions) {
      requireSchemaIdentifier(`Dimension key (${card.key})`, dimension.key);
    }
    for (const slot of card.slots) {
      requireSchemaIdentifier(`Slot key (${card.key})`, slot.key);
      const unknownTargets = slot.allowedTargetCardTypes.filter((target) => !cardTypeKeys.has(target));
      if (unknownTargets.length) {
        throw new ExtensionRegistrationError(
          `${view.manifest.key}.${card.key}.${slot.key} 引用了未声明的同 View Card Type：${unknownTargets.join(", ")}`,
        );
      }
    }
    const policy = card.relatedObjects;
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
}

type Registered<T> = {
  pluginId: string;
  pluginVersion: string;
  extension: T;
};

export class ExtensionRegistry {
  private readonly plugins = new Map<string, EchoPluginManifest>();
  private readonly views = new Map<string, Registered<ViewModule>>();
  private readonly presentations = new Map<string, Registered<PresentationExtension>>();
  private readonly skills = new Map<string, Registered<SkillExtension>>();
  private readonly tools = new Map<string, Registered<ToolProviderExtension>>();
  private readonly activations = new Map<string, ExtensionActivation>();

  registerPlugin(plugin: EchoPluginManifest): void {
    requireIdentifier("Plugin id", plugin.id);
    requireSemver(`Plugin ${plugin.id} version`, plugin.version);
    if (this.plugins.has(plugin.id)) {
      throw new ExtensionRegistrationError(`Plugin 已注册：${plugin.id}`);
    }

    const additions: Array<{
      kind: ExtensionKind;
      id: string;
      extension: ViewModule | PresentationExtension | SkillExtension | ToolProviderExtension;
    }> = [];
    for (const view of plugin.contributes.views ?? []) {
      validateViewModule(view);
      additions.push({ kind: "view", id: view.manifest.key, extension: view });
    }
    for (const presentation of plugin.contributes.presentations ?? []) {
      requireIdentifier("Presentation id", presentation.id);
      requireSemver(`Presentation ${presentation.id} version`, presentation.version);
      additions.push({ kind: "presentation", id: presentation.id, extension: presentation });
    }
    for (const skill of plugin.contributes.skills ?? []) {
      requireIdentifier("Skill id", skill.id);
      requireSemver(`Skill ${skill.id} version`, skill.version);
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
    for (const addition of additions) {
      const registered = {
        pluginId: plugin.id,
        pluginVersion: plugin.version,
        extension: addition.extension,
      };
      this.registryFor(addition.kind).set(addition.id, registered as never);
      this.activations.set(`${addition.kind}:${addition.id}`, {
        extensionId: addition.id,
        extensionKind: addition.kind,
        pluginId: plugin.id,
        pluginVersion: plugin.version,
        enabled: true,
      });
    }
  }

  listPlugins(): readonly EchoPluginManifest[] {
    return [...this.plugins.values()];
  }

  listViews(options: { includeDisabled?: boolean } = {}): readonly ViewModule[] {
    return this.list(this.views, "view", options);
  }

  getView(viewKey: string, options: { includeDisabled?: boolean } = {}): ViewModule | undefined {
    return this.get(this.views, "view", viewKey, options);
  }

  getViewOwner(viewKey: string): { pluginId: string; pluginVersion: string } | undefined {
    const registered = this.views.get(viewKey);
    return registered
      ? { pluginId: registered.pluginId, pluginVersion: registered.pluginVersion }
      : undefined;
  }

  listPresentations(options: { includeDisabled?: boolean } = {}): readonly PresentationExtension[] {
    return this.list(this.presentations, "presentation", options);
  }

  listSkills(options: { includeDisabled?: boolean } = {}): readonly SkillExtension[] {
    return this.list(this.skills, "skill", options);
  }

  listToolProviders(options: { includeDisabled?: boolean } = {}): readonly ToolProviderExtension[] {
    return this.list(this.tools, "tool", options);
  }

  setEnabled(kind: ExtensionKind, extensionId: string, enabled: boolean): void {
    const key = `${kind}:${extensionId}`;
    const activation = this.activations.get(key);
    if (!activation) throw new ExtensionRegistrationError(`Extension 不存在：${key}`);
    this.activations.set(key, { ...activation, enabled });
  }

  listActivations(): readonly ExtensionActivation[] {
    return [...this.activations.values()];
  }

  private registryFor(kind: ExtensionKind): Map<string, Registered<never>> {
    if (kind === "view") return this.views as Map<string, Registered<never>>;
    if (kind === "presentation") return this.presentations as Map<string, Registered<never>>;
    if (kind === "skill") return this.skills as Map<string, Registered<never>>;
    return this.tools as Map<string, Registered<never>>;
  }

  private get<T>(
    registry: Map<string, Registered<T>>,
    kind: ExtensionKind,
    id: string,
    options: { includeDisabled?: boolean },
  ): T | undefined {
    const registered = registry.get(id);
    if (!registered) return undefined;
    if (!options.includeDisabled && !this.activations.get(`${kind}:${id}`)?.enabled) return undefined;
    return registered.extension;
  }

  private list<T>(
    registry: Map<string, Registered<T>>,
    kind: ExtensionKind,
    options: { includeDisabled?: boolean },
  ): T[] {
    return [...registry.entries()].flatMap(([id, registered]) =>
      options.includeDisabled || this.activations.get(`${kind}:${id}`)?.enabled
        ? [registered.extension]
        : []
    );
  }
}
