import type { UIMessage } from "ai";

import type { MemorySearchBundle } from "@/memory/types";
import type { ObjectChangeProposalPresentation } from "@/memory/object-management-types";
import type { SourceDocumentReferenceBundle } from "@/memory/source-document-types";
import type { ArtifactReferenceBundle } from "@/library/artifact-references";
import type { LibraryPlanPresentation } from "@/library/types";
import type { ViewProposalPresentation } from "@/semantic-view/types";
import type {
  BusinessViewKey,
  BusinessViewPresentation,
  SemanticViewReferenceBundle,
} from "@/semantic-view/types";

export type ChatPageContext = {
  activeViewKey?: BusinessViewKey;
  activePresentation: BusinessViewPresentation | "full_chat" | "library";
  activeFolderId?: string;
  activeCardId?: string;
  activeNodeId?: string;
  activeObjectName?: string;
};

export type ClubChatMessage = UIMessage<
  never,
  {
    memorySearch: MemorySearchBundle;
    sourceReferences: SourceDocumentReferenceBundle;
    viewReferences: SemanticViewReferenceBundle;
    artifactReferences: ArtifactReferenceBundle;
    viewProposal: ViewProposalPresentation;
    objectChangeProposal: ObjectChangeProposalPresentation;
    libraryProposal: LibraryPlanPresentation;
  }
>;
