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
  ObjectId,
  ProposalApprovalConflictPolicy,
  ViewCommandInitiator,
  RelatedObjectPolicy,
  SemVer,
  SlotDefinition,
  SlotKey,
  VersionRange,
  ViewCardState,
  ViewChange,
  ViewChangePolicy,
  ViewChangeValue,
  ViewCommandContext,
  ViewKey,
  ViewManifest,
  ViewModule,
  ViewPresentationSnapshot,
  ViewQueryCoverage,
  ViewQueryDefinition,
  ViewQueryKey,
  ViewQueryOutcome,
  ViewReadSnapshot,
  ViewReactionAttentionPolicy,
  ViewReactionAttentionStatus,
  ViewReactionKnowledgePolicy,
  ViewReactionKnowledgeStatus,
  ViewReactionTarget,
  ViewReactionTiming,
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
