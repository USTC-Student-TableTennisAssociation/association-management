"use client";

import { installedPresentationComponents } from "@/generated/installed-presentations";
import { WorkViewWorkspace } from "@/view-runtime/generic-ui/work-view-workspace";
import type { EchoAIInvocation } from "@sydaris/plugin-sdk";

export type WorkPresentationProps = {
  viewKey: string;
  refreshRevision?: number;
  presentationLoader?: string;
  focusCardId?: string;
  activeConversationId?: string;
  onOpenInspector: () => void;
  onInvokeAI: (invocation: EchoAIInvocation) => void;
};

export function WorkPresentationHost(props: WorkPresentationProps) {
  const Presentation = props.presentationLoader
    ? installedPresentationComponents[props.presentationLoader]
    : undefined;
  if (Presentation) {
    return <Presentation {...props} />;
  }

  return (
    <WorkViewWorkspace
      viewKey={props.viewKey}
      refreshRevision={props.refreshRevision}
      focusCardId={props.focusCardId}
      onOpenInspector={props.onOpenInspector}
      onInvokeAI={props.onInvokeAI}
    />
  );
}
