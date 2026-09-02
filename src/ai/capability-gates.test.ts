import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import {
  capabilityGatewayToolNames,
  createCapabilityGatewayTools,
  createOpenedCapabilities,
  detailedToolNames,
} from "@/ai/capability-gates";

describe("capability gates", () => {
  it("exposes only implemented View state follow-up tools", () => {
    const capabilities = createOpenedCapabilities();
    capabilities.viewStateOpened = true;

    const names = detailedToolNames(capabilities);

    expect(names).toEqual(["expandEvidence", "followObject", "readSourceDocument"]);
    expect(names).not.toContain("readSemanticView");
  });

  it("keeps Library reads outside the Action capability and opens memory explicitly", async () => {
    const capabilities = createOpenedCapabilities();
    capabilities.libraryIndexRead = true;
    const names = detailedToolNames(capabilities);

    expect(names).toEqual(["inspectLibraryNodes", "previewLibraryFiles"]);
    expect(names).not.toContain("proposeLibraryPlan");

    const tools = createCapabilityGatewayTools(capabilities, {
      viewKeySchema: z.string(),
      locateObjectViews: vi.fn(),
      listViewCards: vi.fn(),
      readViewState: vi.fn(),
      findArtifacts: vi.fn(),
      describeBusinessViewActions: vi.fn(),
    });
    const execute = tools.openMemory.execute as unknown as (input: {
      purpose: "check_write_status" | "update_actor_memory";
    }) => Promise<unknown>;

    await execute({ purpose: "check_write_status" });

    expect(detailedToolNames(capabilities)).toEqual([
      "inspectLibraryNodes",
      "previewLibraryFiles",
      "readMemoryWriteStatus",
    ]);
  });

  it("keeps Object View discovery available as a read-only gateway", async () => {
    const locateObjectViews = vi.fn().mockResolvedValue({ matches: [] });
    const tools = createCapabilityGatewayTools(createOpenedCapabilities(), {
      viewKeySchema: z.string(),
      locateObjectViews,
      listViewCards: vi.fn(),
      readViewState: vi.fn(),
      findArtifacts: vi.fn(),
      describeBusinessViewActions: vi.fn(),
    });
    const execute = tools.locateObjectViews.execute as unknown as (
      input: { objectRef: string },
    ) => Promise<unknown>;

    await expect(execute({ objectRef: "O3" })).resolves.toEqual({ matches: [] });
    expect(locateObjectViews).toHaveBeenCalledWith({ objectRef: "O3" });
    expect(capabilityGatewayToolNames).toContain("locateObjectViews");
  });

  it("browses a View without unlocking targeted state or Actions", async () => {
    const state = createOpenedCapabilities();
    const listViewCards = vi.fn().mockResolvedValue({ cards: [] });
    const tools = createCapabilityGatewayTools(state, {
      viewKeySchema: z.string(),
      locateObjectViews: vi.fn(),
      listViewCards,
      readViewState: vi.fn(),
      findArtifacts: vi.fn(),
      describeBusinessViewActions: vi.fn(),
    });
    const execute = tools.listViewCards.execute as unknown as (input: {
      viewKey: string;
      offset?: number;
      limit?: number;
    }) => Promise<unknown>;

    await expect(execute({ viewKey: "society_information" })).resolves.toEqual({ cards: [] });
    expect(listViewCards).toHaveBeenCalledWith({
      viewKey: "society_information",
      offset: 0,
      limit: 50,
    });
    expect(state.viewStateOpened).toBe(false);
    expect(state.actionAreas.size).toBe(0);
    expect(capabilityGatewayToolNames).toContain("listViewCards");
  });

  it("passes typed entity targets into View state without opening Actions", async () => {
    const state = createOpenedCapabilities();
    const readViewState = vi.fn().mockResolvedValue({ relevantCards: [] });
    const tools = createCapabilityGatewayTools(state, {
      viewKeySchema: z.string(),
      locateObjectViews: vi.fn(),
      listViewCards: vi.fn(),
      readViewState,
      findArtifacts: vi.fn(),
      describeBusinessViewActions: vi.fn(),
    });
    const execute = tools.readViewState.execute as unknown as (input: {
      viewKey: string;
      question: string;
      targets: Array<{ kind: "name" | "object_ref" | "card_ref"; value: string }>;
    }) => Promise<unknown>;

    await execute({
      viewKey: "activity_operations",
      question: "读取这项活动的当前状态",
      targets: [{ kind: "object_ref", value: "O1" }],
    });

    expect(readViewState).toHaveBeenCalledWith({
      viewKey: "activity_operations",
      question: "读取这项活动的当前状态",
      targets: [{ kind: "object_ref", value: "O1" }],
    });
    expect(state.viewStateOpened).toBe(true);
    expect(state.lastViewKey).toBe("activity_operations");
    expect([...state.openedViewKeys]).toEqual(["activity_operations"]);
    expect(state.actionAreas.size).toBe(0);
  });

  it("passes the model's structured artifact purpose to the handler", async () => {
    const findArtifacts = vi.fn().mockResolvedValue({ items: [] });
    const tools = createCapabilityGatewayTools(createOpenedCapabilities(), {
      viewKeySchema: z.string(),
      locateObjectViews: vi.fn(),
      listViewCards: vi.fn(),
      readViewState: vi.fn(),
      findArtifacts,
      describeBusinessViewActions: vi.fn(),
    });
    const execute = tools.openArtifacts.execute as unknown as (input: {
      title: string;
      purpose: "locate" | "read" | "analyze";
    }) => Promise<unknown>;

    await execute({ title: "操作手册", purpose: "analyze" });

    expect(findArtifacts).toHaveBeenCalledWith({
      title: "操作手册",
      purpose: "analyze",
    });
  });
});
