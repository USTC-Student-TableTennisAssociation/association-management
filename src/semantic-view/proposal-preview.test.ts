import { describe, expect, it } from "vitest";

import { proposalChangeFocus } from "@/semantic-view/proposal-preview";
import type { ViewProposalPresentation } from "@/semantic-view/types";

const baseProposal = {
  id: "proposal-1",
  viewKey: "society_information",
  status: "pending",
  reason: "预览定位测试",
  createdAt: "2026-08-12T00:00:00.000Z",
} as const;

describe("Proposal preview focus", () => {
  it("opens an existing Card and its changed Dimension directly", () => {
    const change: ViewProposalPresentation["changes"][number] = {
      type: "SET_CONTENT_DIMENSION",
      title: "设置简介",
      cardSelector: "card-1",
      cardId: "card-1",
      cardTypeKey: "PositionCard",
      cardLabel: "会长 · 职位",
      dimensionName: "简介 / 职责",
      before: "旧职责",
      after: "新职责",
      supports: [],
    };

    expect(proposalChangeFocus(change)).toEqual({
      cardId: "card-1",
      proposalCardSelector: "card-1",
      dimensionName: "简介 / 职责",
    });
  });

  it("opens a newly proposed Card without requiring a formal cardId", () => {
    const proposal: ViewProposalPresentation = {
      ...baseProposal,
      changes: [{
        type: "CREATE_CARD",
        title: "创建职位",
        cardSelector: "new:position_2026",
        cardTypeKey: "PositionCard",
        objectId: "object-1",
        objectName: "2026 学年会长",
        cardTypeLabel: "职位",
      }],
    };

    expect(proposalChangeFocus(proposal.changes[0])).toEqual({
      proposalCardSelector: "new:position_2026",
    });
  });
});
