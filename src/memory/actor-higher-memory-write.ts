import { tool } from "ai";
import { z } from "zod";

import type { DebugTrace } from "@/ai/debug-trace";
import { getDatabase } from "@/db";
import {
  actorHigherMemoryQualityIssue,
} from "@/memory/actor-higher-memory";
import {
  actorHigherMemoryScopes,
  type ActorHigherMemoryScope,
} from "@/memory/actor-higher-memory-queue";

const replaceRevisionSchema = z.object({
  action: z.literal("replace"),
  scope: z.enum(actorHigherMemoryScopes),
  contentMarkdown: z.string().trim().min(20).max(8_000)
    .describe("该 scope 修订后的完整自然语言正文；必须保留未被本轮改变的旧内容"),
  evidenceQuote: z.string().trim().min(1).max(800)
    .describe("触发本次修订的当前用户消息逐字引文"),
});

const clearRevisionSchema = z.object({
  action: z.literal("clear"),
  scope: z.enum(actorHigherMemoryScopes),
  evidenceQuote: z.string().trim().min(1).max(800)
    .describe("当前用户要求忘记该 scope 最后一项内容的逐字引文"),
});

const revisionSchema = z.discriminatedUnion("action", [
  replaceRevisionSchema,
  clearRevisionSchema,
]);

export type ActorHigherMemoryWriteSummary = {
  replacedScopes: ActorHigherMemoryScope[];
  clearedScopes: ActorHigherMemoryScope[];
};

function normalized(value: string): string {
  return value.normalize("NFKC");
}

function quoteIsGrounded(message: string, quote: string): boolean {
  return normalized(message).includes(normalized(quote));
}

