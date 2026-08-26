import { z } from "zod";

import {
  defineEchoPlugin,
  defineView,
  zodContractSchema,
  type CommandDefinition,
  type PresentationExtension,
  type SkillExtension,
  type ToolProviderExtension,
} from "@echo/plugin-sdk";

const VIEW_KEY = "example_notes";
const createNoteInput = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().max(5_000).optional(),
});

const createNote: CommandDefinition<z.infer<typeof createNoteInput>> = {
  key: "example.create_note",
  version: "1",
  label: "创建笔记",
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(createNoteInput),
  proposalApprovalConflictPolicy: () => "revalidate_latest",
  async execute(context, input) {
    const cardId = await context.transaction.createCard({
      cardTypeKey: "NoteCard",
      dimensions: {
        title: input.title,
        ...(input.body ? { body: input.body } : {}),
      },
    });
    return {
      summary: { cardId },
      events: [{
        type: "example.note_created",
        version: "1",
        payload: { cardId },
      }],
    };
  },
};

const exampleNotesView = defineView({
  manifest: {
    key: VIEW_KEY,
    label: "Example Notes",
    specializedLabel: "示例笔记",
    schemaVersion: "1",
    description: "用于验证 Echo 在线 Plugin 安装、专属 UI、Command、Skill 和 Tool 的示例 View。",
    retrievalDescription: "用于读取由示例 Plugin 创建的简短笔记。",
    aiSemanticInstructions: "笔记是用户明确保存的测试内容，不应被扩写为组织事实。",
    defaultSettings: { aiWritePolicy: "approval_required" },
  },
  schema: {
    viewKey: VIEW_KEY,
    schemaVersion: "1",
    cardTypes: [{
      key: "NoteCard",
      label: "笔记",
      description: "一条由示例 Plugin 管理的笔记。",
      dimensions: [
        { key: "title", label: "标题", type: "text", required: true },
        { key: "body", label: "正文", type: "rich_text", presentation: { multiline: true } },
      ],
      slots: [],
    }],
  },
  commands: [createNote],
  invariants: [],
  events: [{
    key: "example.note_created",
    version: "1",
    payloadSchema: zodContractSchema(z.object({ cardId: z.string().uuid() })),
  }],
  projections: [],
});

const examplePresentation: PresentationExtension = {
  id: "echo.example-notes.presentation",
  version: "0.1.0",
  targetView: VIEW_KEY,
  schemaVersion: "1",
  presentations: [{
    key: "workspace",
    label: "示例笔记工作区",
    loader: "echo.example-notes/workspace",
  }],
};

const exampleSkill: SkillExtension = {
  id: "echo.example-notes.daily-planner",
  version: "0.1.0",
  targetView: { viewKey: VIEW_KEY, schemaVersion: "1" },
  requiresCapabilities: [{ key: "calendar.read", versions: "^1.0.0" }],
  inputSchema: zodContractSchema(z.object({ focus: z.string().optional() })),
};

const exampleToolProvider: ToolProviderExtension = {
  id: "echo.example-calendar",
  version: "0.1.0",
  implementations: [{
    capability: { key: "calendar.read", version: "1.0.0" },
    async execute(_context, input) {
      const range = input as { start?: string; end?: string };
      return {
        events: [{
          id: "echo-example-calendar",
          title: "Echo Example Plugin",
          start: range.start ?? new Date(0).toISOString(),
          ...(range.end ? { end: range.end } : {}),
        }],
      };
    },
  }],
};

export const exampleNotesPlugin = defineEchoPlugin({
  id: "echo.example-notes",
  version: "0.1.0",
  contributes: {
    views: [exampleNotesView],
    presentations: [examplePresentation],
    skills: [exampleSkill],
    tools: [exampleToolProvider],
  },
});
