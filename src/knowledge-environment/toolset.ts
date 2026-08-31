import { tool } from "ai";
import { z } from "zod";

import {
  inspectKnowledgeEnvironment,
  knowledgeEnvironmentLayers,
  type KnowledgeEnvironmentInventory,
  type KnowledgeEnvironmentInventoryDependencies,
} from "@/knowledge-environment/inventory";

export function createKnowledgeEnvironmentTool(input: {
  dependencies: KnowledgeEnvironmentInventoryDependencies;
  onInspect?: (inventory: KnowledgeEnvironmentInventory) => void;
}) {
  return tool({
    description: [
      "读取 Sydaris 当前可访问工作环境的分层知识总览。",
      "当用户问‘你知道什么’、‘环境里有什么知识’、‘知识库有多大’、‘有多少 Object/Assertion/文件/View/Card’，或需要先判断环境是否为空时使用。",
      "一次返回 Shared Brain、Library 与 Business View 的精确库存统计、观察时间和覆盖边界；它不读取 Assertion 正文或文件原文，也不修改任何状态。",
      "本工具的 inventory counts 才表示范围内总量；searchMemory、Locate、文件标题查询等工具返回的 counts 只表示单次命中，绝不能据此推断全库为空。",
      "用户问具体主题事实时直接使用 searchMemory/openBusinessContext/openArtifacts；不要为了每个普通事实查询都先调用本工具。",
    ].join("\n"),
    inputSchema: z.object({
      layers: z.array(z.enum(knowledgeEnvironmentLayers)).min(1).max(3).optional()
        .describe("省略表示读取全部三层；只在用户明确限定知识层时缩小范围"),
    }),
    execute: async ({ layers }) => {
      const inventory = await inspectKnowledgeEnvironment({
        layers,
        includeExamples: false,
      }, input.dependencies);
      input.onInspect?.(inventory);
      return inventory;
    },
  });
}
