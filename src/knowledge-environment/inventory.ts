import type { PrismaClient } from "@/generated/prisma/client";
import type { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";

export const knowledgeEnvironmentLayers = [
  "shared_brain",
  "library",
  "business_views",
] as const;

export type KnowledgeEnvironmentLayer = typeof knowledgeEnvironmentLayers[number];

export type KnowledgeEnvironmentInventoryInput = {
  layers?: readonly KnowledgeEnvironmentLayer[];
  includeExamples?: boolean;
  exampleLimit?: number;
};

type InventoryBoundary = {
  coverage: "complete";
  measurement: "exact";
};

export type SharedBrainInventory = InventoryBoundary & {
  objects: number;
  assertions: {
    total: number;
    grounded: number;
    reference: number;
  };
  higherMemories: {
    object: number;
    ambient: number;
  };
  vectorIndex: {
    status: "missing" | "ready" | "stale";
    indexedAssertions: number;
    totalAssertions: number;
    indexedAt: string | null;
  };
  objectExamples?: string[];
  note: string;
};

export type LibraryInventory = InventoryBoundary & {
  files: number;
  folders: number;
  uniqueContents: number;
  duplicateFileNodes: number;
  profiles: {
    catalog: number;
    coarse: number;
    deep: number;
  };
  statuses: {
    idle: number;
    queued: number;
    running: number;
    ready: number;
    failed: number;
  };
  sourceDocuments: number;
  publishedContents: number;
  failedCurrentRuns: number;
  fileExamples?: Array<{
    name: string;
    path: string | null;
    profile: "catalog" | "coarse" | "deep";
    status: "idle" | "queued" | "running" | "ready" | "failed";
  }>;
};

export type BusinessViewInventory = InventoryBoundary & {
  registered: number;
  installed: number;
  enabled: number;
  incompatible: number;
  totalCards: number;
  views: Array<{
    viewKey: string;
    label: string;
    status: "not_installed" | "enabled" | "incompatible";
    stateVersion: string | null;
    cardCount: number;
    cardTypes: Array<{ cardTypeKey: string; count: number }>;
    higherMemory: boolean;
    observedAt: string;
  }>;
};

export type KnowledgeEnvironmentInventory = {
  version: "knowledge-environment-overview.v1";
  observedAt: string;
  scope: "current_authenticated_workspace";
  requestedLayers: KnowledgeEnvironmentLayer[];
  sharedBrain?: SharedBrainInventory;
  library?: LibraryInventory;
  businessViews?: BusinessViewInventory;
  interpretation: {
    inventoryCountsAreGlobalWithinScope: true;
    retrievalCountsAreNotInventoryCounts: true;
    note: string;
  };
};

export type KnowledgeInventoryContext = {
  includeExamples: boolean;
  exampleLimit: number;
  observedAt: Date;
};

export interface KnowledgeInventoryProvider<
  TLayer extends KnowledgeEnvironmentLayer = KnowledgeEnvironmentLayer,
  TResult = unknown,
> {
  readonly layer: TLayer;
  inspect(context: KnowledgeInventoryContext): Promise<TResult>;
}

export type KnowledgeEnvironmentInventoryDependencies = {
  database: PrismaClient;
  registry: Pick<ExtensionRegistry, "listViews">;
  canReadView?: (viewKey: string) => boolean;
};

function countBy<T extends { _count: { _all: number } }>(
  rows: readonly T[],
  predicate: (row: T) => boolean,
): number {
  return rows
    .filter(predicate)
    .reduce((total, row) => total + row._count._all, 0);
}

function sharedBrainProvider(
  database: PrismaClient,
): KnowledgeInventoryProvider<"shared_brain", SharedBrainInventory> {
  return {
    layer: "shared_brain",
    async inspect(context) {
      const [
        objects,
        assertionGroups,
        objectHigherMemories,
        ambientHigherMemories,
        vectorIndex,
        objectExamples,
      ] = await Promise.all([
        database.memoryGlobalObject.count(),
        database.memoryAssertion.groupBy({
          by: ["kind"],
          _count: { _all: true },
        }),
        database.memoryObjectHigherMemory.count(),
        database.memoryAmbientHigherMemory.count(),
        database.memoryAssertionEmbeddingIndex.findUnique({
          where: { id: "shared" },
          select: { indexedAssertionCount: true, indexedAt: true },
        }),
        context.includeExamples
          ? database.memoryGlobalObject.findMany({
              orderBy: { canonicalName: "asc" },
              take: context.exampleLimit,
              select: { canonicalName: true },
            })
          : Promise.resolve([]),
      ]);
      const grounded = assertionGroups.find((row) => row.kind === "grounded")?._count._all ?? 0;
      const reference = assertionGroups.find((row) => row.kind === "reference")?._count._all ?? 0;
      const totalAssertions = grounded + reference;
      const indexedAssertions = vectorIndex?.indexedAssertionCount ?? 0;
      const vectorStatus = !vectorIndex
        ? "missing" as const
        : indexedAssertions === totalAssertions
          ? "ready" as const
          : "stale" as const;
      return {
        coverage: "complete",
        measurement: "exact",
        objects,
        assertions: { total: totalAssertions, grounded, reference },
        higherMemories: {
          object: objectHigherMemories,
          ambient: ambientHigherMemories,
        },
        vectorIndex: {
          status: vectorStatus,
          indexedAssertions,
          totalAssertions,
          indexedAt: vectorIndex?.indexedAt.toISOString() ?? null,
        },
        ...(context.includeExamples
          ? { objectExamples: objectExamples.map((object) => object.canonicalName) }
          : {}),
        note:
          "objects 包含账号绑定等仅有身份、尚无 Assertion 的 Object；不要把 Object 数量解释为事实条数。",
      };
    },
  };
}

function libraryProvider(
  database: PrismaClient,
): KnowledgeInventoryProvider<"library", LibraryInventory> {
  return {
    layer: "library",
    async inspect(context) {
      const [
        nodeGroups,
        uniqueContents,
        sourceDocuments,
        publishedContents,
        failedCurrentRuns,
        fileExamples,
      ] = await Promise.all([
        database.libraryNode.groupBy({
          by: ["kind", "processingProfile", "processingStatus"],
          where: { parentId: { not: null } },
          _count: { _all: true },
        }),
        database.librarySourceBlob.count(),
        database.librarySourceDocument.count(),
        database.librarySourceProcessingRun.count({
          where: { isCurrent: true, publishedAt: { not: null } },
        }),
        database.librarySourceProcessingRun.count({
          where: { isCurrent: true, status: "failed" },
        }),
        context.includeExamples
          ? database.libraryNode.findMany({
              where: { kind: "file" },
              orderBy: { updatedAt: "desc" },
              take: context.exampleLimit,
              select: {
                name: true,
                originalRelativePath: true,
                processingProfile: true,
                processingStatus: true,
              },
            })
          : Promise.resolve([]),
      ]);
      const files = countBy(nodeGroups, (row) => row.kind === "file");
      const folders = countBy(nodeGroups, (row) => row.kind === "folder");
      return {
        coverage: "complete",
        measurement: "exact",
        files,
        folders,
        uniqueContents,
        duplicateFileNodes: Math.max(0, files - uniqueContents),
        profiles: {
          catalog: countBy(
            nodeGroups,
            (row) => row.kind === "file" && row.processingProfile === "catalog",
          ),
          coarse: countBy(
            nodeGroups,
            (row) => row.kind === "file" && row.processingProfile === "coarse",
          ),
          deep: countBy(
            nodeGroups,
            (row) => row.kind === "file" && row.processingProfile === "deep",
          ),
        },
        statuses: {
          idle: countBy(
            nodeGroups,
            (row) => row.kind === "file" && row.processingStatus === "idle",
          ),
          queued: countBy(
            nodeGroups,
            (row) => row.kind === "file" && row.processingStatus === "queued",
          ),
          running: countBy(
            nodeGroups,
            (row) => row.kind === "file" && row.processingStatus === "running",
          ),
          ready: countBy(
            nodeGroups,
            (row) => row.kind === "file" && row.processingStatus === "ready",
          ),
          failed: countBy(
            nodeGroups,
            (row) => row.kind === "file" && row.processingStatus === "failed",
          ),
        },
        sourceDocuments,
        publishedContents,
        failedCurrentRuns,
        ...(context.includeExamples
          ? {
              fileExamples: fileExamples.map((file) => ({
                name: file.name,
                path: file.originalRelativePath,
                profile: file.processingProfile,
                status: file.processingStatus,
              })),
            }
          : {}),
      };
    },
  };
}

function businessViewsProvider(
  dependencies: KnowledgeEnvironmentInventoryDependencies,
): KnowledgeInventoryProvider<"business_views", BusinessViewInventory> {
  return {
    layer: "business_views",
    async inspect(context) {
      const registeredViews = dependencies.registry.listViews()
        .filter((view) => dependencies.canReadView?.(view.manifest.key) ?? true)
        .sort((left, right) => left.manifest.key.localeCompare(right.manifest.key));
      const visibleViewKeys = registeredViews.map((view) => view.manifest.key);
      const [installedViews, cardGroups, higherMemories] = visibleViewKeys.length
        ? await Promise.all([
            dependencies.database.installedView.findMany({
              where: { viewKey: { in: visibleViewKeys } },
              select: {
                viewKey: true,
                status: true,
                stateVersion: true,
              },
            }),
            dependencies.database.viewCard.groupBy({
              by: ["viewKey", "cardTypeKey"],
              where: { viewKey: { in: visibleViewKeys } },
              _count: { _all: true },
            }),
            dependencies.database.viewHigherMemory.findMany({
              where: { viewKey: { in: visibleViewKeys } },
              select: { viewKey: true },
            }),
          ])
        : [[], [], []];
      const installedByKey = new Map(installedViews.map((view) => [view.viewKey, view]));
      const higherMemoryKeys = new Set(higherMemories.map((memory) => memory.viewKey));
      const observedAt = context.observedAt.toISOString();
      const views = registeredViews.map((view) => {
        const installed = installedByKey.get(view.manifest.key);
        const cardTypes = cardGroups
          .filter((group) => group.viewKey === view.manifest.key)
          .map((group) => ({
            cardTypeKey: group.cardTypeKey,
            count: group._count._all,
          }))
          .sort((left, right) => left.cardTypeKey.localeCompare(right.cardTypeKey));
        return {
          viewKey: view.manifest.key,
          label: view.manifest.label,
          status: installed?.status ?? "not_installed" as const,
          stateVersion: installed?.stateVersion.toString() ?? null,
          cardCount: cardTypes.reduce((total, cardType) => total + cardType.count, 0),
          cardTypes,
          higherMemory: higherMemoryKeys.has(view.manifest.key),
          observedAt,
        };
      });
      return {
        coverage: "complete",
        measurement: "exact",
        registered: registeredViews.length,
        installed: installedViews.length,
        enabled: installedViews.filter((view) => view.status === "enabled").length,
        incompatible: installedViews.filter((view) => view.status === "incompatible").length,
        totalCards: views.reduce((total, view) => total + view.cardCount, 0),
        views,
      };
    },
  };
}

export function createKnowledgeInventoryProviders(
  dependencies: KnowledgeEnvironmentInventoryDependencies,
): Array<KnowledgeInventoryProvider> {
  return [
    sharedBrainProvider(dependencies.database),
    libraryProvider(dependencies.database),
    businessViewsProvider(dependencies),
  ];
}

export async function inspectKnowledgeEnvironment(
  input: KnowledgeEnvironmentInventoryInput,
  dependencies: KnowledgeEnvironmentInventoryDependencies,
): Promise<KnowledgeEnvironmentInventory> {
  const requestedLayers = [...new Set(
    input.layers?.length ? input.layers : knowledgeEnvironmentLayers,
  )];
  const context: KnowledgeInventoryContext = {
    includeExamples: input.includeExamples ?? false,
    exampleLimit: Math.min(Math.max(input.exampleLimit ?? 3, 1), 10),
    observedAt: new Date(),
  };
  const providers = createKnowledgeInventoryProviders(dependencies)
    .filter((provider) => requestedLayers.includes(provider.layer));
  const results = await Promise.all(providers.map(async (provider) => ({
    layer: provider.layer,
    value: await provider.inspect(context),
  })));
  const byLayer = new Map(results.map((result) => [result.layer, result.value]));
  return {
    version: "knowledge-environment-overview.v1",
    observedAt: context.observedAt.toISOString(),
    scope: "current_authenticated_workspace",
    requestedLayers,
    ...(byLayer.has("shared_brain")
      ? { sharedBrain: byLayer.get("shared_brain") as SharedBrainInventory }
      : {}),
    ...(byLayer.has("library")
      ? { library: byLayer.get("library") as LibraryInventory }
      : {}),
    ...(byLayer.has("business_views")
      ? { businessViews: byLayer.get("business_views") as BusinessViewInventory }
      : {}),
    interpretation: {
      inventoryCountsAreGlobalWithinScope: true,
      retrievalCountsAreNotInventoryCounts: true,
      note:
        "本结果是当前可访问工作环境的分层总览；searchMemory/Locate 的 counts 只表示单次检索命中，不能替代本总览。",
    },
  };
}
