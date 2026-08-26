import type { ViewKey } from "@/contracts/view";

export interface ViewPresentationDefinition {
  key: string;
  label: string;
  /** Shell-owned loader token. The runtime contract does not depend on React. */
  loader: string;
}

export interface PresentationExtension {
  id: string;
  version: string;
  targetView: ViewKey;
  /** Exact persisted View contract understood by this renderer. */
  schemaVersion: string;
  presentations: readonly ViewPresentationDefinition[];
}
