import { z } from "zod";
import semver from "semver";

export const ECHO_PLUGIN_API_VERSION = "0.1.0-alpha.6";
export const ECHO_PLUGIN_DESCRIPTOR_SCHEMA_VERSION = 1;

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ContractSchema<T = unknown> {
  readonly jsonSchema: JsonSchema;
  parse(value: unknown): T;
}

export function zodContractSchema<T>(schema: z.ZodType<T>): ContractSchema<T> {
  return {
    jsonSchema: z.toJSONSchema(schema) as JsonSchema,
    parse: (value) => schema.parse(value),
  };
}

export type ViewKey = string;
export type CardTypeKey = string;
export type CardId = string;
export type DimensionKey = string;
export type SlotKey = string;
export type ObjectId = string;
export type CommandKey = string;
export type SemVer = string;
export type VersionRange = string;
export type AiWritePolicy = "approval_required" | "auto_execute";
export type ViewReactionAttentionPolicy = "never" | "evaluate" | "always";
export type ViewReactionKnowledgePolicy = "none" | "reconcile";
export type ViewReactionTiming = "immediate" | "after_settle";

export interface ViewChangePolicy {
  /** Whether Echo should evaluate the change and whether the result must be visible. */
  attention: ViewReactionAttentionPolicy;
  /** Whether related Object Higher Memory should be reconciled in the background. */
  knowledge?: ViewReactionKnowledgePolicy;
  /** When background processing starts. Defaults to after_settle. */
  timing?: ViewReactionTiming;
  /** Optional debounce window for after_settle processing. */
  settleMs?: number;
  /** Domain guidance supplied to the Runtime-owned reaction evaluator. */
  guidance?: string;
}

export type ViewReactionAttentionStatus =
  | "not_required"
  | "queued"
  | "running"
  | "silent"
  | "inform"
  | "needs_confirmation"
  | "failed";

export type ViewReactionKnowledgeStatus =
  | "not_required"
  | "queued"
  | "running"
  | "completed"
  | "failed";

export type ViewReactionTarget =
  | { kind: "card"; cardId: CardId; cardTypeKey: CardTypeKey }
  | {
      kind: "dimension";
      cardId: CardId;
      cardTypeKey: CardTypeKey;
      dimensionKey: DimensionKey;
    }
  | {
      kind: "slot";
      cardId: CardId;
      cardTypeKey: CardTypeKey;
      slotKey: SlotKey;
    }
  | { kind: "related_objects"; cardId: CardId; cardTypeKey: CardTypeKey };

