"use client";

import { installedPresentationComponents } from "@/generated/installed-presentations";
import { WorkViewWorkspace } from "@/view-runtime/generic-ui/work-view-workspace";
import type { PresentationProps } from "@sydaris/plugin-sdk";

export function WorkPresentationHost(props: PresentationProps) {
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
