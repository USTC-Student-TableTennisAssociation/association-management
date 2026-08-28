import { z } from "zod";

import type { ToolCapabilityContract } from "@/contracts/tool";
import { zodContractSchema } from "@/contracts/schema";

const artifactSchema = z.object({
  id: z.string(),
  name: z.string(),
  mediaType: z.string().optional(),
});

export const builtinToolCapabilityContracts: readonly ToolCapabilityContract[] = [
  {
    key: "calendar.read",
    version: "1.0.0",
    description: "读取日历时间范围内的事件。",
    semanticContract: "返回 Provider 真实可见的日历事件，不推断或创建事件。",
    inputSchema: zodContractSchema(z.object({
      start: z.string().datetime({ offset: true }),
      end: z.string().datetime({ offset: true }),
      calendarId: z.string().optional(),
    })),
    outputSchema: zodContractSchema(z.object({
      events: z.array(z.object({
        id: z.string(),
        title: z.string(),
        start: z.string(),
        end: z.string().optional(),
      })),
    })),
    sideEffect: "none",
    allowedCallers: ["agent"],
    requiredPermissions: ["tool.calendar.read"],
  },
  {
    key: "calendar.write",
    version: "1.0.0",
    description: "创建一个日历事件。",
    semanticContract: "只创建输入明确描述的单个事件，返回 Provider 事件 ID。",
    inputSchema: zodContractSchema(z.object({
      title: z.string().min(1),
      start: z.string().datetime({ offset: true }),
      end: z.string().datetime({ offset: true }).optional(),
      calendarId: z.string().optional(),
    })),
    outputSchema: zodContractSchema(z.object({ id: z.string(), created: z.boolean() })),
    sideEffect: "reversible",
    allowedCallers: ["agent"],
    requiredPermissions: ["tool.calendar.write"],
    supportsDryRun: true,
  },
  {
    key: "email.send",
    version: "1.0.0",
    description: "发送一封电子邮件。",
    semanticContract: "向明确收件人发送输入中的主题和正文；Provider 不修改业务 View。",
    inputSchema: zodContractSchema(z.object({
      to: z.array(z.string().email()).min(1),
      subject: z.string().min(1),
      body: z.string(),
    })),
    outputSchema: zodContractSchema(z.object({ messageId: z.string(), accepted: z.boolean() })),
    sideEffect: "external_irreversible",
    allowedCallers: ["agent"],
    requiredPermissions: ["tool.email.send"],
    supportsDryRun: true,
  },
  {
    key: "receipt.extract",
    version: "1.0.0",
    description: "从票据 Artifact 提取结构化字段。",
    semanticContract: "返回可见票据上的提取结果和缺失字段，不自行补齐金额或币种。",
    inputSchema: zodContractSchema(z.object({ artifact: artifactSchema })),
    outputSchema: zodContractSchema(z.object({
      merchant: z.string().optional(),
      amount: z.string().optional(),
      currency: z.string().optional(),
      issuedOn: z.string().optional(),
      missingFields: z.array(z.string()),
    })),
    sideEffect: "none",
    allowedCallers: ["agent"],
    requiredPermissions: ["tool.receipt.read"],
  },
  {
    key: "document.read",
    version: "1.0.0",
    description: "读取一个文档 Artifact。",
    semanticContract: "返回指定 Artifact 的文本内容和媒体类型。",
    inputSchema: zodContractSchema(z.object({ artifact: artifactSchema })),
    outputSchema: zodContractSchema(z.object({ text: z.string(), truncated: z.boolean() })),
    sideEffect: "none",
    allowedCallers: ["agent"],
    requiredPermissions: ["tool.document.read"],
  },
  {
    key: "file.store",
    version: "1.0.0",
    description: "保存一个文件 Artifact。",
    semanticContract: "保存输入内容并返回可后续引用的 Artifact，不写入业务 View。",
    inputSchema: zodContractSchema(z.object({
      name: z.string().min(1),
      mediaType: z.string(),
      contentBase64: z.string(),
    })),
    outputSchema: zodContractSchema(z.object({ artifact: artifactSchema })),
    sideEffect: "reversible",
    allowedCallers: ["agent"],
    requiredPermissions: ["tool.file.store"],
    supportsDryRun: true,
  },
];
