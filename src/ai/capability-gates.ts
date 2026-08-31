import { tool, type ToolSet } from "ai";
import { z } from "zod";

export const capabilityGatewayToolNames = [
  "locateObjectViews",
  "openBusinessContext",
  "openArtifacts",
  "openActions",
] as const;

export const businessContextToolNames = [
  "expandEvidence",
  "followObject",
  "readSourceDocument",
] as const;

export const sharedBrainToolNames = [
  "searchMemory",
  "followObject",
  "readSourceDocument",
] as const;

export const artifactToolNames = [
  "openArtifactKnowledge",
  "previewLibraryFiles",
  "readLibraryCompilation",
] as const;

const actionToolNames = {
  business_view: ["runViewCommand"],
  object: ["inspectObjectIdentity", "proposeObjectChange"],
  library: ["listLibrary", "inspectLibraryNodes", "proposeLibraryPlan"],
} as const;

export type ActionArea = keyof typeof actionToolNames;

export type OpenedCapabilities = {
  businessContext: boolean;
  businessViewKey?: string;
  businessViewKeys: Set<string>;
  artifacts: boolean;
  sharedBrain: boolean;
  actionAreas: Set<ActionArea>;
};

export function createOpenedCapabilities(): OpenedCapabilities {
  return {
    businessContext: false,
    businessViewKey: undefined,
    businessViewKeys: new Set(),
    artifacts: false,
    sharedBrain: false,
    actionAreas: new Set(),
  };
}

export function detailedToolNames(state: OpenedCapabilities): string[] {
  const names = new Set<string>();
  if (state.businessContext) businessContextToolNames.forEach((name) => names.add(name));
  if (state.artifacts) artifactToolNames.forEach((name) => names.add(name));
  if (state.sharedBrain) sharedBrainToolNames.forEach((name) => names.add(name));
  for (const area of state.actionAreas) {
    actionToolNames[area].forEach((name) => names.add(name));
  }
  return [...names];
}

export function activeCapabilityToolNames(state: OpenedCapabilities): string[] {
  return [...capabilityGatewayToolNames, ...detailedToolNames(state)];
}

