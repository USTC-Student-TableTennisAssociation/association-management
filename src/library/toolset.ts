import { tool } from "ai";
import { z } from "zod";

import { previewLibraryFiles } from "@/library/chat-preview";
import {
  createLibraryPlan,
  getLibraryListing,
  inspectLibraryNodes,
  isLibraryNoiseName,
  listLibraryDescendants,
  searchLibrary,
} from "@/library/service";
import { getLibraryCompilationOverview } from "@/library/compilation-service";
import {
  libraryPlanPayloadSchema,
  type LibraryPlanPresentation,
  type LibraryNodeView,
} from "@/library/types";

function presentLibraryNode(node: LibraryNodeView, detail: "compact" | "full") {
  if (detail === "full") return node;
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    ...(node.originalRelativePath ? { path: node.originalRelativePath } : {}),
    profile: node.processingProfile,
    status: node.processingStatus,
    ...(node.mimeType ? { mimeType: node.mimeType } : {}),
  };
}

export function createLibraryToolset(input: {
  onProposal?: (proposal: LibraryPlanPresentation) => void;
  onPreview?: (result: {
    requestedCount: number;
    returnedCount: number;
    missingNodeIds: string[];
    partial: boolean;
    items: Awaited<ReturnType<typeof previewLibraryFiles>>;
  }) => void;
}) {
  return {
    tools: {
      listLibrary: tool({
        description: [
          "查看 Sydaris 资料库的文件夹、文件索引和处理档位。",
          "返回文件名、原始相对路径、格式与 catalog/coarse/deep 状态；full 模式另含大小和哈希等技术字段。它不读取文件内容。",
          "catalog（仅归档）文件没有被解析，不得从文件名推断其内容事实。",
          "盘点多层文件时使用 recursive=true，通常同时设置 kind=file、profile/queries/extensions；多个目录放入 folderIds。不要逐层遍历，也不要从历史文字猜测 UUID。",
          "query/queries 是不区分大小写的文件名或路径字面包含查询，不是正则或通配符；queries 中任意一项命中即返回。extensions 传 docx/pdf 这样的后缀。",
          "默认过滤 .DS_Store、~$ Office 锁文件、desktop.ini 等系统噪音，且 detail=compact 不返回 SHA-256/字节数/更新时间。确实需要时才改用 includeNoise=true 或 detail=full。",
          "递归结果会返回 matchedCount、returnedCount、truncated 和 nextOffset。truncated=true 时可传回 nextOffset 继续，也可收紧过滤条件。",
        ].join("\n"),
        inputSchema: z.object({
          folderId: z.string().uuid().optional().describe("一个目标文件夹；省略表示资料库根目录"),
          folderIds: z.array(z.string().uuid()).min(1).max(50).optional()
            .describe("多个目标文件夹的并集，仅用于 recursive=true"),
          query: z.string().trim().max(200).optional()
            .describe("单个字面包含词，同时搜文件名和原始路径；不支持正则/通配符"),
          queries: z.array(z.string().trim().min(1).max(200)).min(1).max(20).optional()
            .describe("多个字面包含词，任意一个命中即返回，例如 [\"策划\",\"通知\",\"赛制\"]"),
          extensions: z.array(z.string().trim().min(1).max(20)).min(1).max(20).optional()
            .describe("文件后缀过滤，例如 [\"docx\",\"pdf\"]；不要传 *.docx 通配表达式"),
          recursive: z.boolean().default(false)
            .describe("是否遍历目标文件夹的所有子层"),
          kind: z.enum(["file", "folder"]).optional()
            .describe("只返回文件或只返回文件夹；文件盘点优先用 file"),
          profile: z.enum(["catalog", "coarse", "deep"]).optional()
            .describe("只返回指定处理档位"),
          includeNoise: z.boolean().default(false)
            .describe("是否包含操作系统索引、Office 锁文件等噪音；默认否"),
          detail: z.enum(["compact", "full"]).default("compact")
            .describe("索引盘点用 compact；只在需要哈希、字节数等技术字段时用 full"),
          offset: z.number().int().min(0).max(1_000_000).default(0)
            .describe("递归结果分页偏移；truncated=true 时传回 nextOffset"),
          limit: z.number().int().min(1).max(1_000).default(300),
        }),
        execute: async ({
          folderId,
          folderIds,
          query,
          queries,
          extensions,
          recursive,
          kind,
          profile,
          includeNoise,
          detail,
          offset,
          limit,
        }) => {
          if (recursive) {
            const listing = await listLibraryDescendants({
              folderId,
              folderIds,
              query,
              queries,
              extensions,
              kind,
              profile,
              includeNoise,
              offset,
              limit,
            });
            return {
              mode: "recursive" as const,
              ...listing,
              items: listing.items.map((node) => presentLibraryNode(node, detail)),
            };
          }
          if (folderIds?.length) {
            throw new Error("folderIds 只能与 recursive=true 一起使用");
          }
          if (query || queries?.length || extensions?.length || kind || profile || offset > 0) {
            return {
              mode: "search" as const,
              scope: folderId ? "direct-children" as const : "entire-library" as const,
              items: (await searchLibrary({
                query,
                queries,
                extensions,
                folderId,
                kind,
                profile,
                includeNoise,
                offset,
                limit,
              })).map((node) => presentLibraryNode(node, detail)),
            };
          }
          const listing = await getLibraryListing(folderId);
          return {
            mode: "folder" as const,
            ...listing,
            items: listing.items
              .filter((node) => includeNoise || !isLibraryNoiseName(node.name))
              .map((node) => presentLibraryNode(node, detail)),
          };
        },
      }),
      inspectLibraryNodes: tool({
        description: [
          "读取一组资料库节点的精确索引信息，供整理与处理档位建议使用。",
          "该工具不读取原文、不做 OCR，也不生成 Assertion。",
        ].join("\n"),
        inputSchema: z.object({ nodeIds: z.array(z.string().uuid()).min(1).max(100) }),
        execute: async ({ nodeIds }) => ({ items: await inspectLibraryNodes(nodeIds) }),
      }),
      previewLibraryFiles: tool({
        description: [
          "只对已经用索引筛出的少量模糊文件读取短摘要，帮助判断 catalog/coarse/deep 档位。",
          "它不会改处理档位、不会生成 Assertion，也不会发布到 Shared Brain。",
          "默认只复用数据库原文或直接读取文本，不启动 MinerU。PDF/DOCX/PPTX/XLSX 无可复用原文时，只有 parseIfMissing=true 才调用当前高精度 MinerU，可能较慢。",
          "parseIfMissing=true 仅用于文件名/路径确实无法判断的个别文件，且需确认当前运行机可承受 MinerU；每次最多 3 份，不得批量扫描。",
          "图片不在这个工具里启动视觉模型；图片保留给基础编译的独立多模态线路。",
          "结果始终返回 requestedCount、returnedCount 和 missingNodeIds；不得把部分返回误解为其余文件不存在或没有内容。",
        ].join("\n"),
        inputSchema: z.object({
          nodeIds: z.array(z.string().uuid()).min(1).max(3)
            .describe("必须是 listLibrary 真实返回的文件 nodeId"),
          maxChars: z.number().int().min(200).max(8_000).default(2_000)
            .describe("每份文件最多返回的文本字符数"),
          parseIfMissing: z.boolean().default(false)
            .describe("数据库无原文时是否允许在当前机器启动高精度 MinerU；默认否"),
        }),
        execute: async ({ nodeIds, maxChars, parseIfMissing }) => {
          const requestedNodeIds = [...new Set(nodeIds)];
          const items = await previewLibraryFiles({
            nodeIds: requestedNodeIds,
            maxChars,
            parseIfMissing,
          });
          const returnedNodeIds = new Set(items.map((item) => item.id));
          const result = {
            requestedCount: requestedNodeIds.length,
            returnedCount: items.length,
            missingNodeIds: requestedNodeIds.filter((id) => !returnedNodeIds.has(id)),
            partial: items.length !== requestedNodeIds.length,
            items,
          };
          input.onPreview?.(result);
          return result;
        },
      }),
      readLibraryCompilation: tool({
        description: [
          "读取最新基础编译工作快照的阶段进度、当前文件和失败项。",
          "每份结果会明确显示 publishedAt 和已发布 Assertion/Object 数；只有 publishedAt 存在的结果才已进入 Shared Brain。",
        ].join("\n"),
        inputSchema: z.object({ jobId: z.string().uuid().optional() }),
        execute: async ({ jobId }) => getLibraryCompilationOverview(jobId, false),
      }),
      proposeLibraryPlan: tool({
        description: [
          "提出资料库整理建议：可新建文件夹、移动已有节点，或设置 catalog/coarse/deep 处理档位。",
          "这是 Proposal，调用时不会改变文件树；只有用户点击批准后才会原子应用。",
          "不支持删除。对内容不明的文件优先保持 catalog，不要为了整齐而过度处理。",
        ].join("\n"),
        inputSchema: libraryPlanPayloadSchema,
        execute: async (payload) => {
          const proposal = await createLibraryPlan(payload);
          input.onProposal?.(proposal);
          return {
            proposalId: proposal.id,
            status: proposal.status,
            message: "资料库建议已进入当前对话，只有用户批准后才会应用。",
          };
        },
      }),
    },
  };
}
