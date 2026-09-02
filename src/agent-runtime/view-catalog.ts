import type { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";

export type ViewCatalogEntry = {
  key: string;
  label: string;
  description: string;
  retrievalDescription: string;
  specializedLabel?: string;
  schemaVersion: string;
  cardTypes: Array<{
    key: string;
    label: string;
    description: string;
  }>;
  queries: Array<{
    key: string;
    label: string;
    description: string;
  }>;
  supportsCommands: boolean;
};

/** Authoritative static definitions declared by installed View Plugins. */
export function createViewCatalog(registry: ExtensionRegistry): ViewCatalogEntry[] {
  return registry.listViews().map((view) => ({
    key: view.manifest.key,
    label: view.manifest.label,
    description: view.manifest.description,
    retrievalDescription:
      view.manifest.retrievalDescription ?? view.manifest.description,
    ...(view.manifest.specializedLabel
      ? { specializedLabel: view.manifest.specializedLabel }
      : {}),
    schemaVersion: view.manifest.schemaVersion,
    cardTypes: view.schema.cardTypes.map((cardType) => ({
      key: cardType.key,
      label: cardType.label,
      description: cardType.description,
    })),
    queries: view.queries.map((query) => ({
      key: query.key,
      label: query.label,
      description: query.description,
    })),
    supportsCommands: view.commands.some((command) =>
      command.allowedInitiators.includes("ai")
    ),
  }));
}

export function buildViewCatalogContext(registry: ExtensionRegistry): string {
  const entries = createViewCatalog(registry);
  return [
    "View Catalog：以下内容是已安装 View Plugin 声明的权威静态定义，不是当前 Card 状态。",
    "用户询问 View 是什么、负责什么、有哪些 Card 类型或可做哪些专业查询时，直接依据本 Catalog 回答；不要调用业务状态读取工具，也不要把 View 名当成业务实体目标。",
    "只有用户询问 View 中当前收录了什么、某个具体业务对象的状态，或需要修改 View 时，才调用 readViewState。",
    ...entries.flatMap((view) => [
      `- ${view.key}（${view.label}）${view.specializedLabel ? ` · ${view.specializedLabel}` : ""}：${view.description}`,
      `  Card 类型：${view.cardTypes.length
        ? view.cardTypes.map((cardType) => `${cardType.label}（${cardType.key}）`).join("、")
        : "无"}`,
      `  专业查询：${view.queries.length
        ? view.queries.map((query) => query.label).join("、")
        : "无"}；AI 写入：${view.supportsCommands ? "支持待审批 Command" : "不支持"}。`,
    ]),
  ].join("\n");
}
