import type {
  ActorContext,
  ViewKey,
  ViewReadSnapshot,
} from "@sydaris/plugin-sdk";

export type {
  ActorContext,
  AiWritePolicy,
  BusinessInvariant,
  CardId,
  CardTypeDefinition,
  CardTypeKey,
  CommandDefinition,
  CommandInputReferenceDefinition,
  CommandKey,
  CommandOutcome,
  DimensionDefinition,
  DimensionKey,
  DimensionType,
  DomainEventDefinition,
  KnowledgeProjectionDefinition,
  ObjectId,
  ProposalApprovalConflictPolicy,
  RelatedObjectPolicy,
  SemVer,
  SlotDefinition,
  SlotKey,
  VersionRange,
  ViewCardState,
  ViewCommandContext,
  ViewKey,
  ViewManifest,
  ViewModule,
  ViewReadSnapshot,
  ViewSchema,
  ViewSettings,
  ViewTransaction,
} from "@sydaris/plugin-sdk";

/** Runtime-owned query port; Plugins only consume the serializable snapshot contract. */
export interface ViewReadPort {
  query(input: {
    viewKey: ViewKey;
    query?: Readonly<Record<string, unknown>>;
    actor: ActorContext;
  }): Promise<ViewReadSnapshot>;
}
