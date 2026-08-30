import { getDatabase } from "@/db";
import {
  renderResolvedAssertion,
  type ResolvedAssertionReference,
} from "@/memory/resolved-assertion";

const OBJECT_LIMIT = 70;
const ASSERTION_LIMIT = 140;

export type KnowledgeGraphMode = "core" | "all" | "isolated";

export type KnowledgeGraphObjectNode = {
  id: string;
  label: string;
  degree: number;
};

export type KnowledgeGraphAssertionNode = {
  id: string;
  statement: string;
  kind: "grounded" | "reference";
  contextDependent: boolean;
  objectIds: string[];
  sourceLabel: string;
};

export type KnowledgeGraphEdge = {
  id: string;
  assertionId: string;
  objectId: string;
};

export type KnowledgeGraphPayload = {
  mode: KnowledgeGraphMode;
  summary: {
    totalObjects: number;
    connectedObjects: number;
    unlinkedObjects: number;
    totalAssertions: number;
    connectedAssertions: number;
    visibleObjects: number;
    visibleAssertions: number;
    visibleConnections: number;
    truncated: boolean;
  };
  objects: KnowledgeGraphObjectNode[];
  assertions: KnowledgeGraphAssertionNode[];
  edges: KnowledgeGraphEdge[];
};

type AssertionRow = Awaited<ReturnType<typeof loadAssertionRows>>[number];

function directReferences(row: AssertionRow): ResolvedAssertionReference[] {
  return row.objectLinks.map(({ globalObject }) => ({
    globalObjectId: globalObject.id,
    canonicalName: globalObject.canonicalName,
  }));
}

function associatedObjects(row: AssertionRow) {
  return directReferences(row);
}

function renderStatement(row: AssertionRow) {
  try {
    return renderResolvedAssertion({
      globalStatementTemplateMarkdown: row.globalStatementTemplateMarkdown,
      references: directReferences(row),
      assertionKey: row.id,
    });
  } catch {
    return row.globalStatementTemplateMarkdown;
  }
}

function loadAssertionRows() {
  return getDatabase().memoryAssertion.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    select: {
      id: true,
      kind: true,
      contextDependent: true,
      globalStatementTemplateMarkdown: true,
      chatCaptureId: true,
      sourceRegion: {
        select: {
          label: true,
          sourceDocument: { select: { title: true } },
        },
      },
      objectLinks: {
        orderBy: { globalObjectId: "asc" },
        select: {
          globalObject: { select: { id: true, canonicalName: true } },
        },
      },
    },
  });
}

export async function loadKnowledgeGraph(
  mode: KnowledgeGraphMode = "core",
): Promise<KnowledgeGraphPayload> {
  const database = getDatabase();
  const [rows, allObjects, totalAssertions] = await Promise.all([
    loadAssertionRows(),
    database.memoryGlobalObject.findMany({
      orderBy: { canonicalName: "asc" },
      select: { id: true, canonicalName: true },
    }),
    database.memoryAssertion.count(),
  ]);

  const projectedRows = rows.map((row) => ({
    row,
    objects: associatedObjects(row),
  })).filter((item) => item.objects.length > 0);

  const degreeByObjectId = new Map<string, number>();
  const objectNameById = new Map<string, string>();
  for (const item of projectedRows) {
    for (const object of item.objects) {
      degreeByObjectId.set(
        object.globalObjectId,
        (degreeByObjectId.get(object.globalObjectId) ?? 0) + 1,
      );
      objectNameById.set(object.globalObjectId, object.canonicalName);
    }
  }

  const connectedObjects = degreeByObjectId.size;
  const commonSummary = {
    totalObjects: allObjects.length,
    connectedObjects,
    unlinkedObjects: allObjects.length - connectedObjects,
    totalAssertions,
    connectedAssertions: projectedRows.length,
  };

  if (mode === "isolated") {
    const objects = allObjects
      .filter((object) => !degreeByObjectId.has(object.id))
      .map((object) => ({
        id: object.id,
        label: object.canonicalName,
        degree: 0,
      }));
    return {
      mode,
      summary: {
        ...commonSummary,
        visibleObjects: objects.length,
        visibleAssertions: 0,
        visibleConnections: 0,
        truncated: false,
      },
      objects,
      assertions: [],
      edges: [],
    };
  }

  const primaryObjectIds = new Set(
    [...degreeByObjectId.entries()]
      .sort((left, right) =>
        right[1] - left[1] ||
        (objectNameById.get(left[0]) ?? left[0]).localeCompare(
          objectNameById.get(right[0]) ?? right[0],
          "zh-CN",
        )
      )
      .slice(0, OBJECT_LIMIT)
      .map(([id]) => id),
  );

  const visibleAssertions = mode === "all"
    ? projectedRows.map((item) => ({
        ...item,
        visibleObjects: item.objects,
      }))
    : projectedRows
      .map((item) => ({
        ...item,
        visibleObjects: item.objects.filter((object) =>
          primaryObjectIds.has(object.globalObjectId)
        ),
      }))
      .filter((item) => item.visibleObjects.length > 0)
      .sort((left, right) => {
        const leftMulti = Number(left.visibleObjects.length > 1);
        const rightMulti = Number(right.visibleObjects.length > 1);
        const leftDegree = left.visibleObjects.reduce(
          (sum, object) => sum + (degreeByObjectId.get(object.globalObjectId) ?? 0),
          0,
        );
        const rightDegree = right.visibleObjects.reduce(
          (sum, object) => sum + (degreeByObjectId.get(object.globalObjectId) ?? 0),
          0,
        );
        return rightMulti - leftMulti ||
          right.visibleObjects.length - left.visibleObjects.length ||
          rightDegree - leftDegree ||
          left.row.id.localeCompare(right.row.id);
      })
      .slice(0, ASSERTION_LIMIT);

  const usedObjectIds = new Set(
    visibleAssertions.flatMap((item) =>
      item.visibleObjects.map((object) => object.globalObjectId)
    ),
  );
  const visibleDegree = new Map<string, number>();
  for (const assertion of visibleAssertions) {
    for (const object of assertion.visibleObjects) {
      visibleDegree.set(
        object.globalObjectId,
        (visibleDegree.get(object.globalObjectId) ?? 0) + 1,
      );
    }
  }

  const objects = [...usedObjectIds].map((id) => ({
    id,
    label: objectNameById.get(id) ?? id,
    degree: visibleDegree.get(id) ?? 0,
  })).sort((left, right) =>
    right.degree - left.degree || left.label.localeCompare(right.label, "zh-CN")
  );

  const assertions = visibleAssertions.map(({ row, visibleObjects }) => ({
    id: row.id,
    statement: renderStatement(row),
    kind: row.kind,
    contextDependent: row.contextDependent,
    objectIds: visibleObjects.map((object) => object.globalObjectId),
    sourceLabel: row.sourceRegion?.sourceDocument.title ?? row.sourceRegion?.label ??
      (row.chatCaptureId ? "聊天记忆" : "组织记忆"),
  }));
  const edges = assertions.flatMap((assertion) =>
    assertion.objectIds.map((objectId) => ({
      id: `${assertion.id}:${objectId}`,
      assertionId: assertion.id,
      objectId,
    }))
  );

  return {
    mode,
    summary: {
      ...commonSummary,
      visibleObjects: objects.length,
      visibleAssertions: assertions.length,
      visibleConnections: edges.length,
      truncated: mode === "core" && (
        projectedRows.length > visibleAssertions.length ||
        connectedObjects > objects.length
      ),
    },
    objects,
    assertions,
    edges,
  };
}