export function createActorHigherMemoryWriteToolset(input: {
  actorId: string;
  currentMessageId: string;
  currentUserMessage: string;
  trace?: DebugTrace;
  onCommitted?: (summary: ActorHigherMemoryWriteSummary) => void;
}) {
  let commitSummary: ActorHigherMemoryWriteSummary = {
    replacedScopes: [],
    clearedScopes: [],
  };

  const writeTool = tool({
    description: [
      "同步修订只属于当前认证 Actor 的自然语言 Higher Memory。当前用户明确要求跨会话记住、修改或忘记私人称呼、互动约定、稳定工作方式或私人近期工作集时调用；不要只在文本中答应。",
      "正文必须使用不依赖当前对话视角的自然语言。涉及关系时，明确写出发起者、动作和接受者或对象，不用可能随说话者变化的‘我/你’代替关系角色，也不要把记忆改写成语义 key-value。",
      "replace 必须提交该 scope 的完整修订版，而不是增量片段；从自动加载的旧 Actor Higher Memory 保留本轮未改变的内容。只有 scope 已无任何值得保留的内容时才 clear。",
      "interaction 保存长期称呼、沟通边界和互动约定；working_style 保存用户明确表达的稳定工作习惯；working_set 保存用户要求后续继续的私人近期工作上下文。",
      "每项 evidenceQuote 必须逐字来自当前用户消息。不得从 Assistant 历史、语气猜测、共享组织资料或其他用户数据创建私人记忆。不得保存密码、令牌、密钥、金融凭据或原始联系方式。",
      "此工具不会写入 Assertion、GlobalObject、Object/Ambient Higher Memory 或正式 Business View。返回 committed=true 才表示自然语言 Actor Higher Memory 已跨会话持久化。",
    ].join(""),
    inputSchema: z.object({
      revisions: z.array(revisionSchema).min(1).max(3),
    }),
    execute: async ({ revisions }) => {
      const duplicateScope = revisions.find((revision, index) =>
        revisions.findIndex((candidate) => candidate.scope === revision.scope) !== index
      )?.scope;
      if (duplicateScope) {
        return {
          committed: false,
          message: `同一次提交不能重复修改 Actor Higher Memory scope：${duplicateScope}`,
        };
      }
      const ungrounded = revisions.find((revision) =>
        !quoteIsGrounded(input.currentUserMessage, revision.evidenceQuote)
      );
      if (ungrounded) {
        return {
          committed: false,
          message: `${ungrounded.scope} 的 evidenceQuote 不是当前用户消息中的逐字内容。`,
        };
      }
      const invalidContent = revisions.find((revision) =>
        revision.action === "replace" &&
        actorHigherMemoryQualityIssue(revision.contentMarkdown)
      );
      if (invalidContent?.action === "replace") {
        return {
          committed: false,
          message: `${invalidContent.scope} 未通过私人记忆质量检查：${actorHigherMemoryQualityIssue(invalidContent.contentMarkdown)}`,
        };
      }

      const committed = await getDatabase().$transaction(async (transaction) => {
        const actorExists = await transaction.memoryActor.count({
          where: { id: input.actorId },
        });
        if (actorExists !== 1) throw new Error("当前认证 Actor 不存在");

        const replacedScopes: ActorHigherMemoryScope[] = [];
        const clearedScopes: ActorHigherMemoryScope[] = [];
        const maintainedAt = new Date();
        for (const revision of revisions) {
          if (revision.action === "replace") {
            await transaction.memoryActorHigherMemory.upsert({
              where: {
                actorId_scope: {
                  actorId: input.actorId,
                  scope: revision.scope,
                },
              },
              create: {
                actorId: input.actorId,
                scope: revision.scope,
                contentMarkdown: revision.contentMarkdown,
                maintainedAt,
                triggerMessageId: input.currentMessageId,
                maintenanceReason: "当前用户显式要求同步修订 Actor 私有 Higher Memory。",
              },
              update: {
                contentMarkdown: revision.contentMarkdown,
                maintainedAt,
                triggerMessageId: input.currentMessageId,
                maintenanceReason: "当前用户显式要求同步修订 Actor 私有 Higher Memory。",
              },
            });
            replacedScopes.push(revision.scope);
            continue;
          }
          const deletion = await transaction.memoryActorHigherMemory.deleteMany({
            where: { actorId: input.actorId, scope: revision.scope },
          });
          if (deletion.count > 0) clearedScopes.push(revision.scope);
        }
        return { replacedScopes, clearedScopes };
      });

      const replaced = new Set(commitSummary.replacedScopes);
      const cleared = new Set(commitSummary.clearedScopes);
      for (const scope of committed.replacedScopes) {
        replaced.add(scope);
        cleared.delete(scope);
      }
      for (const scope of committed.clearedScopes) {
        cleared.add(scope);
        replaced.delete(scope);
      }
      commitSummary = {
        replacedScopes: [...replaced],
        clearedScopes: [...cleared],
      };
      if (committed.replacedScopes.length || committed.clearedScopes.length) {
        input.onCommitted?.(committed);
      }
      await input.trace?.appendJsonSection("Actor 自然语言 Higher Memory 同步写入", {
        actorId: input.actorId,
        sourceMessageId: input.currentMessageId,
        replacedScopes: committed.replacedScopes,
        clearedScopes: committed.clearedScopes,
        note: "调试摘要不复制 Actor 私有 Higher Memory 正文。",
      });
      return {
        committed: committed.replacedScopes.length + committed.clearedScopes.length > 0,
        replacedScopes: committed.replacedScopes,
        clearedScopes: committed.clearedScopes,
        message: committed.replacedScopes.length || committed.clearedScopes.length
          ? "Actor 私有自然语言 Higher Memory 已持久化，只对当前登录用户生效。"
          : "没有找到需要清除的 Actor Higher Memory，未发生写入。",
      };
    },
  });

  return {
    tool: writeTool,
    commitSummary: () => commitSummary,
    hasCommit: () =>
      commitSummary.replacedScopes.length + commitSummary.clearedScopes.length > 0,
    hasReplacementCommit: () => commitSummary.replacedScopes.length > 0,
  };
}