export function createCapabilityGatewayTools(state: OpenedCapabilities, handlers: {
  viewKeySchema: z.ZodType<string>;
  openBusinessContext: (input: {
    viewKey: string;
    focus: string;
    targetHints: string[];
    targetObjectRefs: string[];
  }) => Promise<unknown>;
  locateObjectViews: (input: { objectRef: string }) => Promise<unknown>;
  findArtifacts: (input: {
    title: string;
    purpose: "locate" | "read" | "analyze";
  }) => Promise<unknown>;
  describeBusinessViewActions: (viewKey: string) => unknown;
  authorizeAction?: (
    area: ActionArea,
    businessViewKey?: string,
  ) => { allowed: boolean; reason?: string };
}): ToolSet {
  return {
    locateObjectViews: tool({
      description:
        "当本轮已经通过知识检索或 Business Context 得到某个 O#，并且需要知道同一个 Object 还出现在哪些授权 Business View 时调用。它只返回 View/Card 类型位置，不读取 Card 内容，也不授予写入能力；随后用 openBusinessContext 精确读取与任务有关的 View。",
      inputSchema: z.object({
        objectRef: z.string().trim().regex(/^O\d+$/)
          .describe("必须原样使用本轮知识检索或 Business Context 返回的 O#"),
      }),
      execute: handlers.locateObjectViews,
    }),
    openBusinessContext: tool({
      description:
        "当回答需要 Sydaris 的业务状态、View 结构能力、组织知识、人物/活动背景时调用。它会立即读取指定正式 View，返回该 View 自己声明的 Query Catalog、实时 cardTypes schema、相关 Cards、Card Object、Object Higher Memory，以及描述本次读取实际证明内容的 semantics.observations / semantics.answerability。已有 O# 时优先用 targetObjectRefs 精确定位；普通闲聊和仅处理用户已给文字时不要调用。",
      inputSchema: z.object({
        viewKey: handlers.viewKeySchema
          .describe("根据每轮已提供的 View Frame 选择一个首要 View"),
        focus: z.string().trim().min(1).max(500)
          .describe("用户围绕目标真正想了解的业务问题"),
        targetHints: z.array(z.string().trim().min(1).max(200)).max(8).default([])
          .describe("尚无 Object 引用时，填写用户所指业务实体的名称或别名，忠实保留原话"),
        targetObjectRefs: z.array(z.string().trim().regex(/^O\d+$/)).max(8).default([])
          .describe("已经从本轮知识检索或 Business Context 得到的 O#；用于按 Object 身份精确匹配 Card"),
      }).refine(
        ({ targetHints, targetObjectRefs }) => targetHints.length > 0 || targetObjectRefs.length > 0,
        { message: "targetHints 与 targetObjectRefs 至少提供一项" },
      ),
      execute: async ({ viewKey, focus, targetHints, targetObjectRefs }) => {
        const result = await handlers.openBusinessContext({
          viewKey,
          focus,
          targetHints,
          targetObjectRefs,
        });
        state.businessContext = true;
        state.businessViewKey = viewKey;
        state.businessViewKeys.add(viewKey);
        return result;
      },
    }),
    openArtifacts: tool({
      description:
        "当回答需要查找或核对 Sydaris 资料库文件时调用。它会立即返回文件名、路径、处理状态、已发布 Assertion/Object 数，以及本次标题查询能与不能回答什么；不会把 coarse 误解为未进入 Shared Brain。",
      inputSchema: z.object({
        title: z.string().trim().min(1).max(300)
          .describe("要查找的文件完整标题或最长、最有区分度的标题部分；不要拆成多个宽泛 OR 词"),
        purpose: z.enum(["locate", "read", "analyze"]).default("locate")
          .describe("locate 只确认文件/路径/状态；read 要读取正文；analyze 要基于正文分析、总结、评价或改写"),
      }),
      execute: async ({ title, purpose }) => {
        const result = await handlers.findArtifacts({ title, purpose });
        state.artifacts = true;
        return result;
      },
    }),
    openActions: tool({
      description:
        "当用户需要修改正式 Business View、Object 身份或 Library 结构，或者本轮查询已经发现值得正式化的稳定 View 缺口时，打开对应提议能力。" +
        "business_view 必须在读取当前 View 后打开；打开只授予下一步能力，不代表已经生成 Proposal。所有变更都先形成 Proposal，不直接生效。",
      inputSchema: z.object({
        area: z.enum(["business_view", "object", "library"]),
        reason: z.string().trim().min(1).max(300),
      }),
      execute: async ({ area, reason }) => {
        const authorization = handlers.authorizeAction?.(
          area,
          state.businessViewKey,
        );
        if (authorization && !authorization.allowed) {
          return {
            opened: false,
            area,
            reason,
            next: authorization.reason ?? "当前工作流不允许打开该 Action 区域。",
          };
        }
        if (area !== "library" && !state.businessContext) {
          return {
            opened: false,
            area,
            reason,
            next: "先调用 openBusinessContext 读取正式 View、相关 Card 与 Object Higher Memory，再重新调用 openActions。",
          };
        }
        state.actionAreas.add(area);
        return {
          opened: "actions",
          area,
          reason,
          message: area === "business_view"
            ? "Business View 写入能力将在下一步可用；必须真实调用 View Command，文字说明不能代替 Proposal。"
            : "对应读取与 Proposal 能力将在下一步可用；请先核对当前状态再提议。",
          ...(area === "business_view" && state.businessViewKey
            ? { contract: handlers.describeBusinessViewActions(state.businessViewKey) }
            : {}),
        };
      },
    }),
  };
}

