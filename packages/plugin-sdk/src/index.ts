import { z } from "zod";

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
}

export interface SlotDefinition {
  key: SlotKey;
  label: string;
  description?: string;
  cardinality: "one" | "many";
  required?: boolean;
  allowedTargetCardTypes: readonly CardTypeKey[];
}

export interface RelatedObjectPolicy {
  description?: string;
  min?: number;
  max?: number;
  uniqueCardPerObject?: boolean;
}

export interface CardTypeDefinition {
  key: CardTypeKey;
  label: string;
  description: string;
  dimensions: readonly DimensionDefinition[];
  slots: readonly SlotDefinition[];
  relatedObjects?: RelatedObjectPolicy;
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

export interface CommandDefinition<Input = unknown> {
  key: CommandKey;
  version: string;
  label: string;
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
  aiAttention?: {
    timing: "next_turn" | "after_settle" | "immediate";
    settleMs?: number;
  };
  higherMemory?: "reconcile_related_objects";
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
  capability: { key: ToolCapabilityKey; version: SemVer };
  execute(context: ToolContext, input: unknown): Promise<unknown>;
}

export interface ToolProviderExtension {
  id: string;
  version: SemVer;
  implementations: readonly ToolCapabilityImplementation[];
}

export interface SkillExtension<Input = unknown> {
  id: string;
  version: string;
  targetView: { viewKey: ViewKey; schemaVersion: string };
  readableViews?: ReadonlyArray<{ viewKey: ViewKey; schemaVersion: string }>;
  requiresCapabilities: readonly ToolCapabilityRequirement[];
  inputSchema: ContractSchema<Input>;
}

export interface EchoPluginManifest {
  id: string;
  version: string;
  requires?: ReadonlyArray<{ pluginId: string; versions: string }>;
  contributes: {
    views?: readonly ViewModule[];
    presentations?: readonly PresentationExtension[];
    skills?: readonly SkillExtension[];
    tools?: readonly ToolProviderExtension[];
  };
}

export interface EchoPresentationProps {
  viewKey: string;
  refreshRevision?: number;
  focusCardId?: string;
  onOpenInspector: () => void;
  onAskAI: (prompt: string) => void;
}

export function defineEchoPlugin<const Plugin extends EchoPluginManifest>(plugin: Plugin): Plugin {
  return plugin;
}

export function defineView<const View extends ViewModule>(view: View): View {
  return view;
}
