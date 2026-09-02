import { getDatabase } from "@/db";

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
