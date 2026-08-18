import type { PresentationExtension } from "@/contracts/presentation";
import type { SkillExtension } from "@/contracts/skill";
import type { ToolProviderExtension } from "@/contracts/tool";
import type { ViewModule } from "@/contracts/view";

export interface EchoPluginManifest {
  id: string;
  version: string;
  requires?: ReadonlyArray<{ pluginId: string; versions: string }>;
  contributes: {
    views?: readonly ViewModule[];
    presentations?: readonly PresentationExtension[];
    skills?: readonly SkillExtension[];
    tools?: readonly ToolProviderExtension[];
  };
}

export type ExtensionKind = "view" | "presentation" | "skill" | "tool";

export interface ExtensionActivation {
  extensionId: string;
  extensionKind: ExtensionKind;
  pluginId: string;
  pluginVersion: string;
  enabled: boolean;
  settings?: unknown;
}
