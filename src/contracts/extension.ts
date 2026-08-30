export type { PluginManifest } from "@sydaris/plugin-sdk";

export type ExtensionKind = "view" | "presentation" | "skill" | "tool";

export interface ExtensionActivation {
  extensionId: string;
  extensionKind: ExtensionKind;
  pluginId: string;
  pluginVersion: string;
  enabled: boolean;
  settings?: unknown;
}
