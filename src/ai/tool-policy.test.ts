import { describe, expect, it } from "vitest";

import {
  compileActiveToolNames,
  toolPolicy,
  type CapabilityCompilerState,
} from "@/ai/tool-policy";

function state(
  overrides: Partial<CapabilityCompilerState> = {},
): CapabilityCompilerState {
  return {
    viewStateOpened: false,
    artifactsOpened: false,
    libraryIndexRead: false,
    sharedBrainOpened: false,
    actionAreas: new Set(),
    objectEvidenceAvailable: false,
    ...overrides,
  };
}

const tools = [
  "inspectKnowledgeEnvironment",
  "searchMemory",
  "listLibrary",
  "listViewCards",
  "readViewState",
  "openArtifacts",
  "openActions",
  "openMemory",
  "locateObjectViews",
  "inspectLibraryNodes",
  "previewLibraryFiles",
  "readMemoryWriteStatus",
  "updateActorHigherMemory",
  "publishUserFactForView",
  "queueHigherMemoryMaintenance",
  "submitTurnHandoff",
  "runViewCommand",
  "proposeLibraryPlan",
];

describe("Capability Compiler", () => {
  it("keeps semantic read gateways available without exposing background governance", () => {
    const active = compileActiveToolNames({
      availableToolNames: tools,
      state: state(),
    });

    expect(active).toEqual(expect.arrayContaining([
      "inspectKnowledgeEnvironment",
      "searchMemory",
      "listLibrary",
      "listViewCards",
      "readViewState",
      "openArtifacts",
      "openActions",
      "openMemory",
    ]));
    expect(active).not.toContain("queueHigherMemoryMaintenance");
    expect(active).not.toContain("submitTurnHandoff");
    expect(active).not.toContain("updateActorHigherMemory");
  });

  it("derives detailed capabilities only from runtime state", () => {
    const active = compileActiveToolNames({
      availableToolNames: tools,
      state: state({
        libraryIndexRead: true,
        objectEvidenceAvailable: true,
        memoryPurpose: "check_write_status",
        actionAreas: new Set(["library"]),
      }),
    });

    expect(active).toEqual(expect.arrayContaining([
      "locateObjectViews",
      "inspectLibraryNodes",
      "previewLibraryFiles",
      "readMemoryWriteStatus",
      "proposeLibraryPlan",
    ]));
    expect(active).not.toContain("updateActorHigherMemory");
    expect(active).not.toContain("runViewCommand");
  });

  it("opens the foreground fact bridge only after a View read", () => {
    expect(compileActiveToolNames({
      availableToolNames: tools,
      state: state(),
    })).not.toContain("publishUserFactForView");

    expect(compileActiveToolNames({
      availableToolNames: tools,
      state: state({ viewStateOpened: true }),
    })).toContain("publishUserFactForView");
  });

  it("treats unknown tools as unavailable and unknown effects conservatively", () => {
    expect(compileActiveToolNames({
      availableToolNames: ["mysteryTool"],
      state: state(),
    })).toEqual([]);
    expect(toolPolicy("mysteryTool")).toMatchObject({
      effect: "unknown",
      approval: "explicit_user_intent",
      availability: "background_only",
    });
  });
});
