import type { UIMessage } from "ai";
import type { AIInvocation } from "@sydaris/plugin-sdk";

import type { ChatStreamStatus } from "@/ai/chat-stream-status";
import type { MemorySearchBundle } from "@/memory/types";
import type { ObjectChangeProposalPresentation } from "@/memory/object-management-types";
import type { SourceDocumentReferenceBundle } from "@/memory/source-document-types";
import type { ArtifactReferenceBundle } from "@/library/artifact-references";
import type { LibraryPlanPresentation } from "@/library/types";
import type {
  ViewCommandProposalNotice,
  ViewReferenceBundle,
} from "@/agent-runtime/view-types";

export type ChatPageContext = {
  activeViewKey?: string;
  activePresentation: "work" | "inspector" | "full_chat" | "knowledge" | "library";
  activeFolderId?: string;
  activeCardId?: string;
  activeNodeId?: string;
  activeObjectName?: string;
};

export type ClubChatMessage = UIMessage<
  never,
  {
    aiInvocation: AIInvocation;
    memorySearch: MemorySearchBundle;
    sourceReferences: SourceDocumentReferenceBundle;
    artifactReferences: ArtifactReferenceBundle;
    viewReferences: ViewReferenceBundle;
    viewCommandProposal: ViewCommandProposalNotice;
    objectChangeProposal: ObjectChangeProposalPresentation;
    libraryProposal: LibraryPlanPresentation;
    streamStatus: ChatStreamStatus;
  }
>;
