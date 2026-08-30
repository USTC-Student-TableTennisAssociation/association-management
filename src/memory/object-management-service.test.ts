import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDatabase } from "@/db";
import {
  createObjectChangeProposal,
  decideObjectChangeProposal,
  inspectObjectIdentity,
  ObjectManagementValidationError,
} from "@/memory/object-management-service";
import { objectChangePayloadSchema } from "@/memory/object-management-types";

vi.mock("@/db", () => ({ getDatabase: vi.fn() }));

const objectId = "00000000-0000-4000-8000-000000000020";
const fragmentId = "00000000-0000-4000-8000-000000000030";
const assertionId = "00000000-0000-4000-8000-000000000040";

function objectRow(options?: { withCard?: boolean }) {
  return {
    id: objectId,
    canonicalName: "项目负责人",
    surfaceMemberships: [{
      objectFragmentId: fragmentId,
      surfaceFormOrdinal: 1,
      objectFragment: {
        sourceFragmentId: "fragment-1",
        surfaceForms: ["项目负责人", "负责人"],
        sourceRegion: { label: "组织架构", sourceNodeId: "region-1" },
      },
    }],
    chatMentions: [],
    assertionLinks: [{
      assertionId,
      assertion: { statementTemplateMarkdown: "项目负责人负责统筹。" },
    }],
    assertionCoverage: [],
    higherMemory: null,
    relatedViewCards: options?.withCard
      ? [{
          card: {
            id: "00000000-0000-4000-8000-000000000050",
            viewKey: "society_information",
            cardTypeKey: "PositionCard",
          },
        }]
      : [],
  };
}

