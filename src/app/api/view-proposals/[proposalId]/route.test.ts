import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ current: vi.fn() }));
const commandBusState = vi.hoisted(() => ({ decideProposal: vi.fn() }));

vi.mock("@/auth/session", () => ({ currentAuthUser: authState.current }));
vi.mock("@/shell/composition-root", () => ({
  viewCommandBus: { decideProposal: commandBusState.decideProposal },
}));

import { PATCH } from "@/app/api/view-proposals/[proposalId]/route";

const actorId = "00000000-0000-4000-8000-000000000001";
const proposalId = "00000000-0000-4000-8000-000000000002";

function request(decision: "approve" | "reject" = "approve") {
  return PATCH(
    new Request(`http://localhost/api/view-proposals/${proposalId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    }),
    { params: Promise.resolve({ proposalId }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.current.mockResolvedValue({
    role: "MEMBER",
    actor: { id: actorId, displayName: "测试成员" },
  });
  commandBusState.decideProposal.mockResolvedValue({
    kind: "executed",
    executionId: "execution-1",
    viewKey: "activity_operations",
    stateVersion: "1",
  });
});

describe("PATCH /api/view-proposals/[proposalId]", () => {
  it("lets a member delegate their Proposal decision to the ownership-aware Command Bus", async () => {
    const response = await request();

    expect(response.status).toBe(200);
    expect(commandBusState.decideProposal).toHaveBeenCalledWith({
      proposalId,
      decision: "approve",
      actor: {
        actorId,
        permissions: ["view.read", "view.write"],
      },
    });
  });

  it("gives an administrator the global approval permission", async () => {
    authState.current.mockResolvedValue({
      role: "ADMIN",
      actor: { id: actorId, displayName: "测试管理员" },
    });

    await request("reject");

    expect(commandBusState.decideProposal).toHaveBeenCalledWith(expect.objectContaining({
      actor: {
        actorId,
        permissions: ["view.read", "view.write", "view.approve"],
      },
    }));
  });

  it("still rejects an unauthenticated request", async () => {
    authState.current.mockResolvedValue(null);

    const response = await request();

    expect(response.status).toBe(401);
    expect(commandBusState.decideProposal).not.toHaveBeenCalled();
  });
});
