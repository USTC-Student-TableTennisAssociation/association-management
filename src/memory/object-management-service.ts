import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { getDatabase } from "@/db";
import { transactionAdvisoryLockQuery } from "@/db-advisory-lock";
import {
  type ObjectChange,
  type ObjectChangePayload,
  type ObjectChangeProposalPresentation,
  type ObjectIdentityInspection,
  objectChangePayloadSchema,
} from "@/memory/object-management-types";

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

type ValidatedObjectChange = {
  inspections: Map<string, ObjectIdentityInspection>;
};

export class ObjectManagementValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectManagementValidationError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function normalizedName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN")
    .replace(/[\s“”"'《》〈〉【】（）()，,。.!！?？:：;；·—_\-]/g, "");
}

function documentSurfaceId(objectFragmentId: string, ordinal: number): string {
  return `document:${objectFragmentId}:${ordinal}`;
}

function chatSurfaceId(chatEvidenceId: string, ordinal: number): string {
  return `chat:${chatEvidenceId}:${ordinal}`;
}

function assertionReferenceId(assertionId: string): string {
  return `assertion:${assertionId}`;
}

function coverageReferenceId(assertionId: string): string {
  return `coverage:${assertionId}`;
}

export async function inspectObjectIdentity(
  objectId: string,
  database: DatabaseClient = getDatabase(),
): Promise<ObjectIdentityInspection> {
  const object = await database.memoryGlobalObject.findUnique({
    where: { id: objectId },
    include: {
      surfaceMemberships: {
        orderBy: [{ objectFragmentId: "asc" }, { surfaceFormOrdinal: "asc" }],
        include: {
          objectFragment: {
            include: { sourceRegion: { select: { label: true, sourceNodeId: true } } },
          },
        },
      },
      chatMentions: {
        orderBy: [{ chatEvidenceId: "asc" }, { ordinal: "asc" }],
        include: {
          chatEvidence: {
            include: { submittedBy: { select: { displayName: true } } },
          },
        },
      },
      assertionLinks: {
        orderBy: [{ assertionId: "asc" }],
        include: { assertion: true },
      },
      assertionCoverage: {
        orderBy: { assertionId: "asc" },
        include: { assertion: true },
      },
      higherMemory: { select: { id: true } },
      relatedViewCards: {
        orderBy: { createdAt: "asc" },
        select: {
          card: { select: { id: true, viewKey: true, cardTypeKey: true } },
        },
      },
    },
  });
  if (!object) throw new ObjectManagementValidationError(`Object ${objectId} 不存在`);

  return {
    object: {
      id: object.id,
      canonicalName: object.canonicalName,
    },
    surfaces: [
      ...object.surfaceMemberships.map((membership) => ({
        id: documentSurfaceId(membership.objectFragmentId, membership.surfaceFormOrdinal),
        kind: "document" as const,
        surfaceForm:
          membership.objectFragment.surfaceForms[membership.surfaceFormOrdinal] ?? "（来源序号已失效）",
        source:
          `文档 · ${membership.objectFragment.sourceRegion.label} · ${membership.objectFragment.sourceFragmentId}`,
        excerpt: membership.objectFragment.surfaceForms.join(" / "),
      })),
      ...object.chatMentions.map((mention) => ({
        id: chatSurfaceId(mention.chatEvidenceId, mention.ordinal),
        kind: "chat" as const,
        surfaceForm: mention.surfaceForm,
        source:
          `${mention.chatEvidence.submittedBy.displayName} 的聊天陈述 · ${mention.chatEvidence.submittedAt.toISOString()}`,
        excerpt: mention.chatEvidence.rawUserMessage,
      })),
    ],
    references: [
      ...object.assertionLinks.map((link) => ({
        id: assertionReferenceId(link.assertionId),
        kind: "assertion" as const,
        assertionId: link.assertionId,
        statement: link.assertion.statementTemplateMarkdown,
      })),
      ...object.assertionCoverage.map((link) => ({
        id: coverageReferenceId(link.assertionId),
        kind: "coverage" as const,
        assertionId: link.assertionId,
        statement: link.assertion.statementTemplateMarkdown,
      })),
    ],
    dependencies: {
      higherMemory: Boolean(object.higherMemory),
      relatedViewCards: object.relatedViewCards.map((relation) => relation.card),
    },
  };
}

function objectIdsInChange(change: ObjectChange): string[] {
  switch (change.type) {
    case "REMOVE_SURFACE":
    case "SET_CANONICAL_NAME":
      return [change.objectId];
    case "MERGE_OBJECTS":
      return [change.survivorObjectId, ...change.mergedObjectIds];
    case "SPLIT_OBJECT":
      return [change.sourceObjectId];
  }
}

function surfaceNames(inspection: ObjectIdentityInspection): string[] {
  return inspection.surfaces.map((surface) => surface.surfaceForm);
}

async function validateObjectChange(
  database: DatabaseClient,
  payload: ObjectChangePayload,
  options: {
    allowedObjectIds?: ReadonlySet<string>;
    rejectBusinessViewDependencies: boolean;
  },
): Promise<ValidatedObjectChange> {
  const objectIds = unique(payload.changes.flatMap(objectIdsInChange));
  if (options.allowedObjectIds) {
    const unseen = objectIds.filter((id) => !options.allowedObjectIds!.has(id));
    if (unseen.length) {
      throw new ObjectManagementValidationError(
        `只能管理本轮已经 inspectObjectIdentity 的 Object：${unseen.join(", ")}`,
      );
    }
  }
  const inspections = new Map<string, ObjectIdentityInspection>();
  for (const objectId of objectIds) {
    const inspection = await inspectObjectIdentity(objectId, database);
    inspections.set(objectId, inspection);
  }

  const structuralObjectIds = new Set(payload.changes.flatMap((change) =>
    change.type === "MERGE_OBJECTS" || change.type === "SPLIT_OBJECT"
      ? objectIdsInChange(change)
      : []
  ));
  const mixedStructuralObjectId = payload.changes.flatMap((change) =>
    change.type === "REMOVE_SURFACE" || change.type === "SET_CANONICAL_NAME"
      ? [change.objectId]
      : []
  ).find((objectId) => structuralObjectIds.has(objectId));
  if (mixedStructuralObjectId) {
    throw new ObjectManagementValidationError(
      `Object ${mixedStructuralObjectId} 的 Surface/主名称修改不能与合并或拆分放在同一 Proposal`,
    );
  }

  const allObjectRows = await database.memoryGlobalObject.findMany({
    select: {
      id: true,
      canonicalName: true,
      surfaceMemberships: {
        select: {
          surfaceFormOrdinal: true,
          objectFragment: { select: { surfaceForms: true } },
        },
      },
      chatMentions: { select: { surfaceForm: true } },
    },
  });
  const nameOwners = new Map<string, Set<string>>();
  for (const row of allObjectRows) {
    const names = [
      row.canonicalName,
      ...row.surfaceMemberships.flatMap((membership) => {
        const value = membership.objectFragment.surfaceForms[membership.surfaceFormOrdinal];
        return value ? [value] : [];
      }),
      ...row.chatMentions.map((mention) => mention.surfaceForm),
    ];
    for (const name of names) {
      const normalized = normalizedName(name);
      const owners = nameOwners.get(normalized) ?? new Set<string>();
      owners.add(row.id);
      nameOwners.set(normalized, owners);
    }
  }
  const conflictingOwner = (name: string, ignoredIds: ReadonlySet<string>) =>
    [...(nameOwners.get(normalizedName(name)) ?? [])].find((id) => !ignoredIds.has(id));

  const structuralObjects = new Set<string>();
  const touchedSurfaces = new Set<string>();
  for (const change of payload.changes) {
    if (change.type === "REMOVE_SURFACE") {
      const inspection = inspections.get(change.objectId)!;
      const surface = inspection.surfaces.find((item) => item.id === change.surfaceId);
      if (!surface) {
        throw new ObjectManagementValidationError(
          `${change.surfaceId} 当前不属于 ${inspection.object.canonicalName}`,
        );
      }
      if (touchedSurfaces.has(change.surfaceId)) {
        throw new ObjectManagementValidationError(`同一 Surface 不能重复修改：${change.surfaceId}`);
      }
      touchedSurfaces.add(change.surfaceId);
      continue;
    }

    if (change.type === "SET_CANONICAL_NAME") {
      const inspection = inspections.get(change.objectId)!;
      const names = [inspection.object.canonicalName, ...surfaceNames(inspection)];
      if (!names.some((name) => normalizedName(name) === normalizedName(change.canonicalName))) {
        throw new ObjectManagementValidationError(
          `新 canonicalName“${change.canonicalName}”必须来自该 Object 已检查的真实名称来源`,
        );
      }
      const conflict = conflictingOwner(change.canonicalName, new Set([change.objectId]));
      if (conflict) {
        throw new ObjectManagementValidationError(
          `主名称“${change.canonicalName}”已属于另一个 Object ${conflict}`,
        );
      }
      continue;
    }

    const affected = objectIdsInChange(change);
    const repeated = affected.find((id) => structuralObjects.has(id));
    if (repeated) {
      throw new ObjectManagementValidationError(
        `Object ${repeated} 不能在同一 Proposal 中参与多次合并/拆分`,
      );
    }
    for (const id of affected) structuralObjects.add(id);
    const cards = affected.flatMap((id) => inspections.get(id)!.dependencies.relatedViewCards);
    if (options.rejectBusinessViewDependencies && cards.length) {
      throw new ObjectManagementValidationError(
        `身份重写会影响 ${cards.length} 张正式 Business View Card；请先处理业务视角依赖：` +
          cards.map((card) => `${card.viewKey}/${card.cardTypeKey}/${card.id}`).join(", "),
      );
    }

    if (change.type === "MERGE_OBJECTS") {
      if (change.mergedObjectIds.includes(change.survivorObjectId)) {
        throw new ObjectManagementValidationError("MERGE_OBJECTS 的 survivor 不能同时出现在 mergedObjectIds");
      }
      if (new Set(change.mergedObjectIds).size !== change.mergedObjectIds.length) {
        throw new ObjectManagementValidationError("MERGE_OBJECTS 的 mergedObjectIds 不能重复");
      }
      continue;
    }

    const inspection = inspections.get(change.sourceObjectId)!;
    const surfacesById = new Map(inspection.surfaces.map((surface) => [surface.id, surface]));
    const referencesById = new Map(inspection.references.map((reference) => [reference.id, reference]));
    if (new Set(change.moveSurfaceIds).size !== change.moveSurfaceIds.length) {
      throw new ObjectManagementValidationError("SPLIT_OBJECT 的 moveSurfaceIds 不能重复");
    }
    if (new Set(change.moveReferenceIds).size !== change.moveReferenceIds.length) {
      throw new ObjectManagementValidationError("SPLIT_OBJECT 的 moveReferenceIds 不能重复");
    }
    const missingSurface = change.moveSurfaceIds.find((id) => !surfacesById.has(id));
    if (missingSurface) {
      throw new ObjectManagementValidationError(`${missingSurface} 当前不属于待拆分 Object`);
    }
    const missingReference = change.moveReferenceIds.find((id) => !referencesById.has(id));
    if (missingReference) {
      throw new ObjectManagementValidationError(`${missingReference} 当前不属于待拆分 Object`);
    }
    const movedNames = change.moveSurfaceIds.map((id) => surfacesById.get(id)!.surfaceForm);
    const remainingNames = inspection.surfaces
      .filter((surface) => !change.moveSurfaceIds.includes(surface.id))
      .map((surface) => surface.surfaceForm);
    if (!movedNames.some((name) => normalizedName(name) === normalizedName(change.newCanonicalName))) {
      throw new ObjectManagementValidationError(
        `拆出的 canonicalName“${change.newCanonicalName}”必须来自被移动的 Surface`,
      );
    }
    if (!remainingNames.some((name) => normalizedName(name) === normalizedName(change.sourceCanonicalName))) {
      throw new ObjectManagementValidationError(
        `保留 Object 的 canonicalName“${change.sourceCanonicalName}”必须来自未移动的 Surface`,
      );
    }
    const newConflict = conflictingOwner(change.newCanonicalName, new Set([change.sourceObjectId]));
    if (newConflict) {
      throw new ObjectManagementValidationError(
        `拆出的主名称“${change.newCanonicalName}”已属于另一个 Object ${newConflict}`,
      );
    }
    const sourceConflict = conflictingOwner(
      change.sourceCanonicalName,
      new Set([change.sourceObjectId]),
    );
    if (sourceConflict) {
      throw new ObjectManagementValidationError(
        `保留主名称“${change.sourceCanonicalName}”已属于另一个 Object ${sourceConflict}`,
      );
    }
  }

  return { inspections };
}

function hasStructuralChange(payload: ObjectChangePayload): boolean {
  return payload.changes.some((change) =>
    change.type === "MERGE_OBJECTS" || change.type === "SPLIT_OBJECT"
  );
}

function presentationChanges(
  payload: ObjectChangePayload,
  validated: ValidatedObjectChange,
): ObjectChangeProposalPresentation["changes"] {
  return payload.changes.map((change) => {
    if (change.type === "REMOVE_SURFACE") {
      const inspection = validated.inspections.get(change.objectId)!;
      const surface = inspection.surfaces.find((item) => item.id === change.surfaceId)!;
      return {
        type: change.type,
        title: `移除“${surface.surfaceForm}”的 Object 名称归属`,
        details: [`Object：${inspection.object.canonicalName}`, `来源：${surface.source}`],
      };
    }
    if (change.type === "SET_CANONICAL_NAME") {
      const inspection = validated.inspections.get(change.objectId)!;
      return {
        type: change.type,
        title: `修改主名称：${inspection.object.canonicalName} → ${change.canonicalName}`,
        details: [`Object ID：${change.objectId}`],
      };
    }
    if (change.type === "MERGE_OBJECTS") {
      const survivor = validated.inspections.get(change.survivorObjectId)!;
      const merged = change.mergedObjectIds.map(
        (id) => validated.inspections.get(id)!.object.canonicalName,
      );
      const cards = objectIdsInChange(change).flatMap(
        (id) => validated.inspections.get(id)!.dependencies.relatedViewCards,
      );
      return {
        type: change.type,
        title: `合并到“${survivor.object.canonicalName}”`,
        details: [
          `被合并：${merged.join("、")}`,
          "全部 Surface、Assertion 引用和聊天名称来源将迁移到保留 Object。",
          cards.length
            ? `存在 ${cards.length} 张正式 View Card，当前版本会阻止批准应用。`
            : "没有正式 View Card 阻塞。",
        ],
      };
    }
    const source = validated.inspections.get(change.sourceObjectId)!;
    const cards = source.dependencies.relatedViewCards;
    return {
      type: change.type,
      title: `拆分“${source.object.canonicalName}”`,
      details: [
        `保留身份：${change.sourceCanonicalName}`,
        `新身份：${change.newCanonicalName}`,
        `移动 ${change.moveSurfaceIds.length} 个 Surface、${change.moveReferenceIds.length} 个 Assertion 引用。`,
        cards.length
          ? `存在 ${cards.length} 张正式 View Card，当前版本会阻止批准应用。`
          : "没有正式 View Card 阻塞。",
      ],
    };
  });
}

async function presentProposal(
  proposal: {
    id: string;
    status: string;
    reason: string;
    payload: Prisma.JsonValue;
    createdAt: Date;
    failureReason: string | null;
  },
  validated?: ValidatedObjectChange,
): Promise<ObjectChangeProposalPresentation> {
  const payload = objectChangePayloadSchema.parse(proposal.payload);
  const state = validated ?? await validateObjectChange(
    getDatabase(),
    payload,
    { rejectBusinessViewDependencies: false },
  );
  return {
    id: proposal.id,
    status: proposal.status as ObjectChangeProposalPresentation["status"],
    reason: proposal.reason,
    createdAt: proposal.createdAt.toISOString(),
    ...(proposal.failureReason ? { failureReason: proposal.failureReason } : {}),
    invalidatesHigherMemory: hasStructuralChange(payload),
    changes: presentationChanges(payload, state),
  };
}

export async function createObjectChangeProposal(input: {
  payload: ObjectChangePayload;
  allowedObjectIds: ReadonlySet<string>;
}): Promise<ObjectChangeProposalPresentation> {
  const database = getDatabase();
  const payload = objectChangePayloadSchema.parse(input.payload);
  const validated = await validateObjectChange(database, payload, {
    allowedObjectIds: input.allowedObjectIds,
    rejectBusinessViewDependencies: false,
  });
  const proposal = await database.memoryObjectChangeProposal.create({
    data: {
      reason: payload.reason,
      payload: payload as Prisma.InputJsonValue,
    },
  });
  return presentProposal(proposal, validated);
}

function parseSurfaceId(surfaceId: string):
  | { kind: "document"; objectFragmentId: string; ordinal: number }
  | { kind: "chat"; chatEvidenceId: string; ordinal: number } {
  const [kind, id, ordinalText] = surfaceId.split(":");
  const ordinal = Number(ordinalText);
  if (kind === "document") return { kind, objectFragmentId: id, ordinal };
  return { kind: "chat", chatEvidenceId: id, ordinal };
}

function parseReferenceId(referenceId: string):
  | { kind: "assertion"; assertionId: string }
  | { kind: "coverage"; assertionId: string } {
  if (referenceId.startsWith("assertion:")) {
    return { kind: "assertion", assertionId: referenceId.slice("assertion:".length) };
  }
  if (referenceId.startsWith("coverage:")) {
    return { kind: "coverage", assertionId: referenceId.slice("coverage:".length) };
  }
  throw new ObjectManagementValidationError(`未知 Assertion–Object 引用 ${referenceId}`);
}

async function removeSurface(
  transaction: Prisma.TransactionClient,
  objectId: string,
  surfaceId: string,
): Promise<void> {
  const surface = parseSurfaceId(surfaceId);
  if (surface.kind === "document") {
    const result = await transaction.memoryGlobalObjectSurfaceMembership.deleteMany({
      where: {
        globalObjectId: objectId,
        objectFragmentId: surface.objectFragmentId,
        surfaceFormOrdinal: surface.ordinal,
      },
    });
    if (result.count !== 1) throw new ObjectManagementValidationError(`${surfaceId} 已发生变化`);
    return;
  }
  const result = await transaction.memoryChatObjectMention.deleteMany({
    where: {
      globalObjectId: objectId,
      chatEvidenceId: surface.chatEvidenceId,
      ordinal: surface.ordinal,
    },
  });
  if (result.count !== 1) throw new ObjectManagementValidationError(`${surfaceId} 已发生变化`);
}

async function mergeObjects(
  transaction: Prisma.TransactionClient,
  change: Extract<ObjectChange, { type: "MERGE_OBJECTS" }>,
): Promise<void> {
  const sourceIds = change.mergedObjectIds;
  await transaction.memoryObjectHigherMemory.deleteMany({
    where: { globalObjectId: { in: [change.survivorObjectId, ...sourceIds] } },
  });

  const affectedAssertions = await transaction.memoryAssertion.findMany({
    where: { objectLinks: { some: { globalObjectId: { in: sourceIds } } } },
    select: { id: true, globalStatementTemplateMarkdown: true },
  });
  for (const assertion of affectedAssertions) {
    const rewritten = sourceIds.reduce(
      (template, sourceId) => template.split(`{{object:${sourceId}}}`).join(
        `{{object:${change.survivorObjectId}}}`,
      ),
      assertion.globalStatementTemplateMarkdown,
    );
    if (rewritten !== assertion.globalStatementTemplateMarkdown) {
      await transaction.memoryAssertion.update({
        where: { id: assertion.id },
        data: { globalStatementTemplateMarkdown: rewritten },
      });
    }
  }

  const sourceLinks = await transaction.memoryAssertionObjectLink.findMany({
    where: { globalObjectId: { in: sourceIds } },
    select: { assertionId: true, globalObjectId: true },
  });
  const survivorLinks = new Set((await transaction.memoryAssertionObjectLink.findMany({
    where: { globalObjectId: change.survivorObjectId },
    select: { assertionId: true },
  })).map((link) => link.assertionId));
  for (const link of sourceLinks) {
    if (!survivorLinks.has(link.assertionId)) {
      await transaction.memoryAssertionObjectLink.create({
        data: {
          assertionId: link.assertionId,
          globalObjectId: change.survivorObjectId,
        },
      });
      survivorLinks.add(link.assertionId);
    }
    await transaction.memoryAssertionObjectOccurrence.updateMany({
      where: {
        assertionId: link.assertionId,
        globalObjectId: link.globalObjectId,
      },
      data: { globalObjectId: change.survivorObjectId },
    });
    await transaction.memoryAssertionObjectLink.delete({
      where: {
        assertionId_globalObjectId: {
          assertionId: link.assertionId,
          globalObjectId: link.globalObjectId,
        },
      },
    });
  }

  const sourceCoverage = await transaction.memoryAssertionObjectCoverage.findMany({
    where: { globalObjectId: { in: sourceIds } },
    select: { assertionId: true, globalObjectId: true },
  });
  const survivorCoverage = new Set((await transaction.memoryAssertionObjectCoverage.findMany({
    where: { globalObjectId: change.survivorObjectId },
    select: { assertionId: true },
  })).map((link) => link.assertionId));
  for (const link of sourceCoverage) {
    if (!survivorCoverage.has(link.assertionId)) {
      await transaction.memoryAssertionObjectCoverage.create({
        data: {
          assertionId: link.assertionId,
          globalObjectId: change.survivorObjectId,
        },
      });
      survivorCoverage.add(link.assertionId);
    }
    await transaction.memoryAssertionObjectCoverage.delete({
      where: {
        assertionId_globalObjectId: {
          assertionId: link.assertionId,
          globalObjectId: link.globalObjectId,
        },
      },
    });
  }

  const survivorMentions = await transaction.memoryChatObjectMention.findMany({
    where: { globalObjectId: change.survivorObjectId },
    select: { chatEvidenceId: true, surfaceForm: true },
  });
  const survivorMentionKeys = new Set(
    survivorMentions.map((mention) => `${mention.chatEvidenceId}\u0000${mention.surfaceForm}`),
  );
  const sourceMentions = await transaction.memoryChatObjectMention.findMany({
    where: { globalObjectId: { in: sourceIds } },
    select: { globalObjectId: true, chatEvidenceId: true, ordinal: true, surfaceForm: true },
  });
  for (const mention of sourceMentions) {
    if (!survivorMentionKeys.has(`${mention.chatEvidenceId}\u0000${mention.surfaceForm}`)) continue;
    await transaction.memoryChatObjectMention.delete({
      where: {
        globalObjectId_chatEvidenceId_ordinal: {
          globalObjectId: mention.globalObjectId,
          chatEvidenceId: mention.chatEvidenceId,
          ordinal: mention.ordinal,
        },
      },
    });
  }

  await transaction.memoryGlobalObjectSurfaceMembership.updateMany({
    where: { globalObjectId: { in: sourceIds } },
    data: { globalObjectId: change.survivorObjectId },
  });
  await transaction.memoryChatObjectMention.updateMany({
    where: { globalObjectId: { in: sourceIds } },
    data: { globalObjectId: change.survivorObjectId },
  });
  await transaction.memoryGlobalObject.deleteMany({ where: { id: { in: sourceIds } } });
}

async function splitObject(
  transaction: Prisma.TransactionClient,
  change: Extract<ObjectChange, { type: "SPLIT_OBJECT" }>,
): Promise<void> {
  const newObjectId = randomUUID();
  await transaction.memoryObjectHigherMemory.deleteMany({
    where: { globalObjectId: change.sourceObjectId },
  });
  await transaction.memoryGlobalObject.update({
    where: { id: change.sourceObjectId },
    data: {
      canonicalName: change.sourceCanonicalName,
    },
  });
  await transaction.memoryGlobalObject.create({
    data: {
      id: newObjectId,
      globalObjectKey: `managed-object:${newObjectId}`,
      canonicalName: change.newCanonicalName,
    },
  });

  for (const surfaceId of change.moveSurfaceIds) {
    const surface = parseSurfaceId(surfaceId);
    if (surface.kind === "document") {
      await transaction.memoryGlobalObjectSurfaceMembership.update({
        where: {
          objectFragmentId_surfaceFormOrdinal: {
            objectFragmentId: surface.objectFragmentId,
            surfaceFormOrdinal: surface.ordinal,
          },
        },
        data: { globalObjectId: newObjectId },
      });
    } else {
      await transaction.memoryChatObjectMention.update({
        where: {
          globalObjectId_chatEvidenceId_ordinal: {
            globalObjectId: change.sourceObjectId,
            chatEvidenceId: surface.chatEvidenceId,
            ordinal: surface.ordinal,
          },
        },
        data: { globalObjectId: newObjectId },
      });
    }
  }
  for (const referenceId of change.moveReferenceIds) {
    const reference = parseReferenceId(referenceId);
    if (reference.kind === "assertion") {
      const assertion = await transaction.memoryAssertion.findUnique({
        where: { id: reference.assertionId },
        select: { globalStatementTemplateMarkdown: true },
      });
      if (!assertion) throw new ObjectManagementValidationError(`Assertion ${reference.assertionId} 不存在`);
      await transaction.memoryAssertionObjectLink.create({
        data: { assertionId: reference.assertionId, globalObjectId: newObjectId },
      });
      await transaction.memoryAssertionObjectOccurrence.updateMany({
        where: {
          assertionId: reference.assertionId,
          globalObjectId: change.sourceObjectId,
        },
        data: { globalObjectId: newObjectId },
      });
      await transaction.memoryAssertion.update({
        where: { id: reference.assertionId },
        data: {
          globalStatementTemplateMarkdown: assertion.globalStatementTemplateMarkdown
            .split(`{{object:${change.sourceObjectId}}}`)
            .join(`{{object:${newObjectId}}}`),
        },
      });
      await transaction.memoryAssertionObjectLink.delete({
        where: {
          assertionId_globalObjectId: {
            assertionId: reference.assertionId,
            globalObjectId: change.sourceObjectId,
          },
        },
      });
    } else {
      await transaction.memoryAssertionObjectCoverage.create({
        data: { assertionId: reference.assertionId, globalObjectId: newObjectId },
      });
      await transaction.memoryAssertionObjectCoverage.delete({
        where: {
          assertionId_globalObjectId: {
            assertionId: reference.assertionId,
            globalObjectId: change.sourceObjectId,
          },
        },
      });
    }
  }
}

export async function decideObjectChangeProposal(
  proposalId: string,
  decision: "approve" | "reject",
): Promise<{ proposal: ObjectChangeProposalPresentation }> {
  const database = getDatabase();
  const proposal = await database.memoryObjectChangeProposal.findUnique({ where: { id: proposalId } });
  if (!proposal) throw new ObjectManagementValidationError("Object Change Proposal 不存在");
  if (proposal.status !== "pending") {
    throw new ObjectManagementValidationError(`Proposal 已经是 ${proposal.status} 状态`);
  }
  const payload = objectChangePayloadSchema.parse(proposal.payload);

  if (decision === "reject") {
    await database.memoryObjectChangeProposal.update({
      where: { id: proposal.id },
      data: { status: "rejected", decidedAt: new Date() },
    });
    let rejectedPresentation: ObjectChangeProposalPresentation;
    try {
      rejectedPresentation = { ...await presentProposal(proposal), status: "rejected" };
    } catch {
      rejectedPresentation = {
        id: proposal.id,
        status: "rejected",
        reason: proposal.reason,
        createdAt: proposal.createdAt.toISOString(),
        invalidatesHigherMemory: hasStructuralChange(payload),
        changes: [],
      };
    }
    return {
      proposal: rejectedPresentation,
    };
  }

  const presentation = await presentProposal(proposal);
  try {
    await database.$transaction(async (transaction) => {
      const current = await transaction.memoryObjectChangeProposal.findUnique({
        where: { id: proposal.id },
      });
      if (!current || current.status !== "pending") {
        throw new ObjectManagementValidationError("Proposal 已被处理");
      }
      const objectIds = unique(payload.changes.flatMap(objectIdsInChange)).sort();
      for (const objectId of objectIds) {
        const lockKey = `object-management:${objectId}`;
        await transaction.$queryRaw(transactionAdvisoryLockQuery(lockKey));
      }
      const lockedCurrent = await transaction.memoryObjectChangeProposal.findUnique({
        where: { id: proposal.id },
      });
      if (!lockedCurrent || lockedCurrent.status !== "pending") {
        throw new ObjectManagementValidationError("Proposal 已被其他请求处理");
      }
      await validateObjectChange(transaction, payload, {
        rejectBusinessViewDependencies: true,
      });

      for (const change of payload.changes) {
        if (change.type === "REMOVE_SURFACE") {
          await removeSurface(transaction, change.objectId, change.surfaceId);
        } else if (change.type === "SET_CANONICAL_NAME") {
          await transaction.memoryGlobalObject.update({
            where: { id: change.objectId },
            data: { canonicalName: change.canonicalName },
          });
        } else if (change.type === "MERGE_OBJECTS") {
          await mergeObjects(transaction, change);
        } else {
          await splitObject(transaction, change);
        }
      }

      await transaction.memoryObjectChangeProposal.update({
        where: { id: proposal.id },
        data: { status: "applied", decidedAt: new Date(), appliedAt: new Date() },
      });
    }, { maxWait: 30_000, timeout: 180_000 });
  } catch (error) {
    const failureReason = errorMessage(error);
    const failed = await database.memoryObjectChangeProposal.updateMany({
      where: { id: proposal.id, status: "pending" },
      data: { status: "failed", decidedAt: new Date(), failureReason },
    });
    if (failed.count === 0) {
      const concurrentlyProcessed = await database.memoryObjectChangeProposal.findUnique({
        where: { id: proposal.id },
        select: { status: true, failureReason: true },
      });
      if (concurrentlyProcessed) {
        return {
          proposal: {
            ...presentation,
            status: concurrentlyProcessed.status,
            ...(concurrentlyProcessed.failureReason
              ? { failureReason: concurrentlyProcessed.failureReason }
              : {}),
          },
        };
      }
    }
    return {
      proposal: { ...presentation, status: "failed", failureReason },
    };
  }

  return { proposal: { ...presentation, status: "applied" } };
}
