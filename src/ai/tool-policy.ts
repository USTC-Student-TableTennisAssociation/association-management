export type ToolEffect = "none" | "proposal" | "write" | "unknown";
export type ToolApproval = "never" | "explicit_user_intent" | "proposal_approval";
export type ToolCost = "low" | "medium" | "high";

export type ToolPolicy = {
  effect: ToolEffect;
  approval: ToolApproval;
  cost: ToolCost;
  readOnly: boolean;
  idempotent: boolean;
  availability:
    | "core"
    | "object_evidence"
    | "view_state"
    | "artifact"
    | "library_index"
    | "shared_brain"
    | "memory_status"
    | "memory_update"
    | "foreground_view_fact"
    | "business_view_action"
    | "object_action"
    | "library_action"
    | "background_only";
};

const read = (
  availability: ToolPolicy["availability"],
  cost: ToolCost = "low",
): ToolPolicy => ({
  effect: "none",
  approval: "never",
  cost,
  readOnly: true,
  idempotent: true,
  availability,
});

const proposal = (
  availability: ToolPolicy["availability"],
): ToolPolicy => ({
  effect: "proposal",
  approval: "proposal_approval",
  cost: "low",
  readOnly: false,
  idempotent: false,
  availability,
});

export const toolPolicies: Readonly<Record<string, ToolPolicy>> = {
  activateSkill: read("core"),
  inspectKnowledgeEnvironment: read("core"),
  searchMemory: read("core", "medium"),
  listLibrary: read("core"),
  readLibraryCompilation: read("core"),
  listViewCards: read("core"),
  readViewState: read("core"),
  openArtifacts: read("core"),
  openActions: read("core"),
  openMemory: read("core"),
  locateObjectViews: read("object_evidence"),
  expandEvidence: read("view_state", "medium"),
  followObject: read("shared_brain", "medium"),
  readSourceDocument: read("shared_brain", "medium"),
  openArtifactKnowledge: read("artifact", "medium"),
  inspectLibraryNodes: read("library_index"),
  previewLibraryFiles: read("library_index", "medium"),
  readMemoryWriteStatus: read("memory_status"),
  updateActorHigherMemory: {
    effect: "write",
    approval: "explicit_user_intent",
    cost: "low",
    readOnly: false,
    idempotent: false,
    availability: "memory_update",
  },
  publishUserFactForView: {
    effect: "write",
    approval: "explicit_user_intent",
    cost: "high",
    readOnly: false,
    idempotent: false,
    availability: "foreground_view_fact",
  },
  queueChatAssertionCapture: {
    effect: "write",
    approval: "never",
    cost: "high",
    readOnly: false,
    idempotent: false,
    availability: "background_only",
  },
  queueHigherMemoryMaintenance: {
    effect: "write",
    approval: "never",
    cost: "high",
    readOnly: false,
    idempotent: false,
    availability: "background_only",
  },
  queueActorHigherMemoryMaintenance: {
    effect: "write",
    approval: "never",
    cost: "high",
    readOnly: false,
    idempotent: false,
    availability: "background_only",
  },
  submitTurnHandoff: {
    effect: "none",
    approval: "never",
    cost: "low",
    readOnly: true,
    idempotent: true,
    availability: "background_only",
  },
  runViewCommand: proposal("business_view_action"),
  inspectObjectIdentity: read("object_action"),
  proposeObjectChange: proposal("object_action"),
  proposeLibraryPlan: proposal("library_action"),
};

export type CapabilityCompilerState = {
  viewStateOpened: boolean;
  artifactsOpened: boolean;
  libraryIndexRead: boolean;
  sharedBrainOpened: boolean;
  memoryPurpose?: "check_write_status" | "update_actor_memory";
  actionAreas: ReadonlySet<"business_view" | "object" | "library">;
  objectEvidenceAvailable: boolean;
};

export type CompileActiveToolNamesInput = {
  availableToolNames: readonly string[];
  state: CapabilityCompilerState;
  skillToolNames?: readonly string[];
  viewQueryToolNames?: readonly string[];
  providerToolNames?: readonly string[];
};

function policyAllows(policy: ToolPolicy, state: CapabilityCompilerState): boolean {
  switch (policy.availability) {
    case "core":
      return true;
    case "object_evidence":
      return state.objectEvidenceAvailable;
    case "view_state":
      return state.viewStateOpened;
    case "artifact":
      return state.artifactsOpened;
    case "library_index":
      return state.libraryIndexRead || state.artifactsOpened;
    case "shared_brain":
      return state.sharedBrainOpened || state.viewStateOpened;
    case "memory_status":
      return state.memoryPurpose === "check_write_status";
    case "memory_update":
      return state.memoryPurpose === "update_actor_memory";
    case "foreground_view_fact":
      return state.viewStateOpened && !state.actionAreas.has("business_view");
    case "business_view_action":
      return state.actionAreas.has("business_view");
    case "object_action":
      return state.actionAreas.has("object");
    case "library_action":
      return state.actionAreas.has("library");
    case "background_only":
      return false;
  }
}

/**
 * Pure runtime compiler. It never reads the user's natural language and never
 * classifies intent. The main model chooses semantic gateways; this function
 * only enforces implemented prerequisites, permissions, and workflow state.
 */
export function compileActiveToolNames(
  input: CompileActiveToolNamesInput,
): string[] {
  const available = new Set(input.availableToolNames);
  const explicitCore = new Set([
    ...(input.skillToolNames ?? []),
    ...(input.providerToolNames ?? []),
  ]);
  const viewQueries = new Set(input.viewQueryToolNames ?? []);
  return [...available].filter((name) => {
    if (explicitCore.has(name)) return true;
    if (viewQueries.has(name)) return input.state.viewStateOpened;
    const policy = toolPolicies[name];
    return policy ? policyAllows(policy, input.state) : false;
  });
}

export function toolPolicy(name: string): ToolPolicy {
  return toolPolicies[name] ?? {
    effect: "unknown",
    approval: "explicit_user_intent",
    cost: "high",
    readOnly: false,
    idempotent: false,
    availability: "background_only",
  };
}
