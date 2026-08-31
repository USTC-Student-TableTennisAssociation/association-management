import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import {
  capabilityGatewayToolNames,
  createCapabilityGatewayTools,
  createOpenedCapabilities,
  detailedToolNames,
} from "@/ai/capability-gates";

describe("capability gates", () => {
  it("exposes only implemented Business Context follow-up tools", () => {
    const capabilities = createOpenedCapabilities();
    capabilities.businessContext = true;

    const names = detailedToolNames(capabilities);

    expect(names).toEqual(["expandEvidence", "followObject", "readSourceDocument"]);
    expect(names).not.toContain("readSemanticView");
  });

  it("keeps Object View discovery available as a read-only gateway", async () => {
    const locateObjectViews = vi.fn().mockResolvedValue({ matches: [] });
    const tools = createCapabilityGatewayTools(createOpenedCapabilities(), {
      viewKeySchema: z.string(),
      locateObjectViews,
      openBusinessContext: vi.fn(),
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

  it("passes exact Object references into Business Context without opening Actions", async () => {
    const state = createOpenedCapabilities();
    const openBusinessContext = vi.fn().mockResolvedValue({ relevantCards: [] });
    const tools = createCapabilityGatewayTools(state, {
      viewKeySchema: z.string(),
      locateObjectViews: vi.fn(),
      openBusinessContext,
      findArtifacts: vi.fn(),
      describeBusinessViewActions: vi.fn(),
    });
    const execute = tools.openBusinessContext.execute as unknown as (input: {
      viewKey: string;
      focus: string;
      targetHints: string[];
      targetObjectRefs: string[];
    }) => Promise<unknown>;

    await execute({
      viewKey: "activity_operations",
      focus: "读取这项活动的当前状态",
      targetHints: [],
      targetObjectRefs: ["O1"],
    });

    expect(openBusinessContext).toHaveBeenCalledWith({
      viewKey: "activity_operations",
      focus: "读取这项活动的当前状态",
      targetHints: [],
      targetObjectRefs: ["O1"],
    });
    expect(state.businessContext).toBe(true);
    expect(state.businessViewKey).toBe("activity_operations");
    expect([...state.businessViewKeys]).toEqual(["activity_operations"]);
    expect(state.actionAreas.size).toBe(0);
  });

  it("passes the model's structured artifact purpose to the handler", async () => {
    const findArtifacts = vi.fn().mockResolvedValue({ items: [] });
    const tools = createCapabilityGatewayTools(createOpenedCapabilities(), {
      viewKeySchema: z.string(),
      locateObjectViews: vi.fn(),
      openBusinessContext: vi.fn(),
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
