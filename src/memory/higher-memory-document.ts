import { z } from "zod";

export const cognitiveMemorySchema = z.object({
  identityAndBoundaries: z.string().trim().min(1).max(2_000),
  narrativeAndMeaning: z.string().trim().max(3_000).default(""),
  structuralModel: z.string().trim().max(3_000).default(""),
  operatingModel: z.string().trim().max(3_000).default(""),
  currentSituation: z.string().trim().max(3_000).default(""),
  openQuestions: z.array(z.string().trim().min(1).max(500)).max(12).default([]),
});

export const operationalMemoryIndexSchema = z.object({
  aspects: z.array(z.object({
    key: z.string().trim().min(1).max(100),
    label: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(1_000),
    coverage: z.enum(["unknown", "partial", "substantial"]),
    assertionIds: z.array(z.string().uuid()).max(24).default([]),
    sourceNodeIds: z.array(z.string().trim().min(1).max(500)).max(24).default([]),
    sourceTitles: z.array(z.string().trim().min(1).max(500)).max(24).default([]),
    recommendedQueries: z.array(z.string().trim().min(1).max(500)).max(8).default([]),
    unresolvedAspects: z.array(z.string().trim().min(1).max(500)).max(12).default([]),
  })).max(16).default([]),
});

export type CognitiveMemory = z.infer<typeof cognitiveMemorySchema>;
export type OperationalMemoryIndex = z.infer<typeof operationalMemoryIndexSchema>;

export const emptyOperationalMemoryIndex = (): OperationalMemoryIndex => ({ aspects: [] });

export function parseCognitiveMemory(value: unknown): CognitiveMemory {
  return cognitiveMemorySchema.parse(value);
}

export function parseOperationalMemoryIndex(value: unknown): OperationalMemoryIndex {
  return operationalMemoryIndexSchema.parse(value);
}

export function renderCognitiveMemory(memory: CognitiveMemory): string {
  const sections = [
    ["身份与边界", memory.identityAndBoundaries],
    ["叙事与意义", memory.narrativeAndMeaning],
    ["结构模型", memory.structuralModel],
    ["运行模型", memory.operatingModel],
    ["当前态势", memory.currentSituation],
  ].flatMap(([title, body]) => body.trim() ? [`## ${title}\n\n${body.trim()}`] : []);
  if (memory.openQuestions.length) {
    sections.push(`## 待确认事项\n\n${memory.openQuestions.map((item) => `- ${item}`).join("\n")}`);
  }
  return sections.join("\n\n");
}

export function renderOperationalMemoryIndex(index: OperationalMemoryIndex): string {
  if (!index.aspects.length) return "暂无结构化任务导航。";
  return index.aspects.map((aspect) => {
    const details = [
      `- 覆盖程度：${aspect.coverage}`,
      aspect.sourceTitles.length ? `- 主要来源：${aspect.sourceTitles.join("、")}` : "",
      aspect.unresolvedAspects.length ? `- 尚未覆盖：${aspect.unresolvedAspects.join("；")}` : "",
      aspect.recommendedQueries.length ? `- 推荐检索：${aspect.recommendedQueries.join("；")}` : "",
    ].filter(Boolean).join("\n");
    return `### ${aspect.label}（${aspect.key}）\n\n${aspect.summary}\n\n${details}`;
  }).join("\n\n");
}
