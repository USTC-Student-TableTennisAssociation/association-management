import { tool, type ToolSet } from "ai";
import { z } from "zod";

export const capabilityGatewayToolNames = [
  "locateObjectViews",
  "listViewCards",
  "readViewState",
  "openArtifacts",
  "openMemory",
  "openActions",
] as const;

export const viewStateFollowupToolNames = [
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
  library: ["proposeLibraryPlan"],
} as const;

export type ActionArea = keyof typeof actionToolNames;

export type OpenedCapabilities = {
  viewStateOpened: boolean;
  lastViewKey?: string;
  openedViewKeys: Set<string>;
  artifacts: boolean;
  libraryIndexRead: boolean;
  sharedBrain: boolean;
  memoryPurpose?: "check_write_status" | "update_actor_memory";
  actionAreas: Set<ActionArea>;
};

export function createOpenedCapabilities(): OpenedCapabilities {
  return {
    viewStateOpened: false,
    lastViewKey: undefined,
    openedViewKeys: new Set(),
    artifacts: false,
    libraryIndexRead: false,
    sharedBrain: false,
    memoryPurpose: undefined,
    actionAreas: new Set(),
  };
}

export function detailedToolNames(state: OpenedCapabilities): string[] {
  const names = new Set<string>();
  if (state.viewStateOpened) viewStateFollowupToolNames.forEach((name) => names.add(name));
  if (state.artifacts) artifactToolNames.forEach((name) => names.add(name));
  if (state.libraryIndexRead) {
    names.add("inspectLibraryNodes");
    names.add("previewLibraryFiles");
  }
  if (state.sharedBrain) sharedBrainToolNames.forEach((name) => names.add(name));
  if (state.memoryPurpose === "check_write_status") names.add("readMemoryWriteStatus");
  if (state.memoryPurpose === "update_actor_memory") names.add("updateActorHigherMemory");
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
  listViewCards: (input: {
    viewKey: string;
    cardTypeKeys?: string[];
    query?: string;
    offset: number;
    limit: number;
  }) => Promise<unknown>;
  readViewState: (input: {
    viewKey: string;
    question: string;
    targets: Array<{
      kind: "name" | "object_ref" | "card_ref";
      value: string;
    }>;
  }) => Promise<unknown>;
  locateObjectViews: (input: { objectRef: string }) => Promise<unknown>;
  findArtifacts: (input: {
    title: string;
    purpose: "locate" | "read" | "analyze";
  }) => Promise<unknown>;
  describeBusinessViewActions: (viewKey: string) => unknown;
  authorizeAction?: (
    area: ActionArea,
    viewKey?: string,
  ) => { allowed: boolean; reason?: string };
}): ToolSet {
  return {
    locateObjectViews: tool({
      description:
        "当本轮已经通过知识检索或 View 状态读取得到某个 O#，并且需要知道同一个 Object 还出现在哪些授权 Business View 时调用。它只返回 View/Card 类型位置，不读取 Card 内容，也不授予写入能力；随后用 readViewState 精确读取与任务有关的 View。",
      inputSchema: z.object({
        objectRef: z.string().trim().regex(/^O\d+$/)
          .describe("必须原样使用本轮知识检索或 View 状态读取返回的 O#"),
      }),
      execute: handlers.locateObjectViews,
    }),
    listViewCards: tool({
      description:
        "浏览一个正式 Business View 当前收录的 Card。当用户问整个 View 里有什么、尚未给出具体业务实体，或需要先发现可读取的 Card 时使用。可按 Card 类型或字面关键词筛选，返回精确匹配总数、分页 Card 摘要、相关 Object 和可继续传给 readViewState 的 V# card_ref。它不读取 Higher Memory，不开放 Query 或写入能力；若 truncated=true，要继续翻页后才能声称已列完。",
      inputSchema: z.object({
        viewKey: handlers.viewKeySchema
          .describe("要浏览的已安装 Business View key"),
        cardTypeKeys: z.array(z.string().trim().min(1).max(100)).max(20).optional()
          .describe("可选；只保留 View Catalog 中声明的这些 Card 类型"),
        query: z.string().trim().min(1).max(200).optional()
          .describe("可选；按 Card dimensions、Card 类型和关联 Object 名称做字面筛选"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      execute: ({ viewKey, cardTypeKeys, query, offset = 0, limit = 50 }) =>
        handlers.listViewCards({
          viewKey,
          ...(cardTypeKeys ? { cardTypeKeys } : {}),
          ...(query ? { query } : {}),
          offset,
          limit,
        }),
    }),
    readViewState: tool({
      description:
        "只用于读取某个具体业务实体在正式 View 中的当前状态。View 的名称、用途、Card 类型和专业查询能力已经由 View Catalog 提供，介绍或比较 View 定义时禁止调用本工具。返回匹配的正式 Cards、相关 Object、必要的 Higher Memory 和可引用的 View ref；coverage、scope 与 evidence semantics 由服务端单独记录，不属于回答正文。",
      inputSchema: z.object({
        viewKey: handlers.viewKeySchema
          .describe("从 View Catalog 选择负责该业务实体当前状态的 View"),
        question: z.string().trim().min(1).max(500)
          .describe("需要从这个 View 当前状态回答的具体问题"),
        targets: z.array(z.object({
          kind: z.enum(["name", "object_ref", "card_ref"])
            .describe("name 是具体业务实体名称；object_ref 是本轮已返回的 O#；card_ref 是 listViewCards 或 readViewState 返回的 V# Card 引用"),
          value: z.string().trim().min(1).max(200)
            .describe("具体业务实体名称、O# 或 V#；禁止填写 View key、View label 或抽象业务类别"),
        })).min(1).max(8),
      }),
      execute: async ({ viewKey, question, targets }) => {
        const result = await handlers.readViewState({
          viewKey,
          question,
          targets,
        });
        state.viewStateOpened = true;
        state.lastViewKey = viewKey;
        state.openedViewKeys.add(viewKey);
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
    openMemory: tool({
      description:
        "只在用户明确询问先前消息是否已进入记忆，或明确要求跨会话记住、修改、忘记其私人称呼、互动约定和工作方式时调用。它只打开对应的记忆能力，不读取组织事实，也不代表记忆已经改变。",
      inputSchema: z.object({
        purpose: z.enum(["check_write_status", "update_actor_memory"])
          .describe("查询先前写入状态选择 check_write_status；明确修改当前 Actor 私有长期记忆选择 update_actor_memory"),
      }),
      execute: async ({ purpose }) => {
        state.memoryPurpose = purpose;
        return {
          opened: "memory",
          purpose,
          next: purpose === "check_write_status"
            ? "下一步使用 readMemoryWriteStatus，并传入用户实际询问的 messageId。"
            : "下一步使用 updateActorHigherMemory；只有 committed=true 才表示已经保存。",
        };
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
          state.lastViewKey,
        );
        if (authorization && !authorization.allowed) {
          return {
            opened: false,
            area,
            reason,
            next: authorization.reason ?? "当前工作流不允许打开该 Action 区域。",
          };
        }
        if (area !== "library" && !state.viewStateOpened) {
          return {
            opened: false,
            area,
            reason,
            next: "先调用 readViewState 读取具体业务目标的正式 View 当前状态，再重新调用 openActions。",
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
          ...(area === "business_view" && state.lastViewKey
            ? { contract: handlers.describeBusinessViewActions(state.lastViewKey) }
            : {}),
        };
      },
    }),
  };
}

export const TURN_KERNEL_INSTRUCTIONS = `
你是 Sydaris 的主对话模型。请先理解用户这一轮真正要做什么，再决定是直接回答还是打开更多能力。

- 需要调用工具时直接调用，不要先输出计划、寒暄或“我来查一下”等过渡正文；工具完成后的最终回答再自然说明结果。
- 问候、闲聊、改写、翻译、总结用户已给文字，以及不依赖 Sydaris 内部资料的任务，直接回答。
- 用户明确点名某个已安装 Skill，或当前任务与 Skill 目标高度匹配时，先调用 activateSkill。不同 Skill 可以在同一轮按需组合；Skill 激活后必须遵守其 View/Command、Resource Operation 边界和专用指令，不得用普通对话模式绕过 Skill Runtime 的写入约束。
- View Catalog 是已安装 View Plugin 的权威静态定义。用户询问 View 是什么、职责、Card 类型或专业查询能力时，直接依据 Catalog 回答，禁止调用 readViewState，也不要把 View 名当成业务实体目标。
- 用户询问整个 View 当前收录了什么、有哪些 Card，或尚不知道具体业务实体名称时，调用 listViewCards；可以使用 View Catalog 的 Card 类型筛选。数量盘点可先用 inspectKnowledgeEnvironment：若该 View 明确为 0 Card 就直接回答；大于 0 且用户要内容时再浏览。不得借 Library 文件名或 Shared Brain 猜测正式 View 中的实体。listViewCards 返回 truncated=true 时继续翻页，未读完前不能声称列出了全部内容。
- 需要理解某个具体业务实体或一张已发现 Card 在 Sydaris 正式 View 中的详细当前状态时，调用 readViewState。targets 必须是具体实体名称、本轮真实 O# 或 listViewCards/readViewState 返回的 V# card_ref，不能填写 View key、View label 或抽象业务类别；已有 O#/V# 时优先精确定位。只有当前状态读取明确不足时才 expandEvidence。
- readViewState 完成后开放的 query_* Tool 由当前 View Plugin 声明。用户需要筛选、汇总、比较、趋势或其他 View 专业读取时，优先调用匹配的 query_* Tool；每个 Query 的输入契约彼此独立，只能使用当前 Tool Schema 声明的字段。收到 INVALID_VIEW_QUERY_INPUT 时根据 issues 修正一次，仍失败就停止调用并说明。Query 只解释已观察到的正式 View Snapshot，不修改状态，也不替代外部来源 Tool。
- 已经得到 O#，且同一个对象可能同时存在于多个业务视角时，调用 locateObjectViews 发现当前授权范围内的 View/Card 位置，再分别用 readViewState 读取与任务有关的 View。发现位置不等于读取了 Card 内容，也不改变任何 View。
- 需要按主题查找跨文件、跨对象的组织知识时，直接调用 searchMemory。文件标题搜索只证明文件是否存在，未执行 searchMemory 前不得声称 Shared Brain 没有相关 Object、Assertion 或主题知识。
- 用户问“你知道什么”“环境里有什么知识”“知识库有多大”“有多少 Object/Assertion/文件/View/Card”或某层是否为空时，先调用 inspectKnowledgeEnvironment。只有它返回的 inventory counts 才表示当前权限范围内的分层总量；searchMemory、Locate、标题搜索和单个 View 读取的 counts 都只是本次读取结果，不能据此推断全库为空。
- inspectKnowledgeEnvironment 只做轻量盘点，不返回 Assertion 正文、文件原文或 Card 内容。用户问具体主题、具体对象或正式业务状态时，仍应直接使用 searchMemory、openArtifacts 或 readViewState，不要机械地先盘点。
- searchMemory 必须区分任务形状：单一明确事实使用 fact；完整理解、名单/表格、资料梳理或多字段 View 填充使用 synthesis。一次 query 只表达一个内聚的信息需求；多字段 synthesis 可先定位主体，再针对尚未覆盖的字段分别窄查。返回 partial/truncated、列表中出现“等”、或读完某个章节，只证明该次选择已完成，不证明用户要求的完整集合已经穷尽。Reference Assertion 未回读来源前不能作为事实。
- 需要查找、核对或读取文件时，调用 openArtifacts。该入口会立即返回精确文件匹配、处理状态与 Shared Brain 发布计数。原始文件也可以在业务查询的任何阶段打开。
- 需要浏览资料库目录、盘点文件夹或在不知道具体标题时自行了解资料结构，直接调用 listLibrary；不得要求用户重新口述系统能够读取的文件夹。listLibrary 是只读能力，不需要打开 Library Actions。
- Library 的 profile、执行 status 和发布状态是三个独立维度。不得把 catalog 当成“尚未执行”的同义词，也不得把 deep 当成所有文件必须经过的下一阶段；以 Library Processing Catalog 为准。
- 原文与 Assertion 是并列的知识入口，不是固定的最后核验层：窄事实优先 Assertion；宽综合优先高价值来源的目录和章节。
- 问题同时涉及“正式业务现状”和“资料/历史依据”时，应同时读取 View State 并检索 Shared Brain 或 Library，不得因为先打开了其中一层就停止检查其他必要层。
- 需要改变正式 View 或 Object 身份时，先调用 readViewState 读取具体目标的真实当前状态，再调用 openActions；打开 business_view actions 后必须真实调用 runViewCommand，文字说明不能代替 Proposal。需要整理 Library 时可直接调用 openActions。即使用户只是在查询，只要本轮已经从用户确认或可靠证据发现一个稳定、可复用且明确属于 View 职责的正式状态缺口，也应主动生成待审批 Proposal。所有修改只创建 Proposal。
- 用户明确点名某个 Command 时，确认目标身份、当前 View 状态和该 Command 必填输入后即可打开并执行对应 action；不要为了补齐不属于该 Command 的可选资料而推迟 Proposal。
- Proposal 是可审阅草稿。用户明确允许“先填、之后再改”时，完整提交证据支持的明确对象；可选字段不确定可以留空或披露推断，不能因此静默少做。只有身份歧义、当前状态冲突或必要字段无法确定时才询问。
- publishUserFactForView 只处理同轮 View Proposal 必需、由当前用户原话刚提供且现有知识缺失的新实体事实；不能把资料原文重新包装成聊天 Evidence。资料中的实体先使用检索返回的 O#、别名或唯一 canonical name。普通回答后的事实审查由 Post-turn Runtime 自动执行，不需要主模型判断或排队。
- 同一轮可以打开多个类别。不要为了展示工具而打开它们。
- 若某个工具返回 semantics，它只描述已经完成的读取，不是检索计划；你仍根据用户目的自主决定是否继续使用其他知识层。View 状态的详细 evidence semantics 由服务端保存，不会作为回答正文提供。
- View Catalog 用于静态定义与能力说明；View Higher Memory 是高层摘要。两者都不是精确当前状态的证据，涉及具体业务实体的现状时仍应调用 readViewState。
- 回答后的 Assertion、共享 Higher Memory 与 Actor 后台综合由独立 Post-turn Runtime 负责；不要在主回答中规划或调用这些后台治理能力，也不需要提交模型自述式 Handoff。
- 用户追问此前信息是否已经进入记忆时，先调用 openMemory 并选择 check_write_status；能力开放后调用 readMemoryWriteStatus，并根据对应原话显式传入目标 messageId。不得省略、猜测最近消息或把回执套用于其他消息。
- 用户明确要求跨会话记住、修改或忘记私人称呼、互动约定和稳定工作方式时，先调用 openMemory 并选择 update_actor_memory；只有后续工具返回 committed=true 才能声称已经保存。
- 不要凭模型内部知识补写 Sydaris 的组织事实。不要声称未实际完成的写入、更新或归档。
`.trim();
