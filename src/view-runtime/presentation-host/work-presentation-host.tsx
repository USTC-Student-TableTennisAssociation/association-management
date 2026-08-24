"use client";

import { SocietyOverviewWorkspace } from "@/plugins/society-information/presentation/society-overview-workspace";
import { SOCIETY_OVERVIEW_LOADER } from "@/plugins/society-information/presentation/constants";
import { WorkViewWorkspace } from "@/view-runtime/generic-ui/work-view-workspace";

type WorkPresentationProps = {
  viewKey: string;
  presentationLoader?: string;
  focusCardId?: string;
  onOpenInspector: () => void;
  onAskAI: (prompt: string) => void;
};

export function WorkPresentationHost(props: WorkPresentationProps) {
  if (props.presentationLoader === SOCIETY_OVERVIEW_LOADER) {
    return <SocietyOverviewWorkspace {...props} />;
  }

  return <WorkViewWorkspace {...props} />;
}
