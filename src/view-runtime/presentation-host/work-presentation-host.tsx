"use client";

import { SocietyOverviewWorkspace } from "@/plugins/society-information/presentation/society-overview-workspace";
import { SOCIETY_OVERVIEW_LOADER } from "@/plugins/society-information/presentation/constants";
import { WorkViewWorkspace } from "@/view-runtime/generic-ui/work-view-workspace";

type WorkPresentationProps = {
  viewKey: string;
  refreshRevision?: number;
  presentationLoader?: string;
  focusCardId?: string;
  activeConversationId?: string;
  onAIAttentionScheduled?: () => void;
  onOpenInspector: () => void;
  onAskAI: (prompt: string) => void;
};

export function WorkPresentationHost(props: WorkPresentationProps) {
  if (props.presentationLoader === SOCIETY_OVERVIEW_LOADER) {
    return <SocietyOverviewWorkspace {...props} />;
  }

  return (
    <WorkViewWorkspace
      viewKey={props.viewKey}
      refreshRevision={props.refreshRevision}
      focusCardId={props.focusCardId}
      onOpenInspector={props.onOpenInspector}
      onAskAI={props.onAskAI}
    />
  );
}
