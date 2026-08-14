import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDatabase } from "@/db";
import {
  createViewProposal,
  normalizedAcademicYear,
  SemanticViewValidationError,
} from "@/semantic-view/service";

vi.mock("@/db", () => ({ getDatabase: vi.fn() }));

const compilationId = "00000000-0000-4000-8000-000000000001";
const positionObjectId = "00000000-0000-4000-8000-000000000002";

function existingPositionCard(academicYear: string) {
  return {
    id: "00000000-0000-4000-8000-000000000003",
    compilationId,
    sourceObjectId: positionObjectId,
    viewKey: "society_information",
    cardTypeKey: "PositionCard",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    sourceObject: { canonicalName: "会长" },
    contentDimensions: [{
      id: "00000000-0000-4000-8000-000000000004",
      cardId: "00000000-0000-4000-8000-000000000003",
      name: "学年",
      contentMarkdown: academicYear,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    }],
    outgoingSlots: [],
  };
}

function payload(academicYear: string) {
  return {
    viewKey: "society_information" as const,
    reason: "创建新学年的会长职位卡。",
    changes: [{
      type: "CREATE_CARD" as const,
      cardRef: "president-2026-2027",
      sourceObjectId: positionObjectId,
      cardTypeKey: "PositionCard",
    }, {
      type: "SET_CONTENT_DIMENSION" as const,
      card: "new:president-2026-2027",
      name: "学年",
      contentMarkdown: academicYear,
      supportingAssertionIds: [],
    }],
  };
}

function mockDatabase(academicYear: string) {
  const card = existingPositionCard(academicYear);
  const database = {
    memoryCompilation: {
      findFirst: vi.fn().mockResolvedValue({ id: compilationId, sourceTitle: "测试来源" }),
    },
    semanticCard: { findMany: vi.fn().mockResolvedValue([card]) },
    memoryGlobalObject: {
      findMany: vi.fn().mockResolvedValue([{
        id: positionObjectId,
        canonicalName: "会长",
      }]),
    },
    memoryAssertion: { findMany: vi.fn().mockResolvedValue([]) },
    semanticCardProposal: {
      create: vi.fn().mockImplementation(async ({ data }) => ({
        id: "00000000-0000-4000-8000-000000000005",
        compilationId,
        viewKey: data.viewKey,
        status: "pending",
        reason: data.reason,
        payload: data.payload,
        createdAt: new Date("2026-08-14T00:00:00.000Z"),
        failureReason: null,
      })),
    },
    semanticContentDimension: { findMany: vi.fn().mockResolvedValue(card.contentDimensions) },
    semanticSlotBinding: { findMany: vi.fn().mockResolvedValue([]) },
  };
  vi.mocked(getDatabase).mockReturnValue(database as never);
  return database;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PositionCard academic-year scope", () => {
  it("normalizes common full and short academic-year spellings", () => {
    expect(normalizedAcademicYear("2026—2027 学年")).toBe("2026-2027");
    expect(normalizedAcademicYear("26-27")).toBe("2026-2027");
  });

  it("allows one position Object to create a Card for a different academic year", async () => {
    const database = mockDatabase("2025-2026");

    await expect(createViewProposal({
      payload: payload("2026-2027"),
      evidenceCompilationId: compilationId,
      allowedObjectIds: new Set([positionObjectId]),
      allowedAssertionIds: new Set(),
    })).resolves.toMatchObject({ status: "pending" });

    expect(database.semanticCardProposal.create).toHaveBeenCalledOnce();
  });

  it("rejects a second Card for the same position Object and academic year", async () => {
    const database = mockDatabase("2026—2027 学年");

    await expect(createViewProposal({
      payload: payload("26-27"),
      evidenceCompilationId: compilationId,
      allowedObjectIds: new Set([positionObjectId]),
      allowedAssertionIds: new Set(),
    })).rejects.toThrow(SemanticViewValidationError);

    expect(database.semanticCardProposal.create).not.toHaveBeenCalled();
  });
});
