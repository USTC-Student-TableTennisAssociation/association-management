import type { PrismaClient } from "@/generated/prisma/client";
import type {
  ActorContext,
  ViewCardState,
  ViewPresentationSnapshot,
  ViewReadPort,
  ViewReadSnapshot,
} from "@/contracts";
import { ViewNotFoundError, ViewRuntimeError } from "@/view-runtime/domain/errors";
import type { InstalledViewService } from "@/view-runtime/application/installed-views";
import type { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";

export type ObjectViewCardLocation = {
  viewKey: string;
  cardTypeKey: string;
};

export type ObjectViewCardDiscovery = {
  searchedViewKeys: readonly string[];
  cards: readonly ObjectViewCardLocation[];
};

export class PrismaViewReadPort implements ViewReadPort {
  constructor(
    private readonly registry: ExtensionRegistry,
    private readonly installedViews: InstalledViewService,
    private readonly database: PrismaClient,
  ) {}

  async query(input: {
    viewKey: string;
    query?: Readonly<Record<string, unknown>>;
    actor: ActorContext;
  }): Promise<ViewReadSnapshot> {
    if (!input.actor.permissions.includes("view.read")) {
      throw new ViewRuntimeError("缺少 View 读取权限：view.read");
    }
    await this.installedViews.synchronize();
    const viewModule = this.registry.getView(input.viewKey);
    if (!viewModule) throw new ViewNotFoundError(input.viewKey);
    const cardTypeKey = input.query?.cardTypeKey;
    if (cardTypeKey !== undefined && typeof cardTypeKey !== "string") {
      throw new ViewRuntimeError("View query.cardTypeKey 必须是字符串");
    }
    const installed = await this.database.installedView.findUnique({
      where: { viewKey: input.viewKey },
      include: {
        cards: {
          where: cardTypeKey ? { cardTypeKey } : undefined,
          orderBy: { createdAt: "asc" },
          include: {
            dimensions: { orderBy: { dimensionKey: "asc" } },
            outgoingSlots: {
              orderBy: [{ slotKey: "asc" }, { position: "asc" }, { createdAt: "asc" }],
            },
            relatedObjects: { orderBy: { createdAt: "asc" } },
          },
        },
      },
    });
    if (!installed || installed.status !== "enabled") throw new ViewNotFoundError(input.viewKey);
    if (installed.schemaVersion !== viewModule.manifest.schemaVersion) {
      throw new ViewRuntimeError(`View ${input.viewKey} Schema 不兼容`);
    }
    const owner = this.registry.getViewOwner(input.viewKey);
    if (!owner) throw new ViewRuntimeError(`View ${input.viewKey} 没有 Plugin owner`);
    return {
      viewKey: input.viewKey,
      pluginVersion: owner.pluginVersion,
      schemaVersion: viewModule.manifest.schemaVersion,
      stateVersion: installed.stateVersion.toString(),
      observedAt: new Date().toISOString(),
      cards: installed.cards.map((card): ViewCardState => {
        const slots: Record<string, string[]> = {};
        for (const binding of card.outgoingSlots) {
          (slots[binding.slotKey] ??= []).push(binding.targetCardId);
        }
        return {
          id: card.id,
          viewKey: card.viewKey,
          cardTypeKey: card.cardTypeKey,
          dimensions: Object.fromEntries(
            card.dimensions.map((dimension) => [dimension.dimensionKey, dimension.valueJson]),
          ),
          slots,
          relatedObjectIds: card.relatedObjects.map((relation) => relation.objectId),
        };
      }),
    };
  }

  async locateObject(input: {
    objectId: string;
    viewKeys: readonly string[];
    actor: ActorContext;
  }): Promise<ObjectViewCardDiscovery> {
    if (!input.actor.permissions.includes("view.read")) {
      throw new ViewRuntimeError("缺少 View 读取权限：view.read");
    }
    await this.installedViews.synchronize();
    const registeredViewKeys = [...new Set(input.viewKeys)].filter((viewKey) =>
      Boolean(this.registry.getView(viewKey))
    );
    if (!registeredViewKeys.length) {
      return { searchedViewKeys: [], cards: [] };
    }
    const enabledViews = await this.database.installedView.findMany({
      where: {
        viewKey: { in: registeredViewKeys },
        status: "enabled",
      },
      orderBy: { viewKey: "asc" },
      select: { viewKey: true },
    });
    const searchedViewKeys = enabledViews.map((view) => view.viewKey);
    if (!searchedViewKeys.length) {
      return { searchedViewKeys, cards: [] };
    }
    const cards = await this.database.viewCard.findMany({
      where: {
        viewKey: { in: searchedViewKeys },
        relatedObjects: { some: { objectId: input.objectId } },
      },
      orderBy: [{ viewKey: "asc" }, { createdAt: "asc" }],
      select: { viewKey: true, cardTypeKey: true },
    });
    return { searchedViewKeys, cards };
  }

  async inspect(input: {
    viewKey: string;
    actor: ActorContext;
    query?: Readonly<Record<string, unknown>>;
  }): Promise<ViewPresentationSnapshot> {
    const snapshot = await this.query(input);
    const viewModule = this.registry.getView(input.viewKey)!;
    const relatedObjectIds = [...new Set(
      snapshot.cards.flatMap((card) => card.relatedObjectIds),
    )];
    const objects = relatedObjectIds.length
      ? await this.database.memoryGlobalObject.findMany({
          where: { id: { in: relatedObjectIds } },
          orderBy: { canonicalName: "asc" },
          select: { id: true, canonicalName: true },
        })
      : [];
    return {
      ...snapshot,
      manifest: viewModule.manifest,
      schema: viewModule.schema,
      objects,
    };
  }
}
