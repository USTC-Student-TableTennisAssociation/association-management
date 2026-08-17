import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryEvidenceAccumulator } from "@/memory/evidence-accumulator";
import { emptySeedMap } from "@/memory/types";

const serviceState = vi.hoisted(() => ({
  read: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/semantic-view/service", () => ({
  getSemanticView: serviceState.read,
  createViewProposal: serviceState.create,
  SemanticViewValidationError: class SemanticViewValidationError extends Error {},
}));

import { createSemanticViewToolset } from "@/semantic-view/toolset";

const executionOptions = {
  toolCallId: "tool-call-1",
  messages: [],
  abortSignal: undefined,
  context: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  serviceState.read.mockResolvedValue({
    viewKey: "activity_operations",
    viewLabel: "Activity Operations",
    viewDescription: "活动运营正式状态",
    compilationId: "00000000-0000-4000-8000-000000000020",
    compatible: true,
    cardTypes: [],
    cards: [],
  });
  serviceState.create.mockResolvedValue({ id: "proposal-1", status: "pending" });
});

describe("semantic View request-local prefetch", () => {
  it("reuses the same full snapshot/reference registry and satisfies the proposal guard", async () => {
    const toolset = createSemanticViewToolset({
      evidence: new MemoryEvidenceAccumulator({
        query: "test",
        mode: "fixture",
        seedMap: emptySeedMap(),
      }),
    });

    const prefetched = await toolset.prefetchView("activity_operations");
    const toolRead = await toolset.tools.readSemanticView.execute!(
      { viewKey: "activity_operations" },
      executionOptions,
    );
    await toolset.tools.proposeViewChange.execute!({
      viewKey: "activity_operations",
      reason: "用户明确要求收录活动",
      changes: [{
        type: "CREATE_CARD",
        cardRef: "event",
        name: "继往开来",
        cardTypeKey: "ActivityCard",
      }],
    }, executionOptions);

    expect(serviceState.read).toHaveBeenCalledTimes(1);
    expect(toolRead).toEqual(prefetched);
    expect(prefetched).toMatchObject({ isFullSnapshot: true, ref: "V1" });
    expect(serviceState.create).toHaveBeenCalledOnce();
  });
});
