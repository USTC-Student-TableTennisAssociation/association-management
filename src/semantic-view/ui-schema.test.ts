import { describe, expect, it } from "vitest";

import {
  semanticViewReferenceBundleSchema,
  viewProposalPresentationSchema,
} from "@/semantic-view/ui-schema";

describe("Activity Operations UI transport schemas", () => {
  it("accepts Activity Operations proposal presentations", () => {
    const proposal = viewProposalPresentationSchema.parse({
      id: "proposal-1",
      viewKey: "activity_operations",
      status: "pending",
      reason: "建立活动 Card",
      createdAt: "2026-08-14T00:00:00.000Z",
      changes: [],
    });

    expect(proposal.viewKey).toBe("activity_operations");
  });

  it("accepts Activity Operations V# references", () => {
    const bundle = semanticViewReferenceBundleSchema.parse({
      references: [{
        ref: "V1",
        label: "活动运营",
        target: { kind: "view", viewKey: "activity_operations" },
      }],
    });

    expect(bundle.references[0].target.viewKey).toBe("activity_operations");
  });
});
