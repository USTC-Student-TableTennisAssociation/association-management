import type { ContractSchema } from "@/contracts/schema";

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
  version: SemVer;
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

export interface ViewCommandContext {
  viewKey: ViewKey;
  actor: ActorContext;
  initiator: "human" | "ai" | "system";
  skillId?: string;
  expectedStateVersion?: string;
  transaction: ViewTransaction;
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

export interface CommandOutcome {
  summary?: unknown;
  events?: readonly { type: string; version: string; payload: unknown }[];
}

export interface CommandDefinition<Input = unknown> {
  key: CommandKey;
  version: string;
  label: string;
  requiredPermissions?: readonly string[];
  inputSchema: ContractSchema<Input>;
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

export interface ViewCardState {
  id: CardId;
  viewKey: ViewKey;
  cardTypeKey: CardTypeKey;
  dimensions: Readonly<Record<DimensionKey, unknown>>;
  slots: Readonly<Record<SlotKey, readonly CardId[]>>;
  relatedObjectIds: readonly ObjectId[];
}

export interface ViewReadSnapshot {
  viewKey: ViewKey;
  moduleVersion: SemVer;
  schemaVersion: string;
  stateVersion: string;
  observedAt: string;
  cards: readonly ViewCardState[];
  references: readonly unknown[];
}

export interface ViewReadPort {
  query(input: {
    viewKey: ViewKey;
    query?: Readonly<Record<string, unknown>>;
    actor: ActorContext;
  }): Promise<ViewReadSnapshot>;
}