function mockDatabase(options?: { withCard?: boolean }) {
  const row = objectRow(options);
  const database = {
    memoryGlobalObject: {
      findUnique: vi.fn().mockResolvedValue(row),
      findMany: vi.fn().mockResolvedValue([{
        id: objectId,
        canonicalName: row.canonicalName,
        surfaceMemberships: [{
          surfaceFormOrdinal: 1,
          objectFragment: { surfaceForms: ["项目负责人", "负责人"] },
        }],
        chatMentions: [],
      }]),
    },
    memoryObjectChangeProposal: {
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({
        id: "00000000-0000-4000-8000-000000000060",
        status: "pending",
        reason: data.reason,
        payload: data.payload,
        createdAt: new Date("2026-08-14T00:00:00.000Z"),
        failureReason: null,
      })),
    },
  };
  vi.mocked(getDatabase).mockReturnValue(database as never);
  return database;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Object management service", () => {
  it("returns human-readable identity provenance with stable operation ids", async () => {
    mockDatabase();

    const inspection = await inspectObjectIdentity(objectId);

    expect(inspection.object.canonicalName).toBe("项目负责人");
    expect(inspection.surfaces).toEqual([expect.objectContaining({
      id: `document:${fragmentId}:1`,
      surfaceForm: "负责人",
      source: expect.stringContaining("组织架构"),
    })]);
    expect(inspection.references).toEqual([expect.objectContaining({
      id: `assertion:${assertionId}`,
      kind: "assertion",
      statement: "项目负责人负责统筹。",
    })]);
  });

  it("accepts exactly the Reference ids returned by Object identity inspection", async () => {
    mockDatabase();
    const inspection = await inspectObjectIdentity(objectId);
    const referenceId = inspection.references[0].id;
    const payload = {
      reason: "把 Assertion 引用移动到拆出的身份。",
      changes: [{
        type: "SPLIT_OBJECT" as const,
        sourceObjectId: objectId,
        sourceCanonicalName: "项目负责人",
        newCanonicalName: "负责人",
        moveSurfaceIds: [inspection.surfaces[0].id],
        moveReferenceIds: [referenceId],
      }],
    };

    expect(objectChangePayloadSchema.safeParse(payload).success).toBe(true);
    expect(objectChangePayloadSchema.safeParse({
      ...payload,
      changes: [{
        ...payload.changes[0],
        moveReferenceIds: [`semantic:${assertionId}`],
      }],
    }).success).toBe(false);
  });

  it("creates a pending exact Surface correction without mutating the Object", async () => {
    const database = mockDatabase();

    const proposal = await createObjectChangeProposal({
      payload: {
        reason: "负责人只是上下文泛称。",
        changes: [{
          type: "REMOVE_SURFACE",
          objectId,
          surfaceId: `document:${fragmentId}:1`,
        }],
      },
      allowedObjectIds: new Set([objectId]),
    });

    expect(proposal).toMatchObject({
      status: "pending",
      invalidatesHigherMemory: false,
      changes: [{ title: "移除“负责人”的 Object 名称归属" }],
    });
    expect(database.memoryObjectChangeProposal.create).toHaveBeenCalledTimes(1);
  });

  it("refuses to manage an Object that was not inspected in the current turn", async () => {
    const database = mockDatabase();

    await expect(createObjectChangeProposal({
      payload: {
        reason: "测试越权。",
        changes: [{
          type: "REMOVE_SURFACE",
          objectId,
          surfaceId: `document:${fragmentId}:1`,
        }],
      },
      allowedObjectIds: new Set(),
    })).rejects.toBeInstanceOf(ObjectManagementValidationError);
    expect(database.memoryObjectChangeProposal.create).not.toHaveBeenCalled();
  });

  it("exposes Business View dependencies on a merge proposal before approval", async () => {
    const secondObjectId = "00000000-0000-4000-8000-000000000021";
    const database = mockDatabase({ withCard: true });
    database.memoryGlobalObject.findUnique.mockImplementation(({ where }) => {
      if (where.id === objectId) return Promise.resolve(objectRow({ withCard: true }));
      return Promise.resolve({
        ...objectRow(),
        id: secondObjectId,
        canonicalName: "器材负责人",
        surfaceMemberships: [],
        assertionLinks: [],
        assertionCoverage: [],
      });
    });
    database.memoryGlobalObject.findMany.mockResolvedValue([
      {
        id: objectId,
        canonicalName: "项目负责人",
        surfaceMemberships: [],
        chatMentions: [],
      },
      {
        id: secondObjectId,
        canonicalName: "器材负责人",
        surfaceMemberships: [],
        chatMentions: [],
      },
    ]);

    const proposal = await createObjectChangeProposal({
      payload: {
        reason: "测试依赖预览。",
        changes: [{
          type: "MERGE_OBJECTS",
          survivorObjectId: objectId,
          mergedObjectIds: [secondObjectId],
        }],
      },
      allowedObjectIds: new Set([objectId, secondObjectId]),
    });

    expect(proposal.invalidatesHigherMemory).toBe(true);
    expect(proposal.changes[0].details.join(" ")).toContain("正式 View Card");
  });

  it("rechecks proposal status after the advisory lock and returns the concurrent result", async () => {
    const proposalRecord = {
      id: "00000000-0000-4000-8000-000000000070",
      status: "pending",
      reason: "并发测试",
      payload: {
        reason: "并发测试",
        changes: [{
          type: "SET_CANONICAL_NAME",
          objectId,
          canonicalName: "负责人",
        }],
      },
      createdAt: new Date("2026-08-14T00:00:00.000Z"),
      decidedAt: null,
      appliedAt: null,
      failureReason: null,
    };
    const transaction = {
      memoryObjectChangeProposal: {
        findUnique: vi.fn()
          .mockResolvedValueOnce(proposalRecord)
          .mockResolvedValueOnce({ ...proposalRecord, status: "applied" }),
      },
      memoryGlobalObject: { update: vi.fn() },
      $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
    };
    const database = {
      memoryObjectChangeProposal: {
        findUnique: vi.fn()
          .mockResolvedValueOnce(proposalRecord)
          .mockResolvedValueOnce({ status: "applied", failureReason: null }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      memoryGlobalObject: {
        findUnique: vi.fn().mockResolvedValue(objectRow()),
        findMany: vi.fn().mockResolvedValue([{
          id: objectId,
          canonicalName: "项目负责人",
          surfaceMemberships: [{
            surfaceFormOrdinal: 1,
            objectFragment: { surfaceForms: ["项目负责人", "负责人"] },
          }],
          chatMentions: [],
        }]),
      },
      $transaction: vi.fn(async (
        callback: (transactionClient: typeof transaction) => Promise<unknown>,
      ) => callback(transaction)),
    };
    vi.mocked(getDatabase).mockReturnValue(database as never);

    const result = await decideObjectChangeProposal(proposalRecord.id, "approve");

    expect(result.proposal.status).toBe("applied");
    expect(transaction.memoryObjectChangeProposal.findUnique).toHaveBeenCalledTimes(2);
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(transaction.memoryGlobalObject.update).not.toHaveBeenCalled();
    expect(database.memoryObjectChangeProposal.updateMany).toHaveBeenCalledWith({
      where: { id: proposalRecord.id, status: "pending" },
      data: {
        status: "failed",
        decidedAt: expect.any(Date),
        failureReason: "Proposal 已被其他请求处理",
      },
    });
  });
});
