import { beforeEach, describe, expect, it, vi } from "vitest";

import { createObjectManagementToolset } from "@/memory/object-management-toolset";
import { createActorObjectBindingProposal } from "@/memory/object-management-service";

vi.mock("@/memory/object-management-service", () => ({
  createActorObjectBindingProposal: vi.fn(),
  createObjectChangeProposal: vi.fn(),
  inspectObjectIdentity: vi.fn(),
}));

const targetId = "00000000-0000-4000-8000-000000000080";

beforeEach(() => vi.clearAllMocks());

describe("Object management toolset", () => {
  function toolset() {
    return createObjectManagementToolset({
      authUser: { userId: "00000000-0000-4000-8000-000000000081" },
      resolveObjectReference: (reference) => reference === "O2"
        ? { id: targetId, canonicalName: "魏汉东" }
        : undefined,
      conversationUserMessages: [{
        messageId: "user-1",
        text: "我确实是知识库里的魏汉东，请把我们关联起来。",
      }],
    });
  }

  it("rejects an invented identity confirmation quote", async () => {
    const execute = toolset().tools.proposeActorObjectBinding.execute as unknown as (
      input: { targetObjectRef: string; confirmationQuote: string; reason: string },
    ) => Promise<unknown>;

    await expect(execute({
      targetObjectRef: "O2",
      confirmationQuote: "我就是魏汉东本人",
      reason: "建立账号身份关联",
    })).rejects.toThrow("不是本次对话中用户的逐字原话");
    expect(createActorObjectBindingProposal).not.toHaveBeenCalled();
  });

  it("resolves the request-local O# and creates a proposal from a verbatim confirmation", async () => {
    vi.mocked(createActorObjectBindingProposal).mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000082",
      status: "pending",
      reason: "建立账号身份关联",
      createdAt: "2026-09-05T00:00:00.000Z",
      invalidatesHigherMemory: false,
      changes: [],
    });
    const execute = toolset().tools.proposeActorObjectBinding.execute as unknown as (
      input: { targetObjectRef: string; confirmationQuote: string; reason: string },
    ) => Promise<unknown>;

    await expect(execute({
      targetObjectRef: "O2",
      confirmationQuote: "我确实是知识库里的魏汉东",
      reason: "建立账号身份关联",
    })).resolves.toMatchObject({ status: "pending" });
    expect(createActorObjectBindingProposal).toHaveBeenCalledWith(expect.objectContaining({
      targetObjectId: targetId,
      confirmationQuote: "我确实是知识库里的魏汉东",
    }));
  });
});
