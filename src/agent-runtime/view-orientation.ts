import { getDatabase } from "@/db";
import type { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";

export function buildViewOrientationContext(registry: ExtensionRegistry): string {
  return [
    "Business View Compass：只用于选择可操作的业务运行视角，不是当前状态证据。",
    ...registry.listViews().map((view) =>
      `- ${view.manifest.key}（${view.manifest.label}）：` +
      (view.manifest.retrievalDescription ?? view.manifest.description)
    ),
    "需要当前状态时请通过 openBusinessContext/readView 读取统一 ViewReadPort。",
  ].join("\n");
}

export async function loadViewHigherMemory(viewKey: string) {
  const memory = await getDatabase().viewHigherMemory.findUnique({
    where: { viewKey },
    select: { contentMarkdown: true, maintainedAt: true },
  });
  return memory
    ? {
        viewKey,
        contentMarkdown: memory.contentMarkdown,
        maintainedAt: memory.maintainedAt.toISOString(),
      }
    : undefined;
}