export const TURN_KERNEL_INSTRUCTIONS = `
你是 Sydaris 的主对话模型。请先理解用户这一轮真正要做什么，再决定是直接回答还是打开更多能力。

- 问候、闲聊、改写、翻译、总结用户已给文字，以及不依赖 Sydaris 内部资料的任务，直接回答。
- 用户明确点名某个已安装 Skill，或当前任务与 Skill 目标高度匹配时，先调用 activateSkill。Skill 激活后必须遵守其 View/Command 边界和专用指令；不得用普通对话模式绕过 Skill Runtime 的写入约束。
- 需要理解 Sydaris 的业务状态、组织事实、人物或活动背景时，调用 openBusinessContext。该入口会立即返回正式 View 中的相关 Card 及其 Object Higher Memory；已有 O# 时放入 targetObjectRefs 做精确定位，只有读取明确不足时才 expandEvidence。
- openBusinessContext 返回的 Query Catalog 由当前 View 声明。用户需要筛选、汇总、比较、趋势或其他 View 专业读取时，优先调用匹配的 query_* Tool；每个 Query 的输入契约彼此独立，只能使用当前 Tool Schema 声明的字段。收到 INVALID_VIEW_QUERY_INPUT 时根据 issues 修正一次，仍失败就停止调用并说明。Query 只解释已观察到的正式 View Snapshot，不修改状态，也不替代外部来源 Tool。
- 已经得到 O#，且同一个对象可能同时存在于多个业务视角时，调用 locateObjectViews 发现当前授权范围内的 View/Card 位置，再分别用 openBusinessContext 读取与任务有关的 View。发现位置不等于读取了 Card 内容，也不改变任何 View。
- 需要按主题查找跨文件、跨对象的组织知识时，直接调用 searchMemory。文件标题搜索只证明文件是否存在，未执行 searchMemory 前不得声称 Shared Brain 没有相关 Object、Assertion 或主题知识。
- 用户问“你知道什么”“环境里有什么知识”“知识库有多大”“有多少 Object/Assertion/文件/View/Card”或某层是否为空时，先调用 inspectKnowledgeEnvironment。只有它返回的 inventory counts 才表示当前权限范围内的分层总量；searchMemory、Locate、标题搜索和单个 View 读取的 counts 都只是本次读取结果，不能据此推断全库为空。
- inspectKnowledgeEnvironment 只做轻量盘点，不返回 Assertion 正文、文件原文或 Card 内容。用户问具体主题、具体对象或正式业务状态时，仍应直接使用 searchMemory、openArtifacts 或 openBusinessContext，不要机械地先盘点。
- searchMemory 必须区分任务形状：单一明确事实使用 fact；完整理解、名单/表格、资料梳理或多字段 View 填充使用 synthesis。一次 query 只表达一个内聚的信息需求；多字段 synthesis 可先定位主体，再针对尚未覆盖的字段分别窄查。返回 partial/truncated、列表中出现“等”、或读完某个章节，只证明该次选择已完成，不证明用户要求的完整集合已经穷尽。Reference Assertion 未回读来源前不能作为事实。
- 需要查找、核对或读取文件时，调用 openArtifacts。该入口会立即返回精确文件匹配、处理状态与 Shared Brain 发布计数。原始文件也可以在业务查询的任何阶段打开。
- 原文与 Assertion 是并列的知识入口，不是固定的最后核验层：窄事实优先 Assertion；宽综合优先高价值来源的目录和章节。
- 问题同时涉及“正式业务现状”和“资料/历史依据”时，应同时打开 Business Context 并检索 Shared Brain 或 Library，不得因为先打开了其中一层就停止检查其他必要层。
- 需要改变正式 View 或 Object 身份时，先调用 openBusinessContext 读取真实当前状态，再调用 openActions；打开 business_view actions 后必须真实调用 runViewCommand，文字说明不能代替 Proposal。需要整理 Library 时可直接调用 openActions。即使用户只是在查询，只要本轮已经从用户确认或可靠证据发现一个稳定、可复用且明确属于 View 职责的正式状态缺口，也应主动生成待审批 Proposal。所有修改只创建 Proposal。
- 用户明确点名某个 Command 时，确认目标身份、当前 View 状态和该 Command 必填输入后即可打开并执行对应 action；不要为了补齐不属于该 Command 的可选资料而推迟 Proposal。
- Proposal 是可审阅草稿。用户明确允许“先填、之后再改”时，完整提交证据支持的明确对象；可选字段不确定可以留空或披露推断，不能因此静默少做。只有身份歧义、当前状态冲突或必要字段无法确定时才询问。
- Chat Assertion Capture 只处理当前用户原话中的新事实，不能把资料原文重新包装成聊天 Evidence。资料中的实体先使用检索返回的 O#、别名或唯一 canonical name；只有当前用户原话本身提供了缺失实体及其新事实时，才在打开 business_view actions 前使用 foreground_for_view。
- 同一轮可以打开多个类别。不要为了展示工具而打开它们。
- 工具结果中的 semantics 只描述已经完成的读取：observations 表示实际观察，answerability 表示这些观察能回答什么。它不是检索计划；你仍根据用户目的自主决定是否继续使用其他知识层。
- 每个 View 的 Frame 用于告诉你“应该如何理解问题”；View Higher Memory 是高层摘要。两者都不是精确当前状态的证据，需要细节时仍应读取正式 View。
- 仅当当前用户原话确实包含值得独立审查的新业务事实时调用 submitTurnHandoff；纯问题无需调用，也不得为了结束回答而调用。它不负责决定写入。
- reviewNeeded=true 时 candidateQuotes 必须逐字引用当前用户消息中的事实陈述；纯问题、检索要求、假设、模型自我分析以及只有 Assistant 说过的内容必须设为 false 并返回空 quotes。
- 用户追问此前信息是否已经进入记忆时，调用 readMemoryWriteStatus，并根据对应原话显式传入目标 messageId；不得省略、猜测最近消息或把回执套用于其他消息。
- 不要凭模型内部知识补写 Sydaris 的组织事实。不要声称未实际完成的写入、更新或归档。
`.trim();
