import { describe, expect, it } from "vitest";

import { CapabilityLedger } from "@/ai/capability-ledger";

describe("Capability Ledger", () => {
  it("trusts proposal and commit receipts instead of successful tool transport", () => {
    const ledger = new CapabilityLedger();

    ledger.recordExecution("listLibrary", true, { items: [] });
    ledger.recordExecution("proposeLibraryPlan", true, {
      proposalId: "proposal-1",
      status: "pending",
    });
    ledger.recordExecution("updateActorHigherMemory", true, { committed: false });
    ledger.recordExecution("publishUserFactForView", true, { completed: true });

    expect(ledger.snapshot()).toMatchObject({
      successfulReads: ["listLibrary"],
      pendingProposals: ["proposeLibraryPlan"],
      committedWrites: [],
    });
  });

  it("recognizes explicit write receipts and leaves unknown providers untrusted", () => {
    const ledger = new CapabilityLedger();

    ledger.recordExecution("updateActorHigherMemory", true, { committed: true });
    ledger.recordExecution("providerSpecificTool", true, { ok: true });

    expect(ledger.snapshot().committedWrites).toEqual(["updateActorHigherMemory"]);
    expect(ledger.snapshot().executions.at(-1)?.outcome).toBe("unknown");
  });

  it("accepts a read-only effect declared by the Tool Provider runtime", () => {
    const ledger = new CapabilityLedger();

    ledger.recordExecution("external_calendar_lookup", true, { events: [] }, "none");

    expect(ledger.snapshot().successfulReads).toEqual(["external_calendar_lookup"]);
    expect(ledger.snapshot().committedWrites).toEqual([]);
  });
});
