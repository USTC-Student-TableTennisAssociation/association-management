import type { PrismaClient } from "@/generated/prisma/client";
import type {
  ActorContext,
  ViewCardState,
  ViewReadPort,
  ViewReadSnapshot,
} from "@/contracts";
import { ViewNotFoundError, ViewRuntimeError } from "@/view-runtime/domain/errors";
import type { InstalledViewService } from "@/view-runtime/application/installed-views";
import type { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";

export type ViewInspectorSnapshot = ViewReadSnapshot & {
  schema: ReturnType<typeof serializableViewSchema>;
  manifest: {
    key: string;
    label: string;
    version: string;
    schemaVersion: string;
    description: string;
  };
};

function serializableViewSchema(registry: ExtensionRegistry, viewKey: string) {
  const viewModule = registry.getView(viewKey);
  if (!viewModule) throw new ViewNotFoundError(viewKey);
  return viewModule.schema;
}

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
            outgoingSlots: { orderBy: [{ slotKey: "asc" }, { createdAt: "asc" }] },
            relatedObjects: { orderBy: { createdAt: "asc" } },
          },
        },
      },
    });
    if (!installed || installed.status !== "enabled") throw new ViewNotFoundError(input.viewKey);
    if (
      installed.moduleVersion !== viewModule.manifest.version ||
      installed.schemaVersion !== viewModule.manifest.schemaVersion
    ) {
      throw new ViewRuntimeError(`View ${input.viewKey} 安装版本不兼容`);
    }
    return {
      viewKey: input.viewKey,
      moduleVersion: viewModule.manifest.version,
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
      references: [],
    };
  }

  async inspect(input: {
    viewKey: string;
    actor: ActorContext;
    query?: Readonly<Record<string, unknown>>;
  }): Promise<ViewInspectorSnapshot> {
    const snapshot = await this.query(input);
    const viewModule = this.registry.getView(input.viewKey)!;
    return {
      ...snapshot,
      manifest: {
        key: viewModule.manifest.key,
        label: viewModule.manifest.label,
        version: viewModule.manifest.version,
        schemaVersion: viewModule.manifest.schemaVersion,
        description: viewModule.manifest.description,
      },
      schema: serializableViewSchema(this.registry, input.viewKey),
    };
  }
}
