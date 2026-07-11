/**
 * 《乒协生存手册》的第一批指导层种子数据。
 *
 * 这些条目是人工可审阅的草稿，而不是原始手册的替代品。固定 UUID 使导入可重复执行：
 * 再次运行只会补齐或更新尚未发布的草稿，不会产生重复条目。
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type GuidelineKind = "workflow" | "rule" | "checklist" | "experience";
export type GuidelineStatus = "draft" | "published";
export type GuidelineRelationType =
  | "contains"
  | "triggers"
  | "requires"
  | "next"
  | "exception";

export type ConditionOperator =
  | "eq"
  | "ne"
  | "in"
  | "not_in"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "exists";

export type FactCondition = {
  field: string;
  operator: ConditionOperator;
  value?: JsonValue;
};

export type ConditionGroup = {
  all?: GuidanceCondition[];
  any?: GuidanceCondition[];
};

export type GuidanceCondition = FactCondition | ConditionGroup;

export type SuggestedAction = {
  type: "create_task" | "request_information" | "show_checklist" | "draft_document";
  title: string;
  due?: string;
  description?: string;
};

export type GuidelineSeed = {
  id: string;
  title: string;
  kind: GuidelineKind;
  contentMarkdown: string;
  isMandatory: boolean;
  appliesWhen: GuidanceCondition;
  suggestedActions: SuggestedAction[];
  basisNote: string;
  status: GuidelineStatus;
};

export type GuidelineLinkSeed = {
  fromGuidelineId: string;
  toGuidelineId: string;
  relationType: GuidelineRelationType;
  note: string;
};

export const handbookGuidelineIds = {
  noApprovalNoActivity: "10000000-0000-4000-8000-000000000001",
  largeEventT7Submission: "10000000-0000-4000-8000-000000000002",
  regularActivityT3Submission: "10000000-0000-4000-8000-000000000003",
  budgetBeforeActivity: "10000000-0000-4000-8000-000000000004",
  reimbursementClosure: "10000000-0000-4000-8000-000000000005",
  venueApplication: "10000000-0000-4000-8000-000000000006",
  largeEventWorkflow: "10000000-0000-4000-8000-000000000007",
  fundedActivityClosure: "10000000-0000-4000-8000-000000000008",
  assetAndKeyManagement: "10000000-0000-4000-8000-000000000009",
  handoverChecklist: "10000000-0000-4000-8000-000000000010",
  newOfficerGrowth: "10000000-0000-4000-8000-000000000011",
  postmortemAndExperience: "10000000-0000-4000-8000-000000000012",
} as const;

export const handbookGuidelines: GuidelineSeed[] = [
  {
    id: handbookGuidelineIds.noApprovalNoActivity,
    title: "无二课审批不开展活动",
    kind: "rule",
    isMandatory: true,
    appliesWhen: {
      all: [
        { field: "activity.requires_second_class_approval", operator: "eq", value: true },
        { field: "activity.approval_status", operator: "not_in", value: ["approved"] },
      ],
    },
    contentMarkdown: `## 规则

需要二课审批的活动，未获审批前不得进入实际开展阶段。二课审批不仅关联活动合规，也关联场地使用、公开宣传、经费申请和后续报销。

## 怎么做

1. 先核实活动是否需要二课审批，以及当前审批状态。
2. 未获审批时，暂停将活动视为可执行的安排；根据活动类型加载相应的申报时限指导。
3. 审批状态或学校要求不明确时，先向负责行政的同学或指导老师确认。

## 注意

这条是“开展前的门禁”，不等同于“必须在 T-7 前审批通过”。大型赛事 T-7 的明确要求是**提交申请**。`,
    suggestedActions: [
      {
        type: "show_checklist",
        title: "先核实二课审批状态，再安排活动执行",
      },
      {
        type: "request_information",
        title: "补充活动类型、二课审批状态和计划日期",
      },
    ],
    basisNote: "整理自《乒协生存手册》第 15 页 §6.1.1；学校当年流程以官方通知为准。",
    status: "draft",
  },
  {
    id: handbookGuidelineIds.largeEventT7Submission,
    title: "大型赛事：活动前至少 7 天提交二课申请",
    kind: "rule",
    isMandatory: true,
    appliesWhen: {
      all: [
        { field: "activity.type", operator: "eq", value: "large_tournament" },
        { field: "activity.days_until_event", operator: "lte", value: 7 },
        {
          field: "activity.approval_status",
          operator: "not_in",
          value: ["submitted", "approved"],
        },
      ],
    },
    contentMarkdown: `## 规则

大型赛事应在活动前至少 7 天在二课系统**提交申请**。全校性活动还应确认是否需要按当年要求提交纸质策划案。

## 提交前准备

- 策划案，包含必要的安全预案。
- 预算明细。
- 活动时间、场地、预计参与规模等基础信息。

## 提交后

沿“提交申请 → 挂靠单位审核 → 管指委审批”跟踪进度，并为可能的催审预留时间。若已临近节点仍未提交，应立即提示风险，而不是把“审批已完成”写成已知事实。`,
    suggestedActions: [
      {
        type: "create_task",
        title: "提交大型赛事二课申请并附齐策划与预算材料",
        due: "立即",
      },
      {
        type: "request_information",
        title: "确认是否需要纸质策划案，以及当前审核卡在哪一环",
      },
    ],
    basisNote: "整理自《乒协生存手册》第 15、19 页；手册明确的是 T-7 提交，不是 T-7 审批完成。",
    status: "draft",
  },
  {
    id: handbookGuidelineIds.regularActivityT3Submission,
    title: "常规活动：活动前 3 天完成系统申报",
    kind: "rule",
    isMandatory: true,
    appliesWhen: {
      all: [
        {
          field: "activity.type",
          operator: "in",
          value: ["regular_training", "points_tournament"],
        },
        { field: "activity.days_until_event", operator: "lte", value: 3 },
        {
          field: "activity.approval_status",
          operator: "not_in",
          value: ["submitted", "approved"],
        },
      ],
    },
    contentMarkdown: `## 规则

周常训练、积分赛等常规活动，须在活动前 3 天完成系统申报。

## 怎么做

1. 确认活动日期、类型与是否需要二课申报。
2. 在时限内完成系统申报，并记录提交状态。
3. 如审批尚未推进，及时核实当前审核环节；未获审批前仍适用“无二课审批不开展活动”。`,
    suggestedActions: [
      {
        type: "create_task",
        title: "完成常规活动的系统申报",
        due: "活动前 3 天",
      },
      {
        type: "request_information",
        title: "确认常规活动日期、类型和当前申报状态",
      },
    ],
    basisNote: "整理自《乒协生存手册》第 15 页 §6.1.2。",
    status: "draft",
  },
  {
    id: handbookGuidelineIds.budgetBeforeActivity,
    title: "活动前确认预算与支出边界",
    kind: "rule",
    isMandatory: true,
    appliesWhen: {
      all: [
        { field: "activity.phase", operator: "in", value: ["planning", "preparation"] },
        { field: "activity.requires_budget", operator: "eq", value: true },
        {
          field: "activity.budget_status",
          operator: "not_in",
          value: ["confirmed", "approved"],
        },
      ],
    },
    contentMarkdown: `## 规则

每一笔与活动有关的支出，都应在活动开始前明确列入预算；经费不得用于聚餐、私人娱乐或其他与社团建设无关的用途。

## 怎么做

1. 将竞赛物资、荣誉物资、必要服务和其他支出逐项写入预算。
2. 采购奖品或耗材前，确认型号、数量与预算边界。
3. 发现可能超支时，先补充说明并核对当年财务要求；不要把参考额度写成长期不变的规则。

## 注意

报销原则上不得超过已审批预算。具体额度、报销细则和可报范围应以当年学校/社团财务通知为准。`,
    suggestedActions: [
      {
        type: "draft_document",
        title: "整理活动预算明细并标注每项支出用途",
      },
      {
        type: "request_information",
        title: "确认预算状态、拟采购物资与是否存在超支风险",
      },
    ],
    basisNote: "整理自《乒协生存手册》第 16–17 页 §6.2；固定金额与细则不作为永久规则导入。",
    status: "draft",
  },
  {
    id: handbookGuidelineIds.reimbursementClosure,
    title: "报销材料与物资数量闭环检查",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: {
      all: [
        { field: "activity.phase", operator: "in", value: ["closing", "reimbursement"] },
      ],
    },
    contentMarkdown: `## 报销前检查

- 已有对应的活动预算，且报销金额原则上不超过审批预算。
- 发票、支付记录、购买明细或签领表能够一一对应。
- 实物奖品或耗材满足“采购数 = 已签领数 + 库存余数”；有剩余时已单独列入库存。
- 已完成必要结项材料；若超支或跨期，已按当年要求补充说明并做好原始单据交接。

## 注意

新闻稿、照片、二课结项和财务材料之间存在依赖。具体报销规则会调整，应以当年官方通知为准。`,
    suggestedActions: [
      {
        type: "show_checklist",
        title: "逐项核对预算、发票、支付记录、购买明细与签领表",
      },
      {
        type: "request_information",
        title: "补充采购数量、签领数量、库存余数和缺失材料",
      },
    ],
    basisNote: "整理自《乒协生存手册》第 16–17 页 §6.2.3–6.2.4。",
    status: "draft",
  },
  {
    id: handbookGuidelineIds.venueApplication,
    title: "场地申请与大规模占馆说明",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: {
      all: [
        { field: "activity.needs_venue", operator: "eq", value: true },
        {
          field: "activity.venue_status",
          operator: "not_in",
          value: ["submitted", "approved"],
        },
      ],
    },
    contentMarkdown: `## 场馆申请

1. 需要体育场馆时，提前向管指委提出申请并按流程完成相关审批。
2. 申请全馆或大量球台时，附上赛事参与人数与场馆使用时段说明，说明占用的合理性。
3. 会议、复盘、观影等多功能场地，按现行安排向指导老师报备并确认设备可用性。

## 注意

手册没有为常规体育场馆申请给出统一的“提前 N 天”数字，因此首版不硬编码一个未经证实的时限。`,
    suggestedActions: [
      {
        type: "draft_document",
        title: "准备场地申请说明，写明参与规模和使用时段",
      },
      {
        type: "request_information",
        title: "确认场地类型、使用时间、占馆规模和申请状态",
      },
    ],
    basisNote: "整理自《乒协生存手册》第 17–18 页 §6.3。",
    status: "draft",
  },
  {
    id: handbookGuidelineIds.largeEventWorkflow,
    title: "大型赛事四阶段筹备流程",
    kind: "workflow",
    isMandatory: false,
    appliesWhen: {
      all: [{ field: "activity.type", operator: "eq", value: "large_tournament" }],
    },
    contentMarkdown: `## 用途

将大型赛事组织为四个相互衔接的模块，帮助负责人保留全局视野，而不是拆成没有上下文的微任务。

## 四个阶段

1. **行政合规与通知**：二课申请、策划与预算材料、场地审定、通知与报名安排。
2. **核心物资保障**：比赛用球、奖杯奖牌、奖状、奖品、横幅、号码布与签到物资，并预留必要损耗和制作周期。
3. **现场执行与秩序维护**：前台签到/签领、竞赛区准备、赛程弹性调度、迟到或弃权处理。
4. **收尾与资产沉淀**：新闻稿和照片、二课结项、报销材料、反馈收集、复盘与经验草稿。

## 完成标准

每个阶段的关键事项都已有负责人、可核对材料或待确认动作；实际状态仍需由人确认后写入状态层。`,
    suggestedActions: [
      {
        type: "show_checklist",
        title: "按四阶段检查大型赛事筹备缺口",
      },
      {
        type: "request_information",
        title: "补充赛事日期、规模、场地、预算和当前筹备阶段",
      },
    ],
    basisNote: "整理自《乒协生存手册》第 19–20 页 §7.1。",
    status: "draft",
  },
  {
    id: handbookGuidelineIds.fundedActivityClosure,
    title: "经费活动的新闻稿、审核发布与二课结项",
    kind: "workflow",
    isMandatory: true,
    appliesWhen: {
      all: [
        { field: "activity.requires_budget", operator: "eq", value: true },
        { field: "activity.phase", operator: "in", value: ["after_event", "closing", "reimbursement"] },
        { field: "activity.closure_status", operator: "ne", value: "completed" },
      ],
    },
    contentMarkdown: `## 行政闭环

申请经费的活动结束后，新闻稿不是可选宣传材料，而是结项和报销链条的一部分。

1. 撰写新闻稿并按当期内部流程完成校对、指导老师审核与发布。
2. 上传新闻稿和照片，完成二课结项。
3. 再进入报销材料与物资数量核对。

## 注意

具体新闻稿格式和审核人以当年的校内规定为准。该流程只提出待确认动作，不自动把活动写成“已结项”。`,
    suggestedActions: [
      {
        type: "draft_document",
        title: "起草活动新闻稿并准备照片材料",
      },
      {
        type: "create_task",
        title: "按现行流程完成新闻稿审核发布与二课结项",
      },
    ],
    basisNote: "整理自《乒协生存手册》第 20–21 页 §7.1.4、§8.1。",
    status: "draft",
  },
  {
    id: handbookGuidelineIds.assetAndKeyManagement,
    title: "核心物资、钥匙与学期盘点",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: {
      any: [
        { field: "activity.needs_core_assets", operator: "eq", value: true },
        { field: "handover.in_progress", operator: "eq", value: true },
        { field: "organization.asset_inventory_due", operator: "eq", value: true },
      ],
    },
    contentMarkdown: `## 管理要求

- 记录核心物资的位置、数量和实际持有人；耗材、奖品与高价值器材应可盘点。
- 钥匙需要明确当前持有人、备用机制和借用登记；不要把具体个人姓名或密码写成长期指导知识。
- 每学期末盘点资产；长期闲置或损坏的器材按当期规则处理，避免无效资产积压。

## 适用情形

活动借用核心物资、负责人变更或学期末盘点时加载此清单。`,
    suggestedActions: [
      {
        type: "show_checklist",
        title: "核对物资位置、数量、持有人与钥匙备用记录",
      },
      {
        type: "request_information",
        title: "补充当前库存、借用记录、钥匙去向和盘点日期",
      },
    ],
    basisNote: "整理自《乒协生存手册》第 18 页 §6.3.3。",
    status: "draft",
  },
  {
    id: handbookGuidelineIds.handoverChecklist,
    title: "换届四类交接",
    kind: "workflow",
    isMandatory: true,
    appliesWhen: {
      all: [{ field: "handover.in_progress", operator: "eq", value: true }],
    },
    contentMarkdown: `## 交接目标

在换届或负责人变更时，按工作、线上权限、物资、关系四类内容完成可核对的交接。手册建议在春季学期结束前启动，并以暑假前完成为目标；具体日期应由当届负责人确认。

## 四类交接

1. **工作**：未结二课、未完成报销、原始凭证、策划案、总结和决策记录。
2. **线上权限**：官方群、公众号、媒体账号、知识库等管理员权限；实际账号信息不写入指导卡。
3. **物资**：发球机、耗材、高价值物资和全部场馆钥匙的数量与去向。
4. **关系**：指导老师、场馆负责人等关键校内联系关系的平稳介绍与交接。

## 注意

未完成报销时，应交接全套原始凭证，而不是只口头说明。`,
    suggestedActions: [
      {
        type: "show_checklist",
        title: "按工作、线上权限、物资、关系四类生成换届交接清单",
      },
      {
        type: "request_information",
        title: "确认未结工作、账号权限、钥匙物资和关键联系人是否已交接",
      },
    ],
    basisNote: "整理自《乒协生存手册》第 24–25 页 §9.3。",
    status: "draft",
  },
  {
    id: handbookGuidelineIds.newOfficerGrowth,
    title: "新干事从见习到项目主理的培养路径",
    kind: "experience",
    isMandatory: false,
    appliesWhen: {
      all: [
        { field: "member.stage", operator: "in", value: ["new_officer", "apprentice"] },
      ],
    },
    contentMarkdown: `## 培养路径

1. **入门**：在首次例会说明服务同学的价值观、岗位职责与权限，并完成二课系统、传承库等工具入门。
2. **见习**：跟随老骨干完成一次完整活动，在清晰边界内承担签到、场务、物资等小范围工作。
3. **逐步主理**：有能力的干事可独立完成部分工作；权限与责任应在已确认的项目边界内逐步授予。

## 使用方式

这是一条培养经验，不自动授予预算、审批或状态修改权限。具体分工仍应由负责人确认。`,
    suggestedActions: [
      {
        type: "create_task",
        title: "为新干事安排一次有边界的见习任务和复盘反馈",
      },
      {
        type: "request_information",
        title: "确认新干事已掌握的工具、见习经历和可承担范围",
      },
    ],
    basisNote: "整理自《乒协生存手册》第 24、29–30 页 §9.2、§11.2–11.3。",
    status: "draft",
  },
  {
    id: handbookGuidelineIds.postmortemAndExperience,
    title: "活动后复盘与可交接经验沉淀",
    kind: "workflow",
    isMandatory: false,
    appliesWhen: {
      all: [
        { field: "activity.phase", operator: "in", value: ["after_event", "closing"] },
        { field: "activity.review_status", operator: "not_in", value: ["completed", "published"] },
      ],
    },
    contentMarkdown: `## 复盘内容

活动结束后，通过参与者反馈和干事复盘，记录下列可传承信息：

- 当时的决策理由与权衡；
- 踩坑点、行政事故、突发情况和处理办法；
- 参与人数、预算使用等可量化数据；
- 适用条件、实际做法、结果和下次建议。

## 发布边界

先形成经验草稿，由人审核、补充上下文后再发布为可复用指导；未经确认的模型总结不能直接覆盖既有经验或状态。`,
    suggestedActions: [
      {
        type: "draft_document",
        title: "生成活动复盘草稿，区分事实、风险、经验和待确认问题",
      },
      {
        type: "request_information",
        title: "收集参与者反馈、关键数据和本次踩坑点",
      },
    ],
    basisNote: "整理自《乒协生存手册》第 20、23–24、30 页 §7.1.4、§9.1、§11.4。",
    status: "draft",
  },
];

export const handbookGuidelineLinks: GuidelineLinkSeed[] = [
  {
    fromGuidelineId: handbookGuidelineIds.largeEventWorkflow,
    toGuidelineId: handbookGuidelineIds.noApprovalNoActivity,
    relationType: "contains",
    note: "大型赛事的行政合规模块首先受活动开展前的审批门禁约束。",
  },
  {
    fromGuidelineId: handbookGuidelineIds.largeEventWorkflow,
    toGuidelineId: handbookGuidelineIds.largeEventT7Submission,
    relationType: "contains",
    note: "大型赛事筹备包含 T-7 二课申请提交节点。",
  },
  {
    fromGuidelineId: handbookGuidelineIds.largeEventWorkflow,
    toGuidelineId: handbookGuidelineIds.budgetBeforeActivity,
    relationType: "contains",
    note: "大型赛事筹备需要在前期确认预算与支出边界。",
  },
  {
    fromGuidelineId: handbookGuidelineIds.largeEventWorkflow,
    toGuidelineId: handbookGuidelineIds.venueApplication,
    relationType: "contains",
    note: "大型赛事筹备包含场地申请与大规模占馆说明。",
  },
  {
    fromGuidelineId: handbookGuidelineIds.largeEventWorkflow,
    toGuidelineId: handbookGuidelineIds.fundedActivityClosure,
    relationType: "contains",
    note: "大型赛事收尾时进入新闻稿、结项与报销的行政闭环。",
  },
  {
    fromGuidelineId: handbookGuidelineIds.noApprovalNoActivity,
    toGuidelineId: handbookGuidelineIds.largeEventT7Submission,
    relationType: "triggers",
    note: "当活动类型为大型赛事时，未审批门禁会引出 T-7 提交检查。",
  },
  {
    fromGuidelineId: handbookGuidelineIds.noApprovalNoActivity,
    toGuidelineId: handbookGuidelineIds.regularActivityT3Submission,
    relationType: "triggers",
    note: "当活动类型为常规训练或积分赛时，未审批门禁会引出 T-3 提交检查。",
  },
  {
    fromGuidelineId: handbookGuidelineIds.fundedActivityClosure,
    toGuidelineId: handbookGuidelineIds.reimbursementClosure,
    relationType: "triggers",
    note: "结项材料准备完成后，进入报销材料与物资数量核对。",
  },
  {
    fromGuidelineId: handbookGuidelineIds.reimbursementClosure,
    toGuidelineId: handbookGuidelineIds.budgetBeforeActivity,
    relationType: "requires",
    note: "报销以活动前确认的预算和支出边界为前提。",
  },
  {
    fromGuidelineId: handbookGuidelineIds.largeEventWorkflow,
    toGuidelineId: handbookGuidelineIds.postmortemAndExperience,
    relationType: "next",
    note: "大型赛事收尾后，应形成复盘与可交接经验草稿。",
  },
  {
    fromGuidelineId: handbookGuidelineIds.handoverChecklist,
    toGuidelineId: handbookGuidelineIds.assetAndKeyManagement,
    relationType: "requires",
    note: "换届前需完成核心物资与钥匙的核对。",
  },
  {
    fromGuidelineId: handbookGuidelineIds.handoverChecklist,
    toGuidelineId: handbookGuidelineIds.postmortemAndExperience,
    relationType: "requires",
    note: "可交接的过程记录与经验草稿能降低换届的信息断层。",
  },
];
