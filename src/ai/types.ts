import type { UIMessage } from "ai";

import type { MemorySearchBundle } from "@/memory/types";
import type { ObjectChangeProposalPresentation } from "@/memory/object-management-types";
import type { SourceDocumentReferenceBundle } from "@/memory/source-document-types";
import type { ViewProposalPresentation } from "@/semantic-view/types";
import type {
  BusinessViewKey,
  BusinessViewPresentation,
  SemanticViewReferenceBundle,
} from "@/semantic-view/types";

export type ChatPageContext = {
  activeViewKey?: BusinessViewKey;
  activePresentation: BusinessViewPresentation | "full_chat";
};

export type ClubChatMessage = UIMessage<
  never,
  {
    memorySearch: MemorySearchBundle;
    sourceReferences: SourceDocumentReferenceBundle;
    viewReferences: SemanticViewReferenceBundle;
    viewProposal: ViewProposalPresentation;
    objectChangeProposal: ObjectChangeProposalPresentation;
  }
>;