export interface EchoViewReaction {
  id: string;
  executionId: string;
  viewKey: ViewKey;
  stateVersion: string;
  targets: readonly ViewReactionTarget[];
  attention: {
    policy: ViewReactionAttentionPolicy;
    status: ViewReactionAttentionStatus;
    message?: string;
    reason?: string;
    completedAt?: string;
  };
  knowledge: {
    policy: ViewReactionKnowledgePolicy;
    status: ViewReactionKnowledgeStatus;
    completedAt?: string;
  };
  seenAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type EchoViewCommandResult =
  | {
      kind: "proposed";
      proposalId: string;
      viewKey: ViewKey;
      stateVersion: string;
    }
  | {
      kind: "executed";
      executionId: string;
      viewKey: ViewKey;
      stateVersion: string;
      summary?: unknown;
      reaction?: Pick<
        EchoViewReaction,
        "id" | "executionId" | "viewKey" | "stateVersion" | "targets" | "attention" | "knowledge" | "createdAt" | "updatedAt"
      >;
    };

export interface ViewSettings {
  aiWritePolicy: AiWritePolicy;
}

export type DimensionType =
  | "text"
  | "rich_text"
  | "integer"
  | "decimal"
  | "boolean"
  | "enum"
  | "date"
  | "datetime"
  | "date_range"
  | "datetime_range"
  | "money";

export interface DimensionDefinition {
  key: DimensionKey;
  label: string;
  description?: string;
  type: DimensionType;
  required?: boolean;
  defaultValue?: unknown;
  constraints?: {
    min?: number | string;
    max?: number | string;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    enumOptions?: ReadonlyArray<{ key: string; label: string }>;
    allowedCurrencies?: readonly string[];
  };
  presentation?: {
    placeholder?: string;
    multiline?: boolean;
    displayFormat?: string;
  };
  changePolicy?: ViewChangePolicy;
}

export interface SlotDefinition {
  key: SlotKey;
  label: string;
  description?: string;
  cardinality: "one" | "many";
  required?: boolean;
  allowedTargetCardTypes: readonly CardTypeKey[];
  changePolicy?: ViewChangePolicy;
}

export interface RelatedObjectPolicy {
  description?: string;
  min?: number;
  max?: number;
  uniqueCardPerObject?: boolean;
  changePolicy?: ViewChangePolicy;
}

export interface CardTypeDefinition {
  key: CardTypeKey;
  label: string;
  description: string;
  dimensions: readonly DimensionDefinition[];
  slots: readonly SlotDefinition[];
  relatedObjects?: RelatedObjectPolicy;
  /** Applies to Card creation and deletion. Dimension and Slot policies override it. */
  changePolicy?: ViewChangePolicy;
}

export interface ViewSchema {
  viewKey: ViewKey;
  schemaVersion: string;
  cardTypes: readonly CardTypeDefinition[];
}

export interface ViewManifest {
  key: ViewKey;
  label: string;
  schemaVersion: string;
  description: string;
  retrievalDescription?: string;
  aiSemanticInstructions?: string;
  specializedLabel?: string;
  defaultSettings: ViewSettings;
}

export interface ActorContext {
  actorId?: string;
  permissions: readonly string[];
}

export interface ViewCardState {
  id: CardId;
  viewKey: ViewKey;
  cardTypeKey: CardTypeKey;
  dimensions: Readonly<Record<DimensionKey, unknown>>;
  slots: Readonly<Record<SlotKey, readonly CardId[]>>;
  relatedObjectIds: readonly ObjectId[];
}

export type ViewChangeValue =
  | { present: false }
  | { present: true; value: unknown };

export type ViewChange =
  | {
      kind: "card_created";
      card: ViewCardState;
    }
  | {
      kind: "card_deleted";
      card: ViewCardState;
    }
  | {
      kind: "dimension";
      cardId: CardId;
      cardTypeKey: CardTypeKey;
      dimensionKey: DimensionKey;
      before: ViewChangeValue;
      after: ViewChangeValue;
    }
  | {
      kind: "slot";
      cardId: CardId;
      cardTypeKey: CardTypeKey;
      slotKey: SlotKey;
      before: readonly CardId[];
      after: readonly CardId[];
    }
  | {
      kind: "related_objects";
      cardId: CardId;
      cardTypeKey: CardTypeKey;
      before: readonly ObjectId[];
      after: readonly ObjectId[];
    };

export interface ViewTransaction {
  getCard(cardId: CardId): Promise<ViewCardState | undefined>;
  queryCards(query?: {
    cardTypeKey?: CardTypeKey;
    relatedObjectId?: ObjectId;
  }): Promise<ViewCardState[]>;
  createCard(input: {
    cardTypeKey: CardTypeKey;
    dimensions?: Readonly<Record<DimensionKey, unknown>>;
    relatedObjectIds?: readonly ObjectId[];
  }): Promise<CardId>;
  deleteCard(cardId: CardId): Promise<void>;
  setDimension(cardId: CardId, key: DimensionKey, value: unknown): Promise<void>;
  clearDimension(cardId: CardId, key: DimensionKey): Promise<void>;
  setSlot(cardId: CardId, key: SlotKey, targets: readonly CardId[]): Promise<void>;
  setRelatedObjects(cardId: CardId, objectIds: readonly ObjectId[]): Promise<void>;
}

export interface ViewCommandContext {
  viewKey: ViewKey;
  actor: ActorContext;
  initiator: "human" | "ai" | "system";
  skillId?: string;
  expectedStateVersion?: string;
  transaction: ViewTransaction;
}

export interface CommandOutcome {
  summary?: unknown;
  events?: readonly { type: string; version: string; payload: unknown }[];
}

export interface CommandInputReferenceDefinition {
  path: readonly string[];
  kind: "card" | "object";
  cardinality?: "one" | "many";
  inferFromCanonicalNamePath?: readonly string[];
}

export type ProposalApprovalConflictPolicy = "exact" | "revalidate_latest";
export type ViewCommandInitiator = "human" | "ai" | "system";

export interface CommandDefinition<Input = unknown> {
  key: CommandKey;
  version: string;
  label: string;
  allowedInitiators: readonly ViewCommandInitiator[];
  requiredPermissions?: readonly string[];
  inputSchema: ContractSchema<Input>;
  inputReferences?: readonly CommandInputReferenceDefinition[];
  proposalApprovalConflictPolicy?(input: Input): ProposalApprovalConflictPolicy;
  execute(context: ViewCommandContext, input: Input): Promise<CommandOutcome>;
}

export interface BusinessInvariant {
  key: string;
  description: string;
  validate(transaction: ViewTransaction): Promise<void>;
}

export interface DomainEventDefinition {
  key: string;
  version: string;
  payloadSchema: ContractSchema;
  /** Event-level reaction policy merged with policies inferred from concrete changes. */
  reaction?: ViewChangePolicy;
}

export interface KnowledgeProjectionDefinition {
  key: string;
  targetCardType: CardTypeKey;
}

export interface ViewModule {
  manifest: ViewManifest;
  schema: ViewSchema;
  commands: readonly CommandDefinition[];
  invariants: readonly BusinessInvariant[];
  events: readonly DomainEventDefinition[];
  projections: readonly KnowledgeProjectionDefinition[];
}

export interface ViewReadSnapshot {
  viewKey: ViewKey;
  pluginVersion: SemVer;
  schemaVersion: string;
  stateVersion: string;
  observedAt: string;
  cards: readonly ViewCardState[];
  references: readonly unknown[];
}

export interface ViewPresentationDefinition {
  key: string;
  label: string;
  loader: string;
}

export interface PresentationExtension {
  id: string;
  version: string;
  targetView: ViewKey;
  schemaVersion: string;
  presentations: readonly ViewPresentationDefinition[];
}

export type ToolCapabilityKey = string;
export type ToolCallerKind = "view" | "automation" | "agent";

export type ToolCaller =
  | { kind: "view"; viewKey: ViewKey }
  | { kind: "automation"; jobKey: string }
  | { kind: "agent"; actorId?: string };

export interface ToolCapabilityContract<Input = unknown, Output = unknown> {
  key: ToolCapabilityKey;
  version: SemVer;
  description: string;
  semanticContract: string;
  inputSchema: ContractSchema<Input>;
  outputSchema: ContractSchema<Output>;
  sideEffect: "none" | "reversible" | "external_irreversible";
  /** Runtime callers allowed to discover and execute this Capability. */
  allowedCallers: readonly ToolCallerKind[];
  requiredPermissions: readonly string[];
  supportsDryRun?: boolean;
}

export interface ToolCapabilityRequirement {
  key: ToolCapabilityKey;
  versions: VersionRange;
}

export interface ToolContext {
  caller: ToolCaller;
  permissions: readonly string[];
  dryRun?: boolean;
}

export interface ToolCapabilityImplementation {
  capability: { key: ToolCapabilityKey; version: SemVer };
  execute(context: ToolContext, input: unknown): Promise<unknown>;
}

export interface ToolProviderExtension {
  id: string;
  version: SemVer;
  implementations: readonly ToolCapabilityImplementation[];
}

export type SkillKnowledgeSource =
  | "shared_brain"
  | "library"
  | "source_documents";

export type SkillViewAccess =
  | {
      viewKey: ViewKey;
      schemaVersion: string;
      mode: "read";
    }
  | {
      viewKey: ViewKey;
      schemaVersion: string;
      mode: "write";
      commands: readonly CommandKey[];
    };

/**
 * A prompt-driven, tool-using workflow that the Echo chat Runtime can activate.
 *
 * Skills do not mutate state directly. They constrain the views and commands
 * available to the model, declare the knowledge layers and external
 * capabilities the workflow needs, and supply workflow-specific instructions.
 */
export interface SkillExtension<Input = unknown> {
  id: string;
  version: SemVer;
  label: string;
  description: string;
  inputSchema: ContractSchema<Input>;
  instructions: string;
  viewAccess: readonly SkillViewAccess[];
  knowledge: readonly SkillKnowledgeSource[];
  requiresCapabilities: readonly ToolCapabilityRequirement[];
}

export interface EchoPluginManifest {
  id: string;
  version: string;
  requires?: ReadonlyArray<{ pluginId: string; versions: string }>;
  contributes: {
    views?: readonly ViewModule[];
    presentations?: readonly PresentationExtension[];
    skills?: readonly SkillExtension[];
    toolCapabilities?: readonly ToolCapabilityContract[];
    tools?: readonly ToolProviderExtension[];
  };
}

const stableIdentifierSchema = z.string().trim().min(1).regex(
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/,
  "must be a stable lowercase identifier",
);
const javascriptExportSchema = z.string().trim().min(1).regex(
  /^[A-Za-z_$][A-Za-z0-9_$]*$/,
  "must be a JavaScript export identifier",
);
const semverSchema = z.string().trim().regex(
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  "must be a SemVer version",
);
const uniqueIdentifierArraySchema = z.array(stableIdentifierSchema).default([]).refine(
  (values) => new Set(values).size === values.length,
  "must not contain duplicates",
);

export const echoPluginPackageDescriptorSchema = z.object({
  schemaVersion: z.literal(ECHO_PLUGIN_DESCRIPTOR_SCHEMA_VERSION),
  id: stableIdentifierSchema,
  version: semverSchema,
  engines: z.object({
    echo: z.string().trim().min(1).refine(
      (range) => semver.validRange(range, { includePrerelease: true }) !== null,
      "must be a valid SemVer range",
    ),
  }).strict(),
  server: z.object({
    entry: z.string().trim().min(1),
    export: javascriptExportSchema,
  }).strict(),
  contributes: z.object({
    views: uniqueIdentifierArraySchema,
    presentations: z.array(z.object({
      loader: z.string().trim().min(1),
      entry: z.string().trim().min(1),
      export: javascriptExportSchema,
    }).strict()).default([]),
    skills: uniqueIdentifierArraySchema,
    toolCapabilities: uniqueIdentifierArraySchema,
    tools: uniqueIdentifierArraySchema,
  }).strict(),
}).strict().superRefine((descriptor, context) => {
  const loaders = descriptor.contributes.presentations.map(({ loader }) => loader);
  if (new Set(loaders).size !== loaders.length) {
    context.addIssue({
      code: "custom",
      path: ["contributes", "presentations"],
      message: "must not declare duplicate Presentation loaders",
    });
  }
});

/** The package-level contract stored in every published Plugin as echo.plugin.json. */
export type EchoPluginPackageDescriptor = z.infer<typeof echoPluginPackageDescriptorSchema>;

export const echoPluginPackageDescriptorContract = zodContractSchema(
  echoPluginPackageDescriptorSchema,
);

export function parseEchoPluginPackageDescriptor(value: unknown): EchoPluginPackageDescriptor {
  return echoPluginPackageDescriptorSchema.parse(value);
}

export function isVersionCompatible(version: string, requiredRange: string): boolean {
  return semver.valid(version) !== null
    && semver.validRange(requiredRange, { includePrerelease: true }) !== null
    && semver.satisfies(version, requiredRange, { includePrerelease: true });
}

export function isEchoVersionCompatible(echoVersion: string, requiredRange: string): boolean {
  return isVersionCompatible(echoVersion, requiredRange);
}

/**
 * A semantic AI action emitted by a Plugin Presentation.
 *
 * `message` is the short, user-visible intent stored in the conversation.
 * Workflow instructions stay in the registered Skill; Presentations must not
 * smuggle hidden system prompts through this contract.
 */
export interface EchoAIInvocation {
  actionId: string;
  message: string;
  skill?: {
    id: string;
    input: unknown;
  };
}

export interface EchoPresentationProps {
  viewKey: string;
  refreshRevision?: number;
  presentationLoader?: string;
  focusCardId?: string;
  activeConversationId?: string;
  onOpenInspector: () => void;
  onInvokeAI: (invocation: EchoAIInvocation) => void;
}

export function defineEchoPlugin<const Plugin extends EchoPluginManifest>(plugin: Plugin): Plugin {
  return plugin;
}

export function defineView<const View extends ViewModule>(view: View): View {
  return view;
}
