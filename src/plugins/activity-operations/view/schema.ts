import type {
  CardTypeDefinition,
  DimensionDefinition,
  SlotDefinition,
  ViewChangePolicy,
  ViewModule,
} from "@sydaris/plugin-sdk";

import { activityOperationsCommands } from "./commands.js";
import { activityOperationsEvents } from "./events.js";
import { activityOperationsInvariants } from "./invariants.js";

export const ACTIVITY_OPERATIONS_VIEW_KEY = "activity_operations";

const operationalChange = {
  attention: "evaluate",
  knowledge: "none",
  timing: "after_settle",
  settleMs: 1_000,
  guidance:
    "这是当前活动的正式运营状态。只在进度矛盾、期限风险、负责人缺失或会影响其他工作时主动提醒；普通进度记录保持安静。",
} as const satisfies ViewChangePolicy;

const activityKnowledgeChange = {
  ...operationalChange,
  knowledge: "reconcile",
  guidance:
    "Activity 的身份、阶段、时间或整体结果发生变化。先对账关联 Object 的 Higher Memory；只在变化会产生明确风险或需要人判断时主动回应。",
} as const satisfies ViewChangePolicy;

const identityLinkChange = {
  attention: "always",
  knowledge: "reconcile",
  guidance: "Activity 或 Assignment 与稳定 Object 的身份关联发生变化，必须给出可见核对结果。",
} as const satisfies ViewChangePolicy;

const text = (
  key: string,
  label: string,
  description: string,
  required = false,
): DimensionDefinition => ({
  key,
  label,
  description,
  type: "text",
  required: required || undefined,
  constraints: { maxLength: 500 },
  changePolicy: operationalChange,
});

const rich = (key: string, label: string, description: string): DimensionDefinition => ({
  key,
  label,
  description,
  type: "rich_text",
  constraints: { maxLength: 5_000 },
  presentation: { multiline: true },
  changePolicy: operationalChange,
});

const date = (key: string, label: string, description: string): DimensionDefinition => ({
  key,
  label,
  description,
  type: "date",
  changePolicy: operationalChange,
});

const datetime = (key: string, label: string, description: string): DimensionDefinition => ({
  key,
  label,
  description,
  type: "datetime",
  changePolicy: operationalChange,
});

const enumeration = (
  key: string,
  label: string,
  description: string,
  options: readonly [string, string][],
  defaultValue?: string,
): DimensionDefinition => ({
  key,
  label,
  description,
  type: "enum",
  ...(defaultValue ? { required: true, defaultValue } : {}),
  constraints: {
    enumOptions: options.map(([optionKey, optionLabel]) => ({ key: optionKey, label: optionLabel })),
  },
  changePolicy: operationalChange,
});

const money = (key: string, label: string, description: string): DimensionDefinition => ({
  key,
  label,
  description,
  type: "money",
  constraints: { min: "0", allowedCurrencies: ["CNY"] },
  changePolicy: operationalChange,
});

const slot = (
  key: string,
  label: string,
  description: string,
  allowedTargetCardTypes: readonly string[],
  cardinality: "one" | "many" = "many",
): SlotDefinition => ({
  key,
  label,
  description,
  allowedTargetCardTypes,
  cardinality,
  changePolicy: operationalChange,
});

const card = (
  key: string,
  label: string,
  description: string,
  dimensions: readonly DimensionDefinition[] = [],
  slots: readonly SlotDefinition[] = [],
): CardTypeDefinition => ({
  key,
  label,
  description,
  dimensions,
  slots,
  changePolicy: operationalChange,
});

const activityStatus = enumeration(
  "status",
  "状态",
  "这次活动当前所在的整体运行阶段。",
  [
    ["PLANNING", "筹备中"],
    ["RUNNING", "进行中"],
    ["WRAP_UP", "收尾中"],
    ["COMPLETED", "已结束"],
    ["CANCELLED", "已取消"],
  ],
  "PLANNING",
);

const workStatus = enumeration(
  "status",
  "状态",
  "工作项的当前执行状态。",
  [
    ["NOT_STARTED", "未开始"],
    ["IN_PROGRESS", "进行中"],
    ["BLOCKED", "受阻"],
    ["COMPLETED", "已完成"],
    ["CANCELLED", "已取消"],
  ],
  "NOT_STARTED",
);

const priority = enumeration(
  "priority",
  "优先级",
  "工作项在当前活动中的相对紧迫程度。",
  [
    ["LOW", "低"],
    ["NORMAL", "普通"],
    ["HIGH", "高"],
    ["CRITICAL", "紧急"],
  ],
  "NORMAL",
);

const workDimensions = [
  text("name", "名称", "对当前工作项的简洁、可操作命名。", true),
  rich("description", "说明", "工作边界、交付物和必要背景。"),
  workStatus,
  rich("progress", "进展", "记录已经完成、正在等待和下一步。"),
  priority,
  date("deadline", "截止日期", "该工作项预期完成的最晚日期。"),
] as const satisfies readonly DimensionDefinition[];

export const activityOperationsCardTypes = [
  card(
    "DimensionDefinitionCard",
    "特征定义",
    "定义理解 Activity 时值得关注的一项可复用业务特征。",
    [text("name", "名称", "特征的稳定名称。", true), rich("description", "说明", "特征的业务含义和判断方式。")],
  ),
  card(
    "WorkPackageDefinitionCard",
    "工作包定义",
    "描述某一类完整业务工作通常是什么。",
    [text("name", "名称", "可复用工作包的名称。", true), rich("description", "说明", "常见边界、结果和适用条件。")],
    [
      slot("tasks", "典型任务", "完成该工作包通常包含的任务定义。", ["TaskDefinitionCard"]),
      slot("dependencies", "前置工作包定义", "套用 Playbook 后应先完成的其他工作包定义。", ["WorkPackageDefinitionCard"]),
    ],
  ),
  card(
    "TaskDefinitionCard",
    "任务定义",
    "描述值得复用的典型任务。",
    [
      text("name", "名称", "典型任务的名称。", true),
      rich("description", "说明", "常见操作、输入和交付结果。"),
      text("role_hint", "建议角色", "通常适合承担这项任务的角色。"),
      text("duration_hint", "时间建议", "常见持续时间或提前量，例如活动前两周。"),
      rich("deliverable", "完成标志", "怎样判断这项任务已经真正完成。"),
    ],
    [slot("dependencies", "前置任务定义", "套用 Playbook 后应先完成的任务定义。", ["TaskDefinitionCard"])],
  ),
  card(
    "AdaptationPatternCard",
    "调整模式",
    "描述业务特征出现后 Activity 计划通常应如何调整。",
    [text("name", "名称", "调整模式的名称。", true), rich("condition", "适用条件", "哪些环境或特征触发这个调整。"), rich("guidance", "调整建议", "计划应如何变化，以及为什么。")],
  ),
  card(
    "ActivityPlaybookCard",
    "活动操作手册",
    "组织一张给人和 AI 阅读的建议型流程地图。",
    [
      text("name", "名称", "操作手册的名称。", true),
      rich("description", "简介", "手册解决什么问题。"),
      rich("applicable_scenario", "适用场景", "何时适合使用这份手册。"),
      rich("overview", "整体说明", "对整条流程的高层概括。"),
      rich("notes", "注意事项", "执行时需要特别注意的边界。"),
      text("lanes", "泳道顺序", "用于稳定展示的泳道顺序。"),
      enumeration("status", "成熟度", "这份方法是否仍在整理、可直接使用或已归档。", [["DRAFT", "整理中"], ["READY", "可使用"], ["ARCHIVED", "已归档"]], "DRAFT"),
    ],
    [
      slot("nodes", "指南节点", "手册中的全部节点。", ["GuideNodeCard"]),
      slot("start_nodes", "起点", "建议型流程地图的阅读起点。", ["GuideNodeCard"]),
    ],
  ),
  card(
    "GuideNodeCard",
    "操作指南节点",
    "流程地图中的一个建议、判断、资料入口或结果。",
    [
      text("name", "名称", "节点名称。", true),
      enumeration("node_type", "节点类型", "节点在流程中的作用。", [["ACTION", "操作"], ["DECISION", "判断"], ["REFERENCE", "参考"], ["END", "结束"]], "ACTION"),
      text("lane", "泳道", "节点所属的责任或阶段泳道。"),
      { key: "row", label: "纵向位置", description: "节点在泳道中的顺序。", type: "integer", constraints: { min: 0 }, changePolicy: operationalChange },
      rich("guide", "操作指南", "建议怎样执行。"),
      rich("applicable_condition", "适用条件", "何时应该进入这个节点。"),
      rich("required_information", "所需信息", "进入操作前需要掌握的信息。"),
      rich("expected_outcome", "预期结果", "完成节点后应得到的结果。"),
      rich("ai_assistance", "AI 协助说明", "AI 可以在这一步提供的协助。"),
      rich("resources", "资源与入口", "相关模板、系统、文件或联系入口。"),
      text("duration_hint", "时间建议", "这一步通常需要的时间或相对活动日期。"),
    ],
    [
      slot("next", "后续建议", "可以继续阅读的普通后续节点。", ["GuideNodeCard"]),
      slot("when_yes", "是", "判断为是时建议查看的节点。", ["GuideNodeCard"], "one"),
      slot("when_no", "否", "判断为否时建议查看的节点。", ["GuideNodeCard"], "one"),
      slot("subplaybook", "嵌套流程", "把复杂步骤展开为另一份可复用 Playbook。", ["ActivityPlaybookCard"], "one"),
      slot("definition", "工作包定义", "节点解释的可复用工作包定义。", ["WorkPackageDefinitionCard"], "one"),
      slot("resources", "支撑材料", "模板、表单或参考材料。", ["ArtifactCard"]),
    ],
  ),
  {
    ...card(
      "ActivityCard",
      "活动",
      "表示一次真实 Activity，并作为其运营工作台的业务根。",
      [
        { ...text("name", "名称", "这一届或这一次活动的正式名称。", true), changePolicy: activityKnowledgeChange },
        { ...rich("description", "简介", "本次活动的目标、范围与关键背景。"), changePolicy: activityKnowledgeChange },
        { ...activityStatus, changePolicy: activityKnowledgeChange },
        rich("progress", "总体进展", "面向整体协作者的当前态势和下一步摘要。"),
        { key: "time", label: "活动时间", description: "活动开始和结束的正式日期范围。", type: "date_range", changePolicy: activityKnowledgeChange },
        text("format", "活动形式", "例如线上、线下、比赛、交流或招新。"),
        text("venue", "场地", "本次活动已确认或当前拟定的主要地点。"),
        text("scale", "活动规模", "便于运营判断的规模描述。"),
        { key: "participant_count", label: "预计参与人数", description: "当前可用的参与人数预计或正式结果。", type: "integer", constraints: { min: 0 }, changePolicy: operationalChange },
      ],
      [
        slot("work_packages", "工作包", "该 Activity 中持久存在的完整运营工作。", ["WorkPackageCard"]),
        slot("adopted_playbook", "采用的方法", "本次活动正在参考并已经套用的 Playbook。", ["ActivityPlaybookCard"], "one"),
        slot("assignments", "活动负责人", "对整个 Activity 承担总责或统筹责任的分配。", ["AssignmentCard"]),
        slot("milestones", "里程碑", "影响多项工作的关键时点。", ["MilestoneCard"]),
        slot("budgets", "预算", "本次活动的正式预算。", ["BudgetCard"]),
        slot("purchases", "采购", "本次活动中发生的采购事项。", ["PurchaseCard"]),
        slot("expenses", "支出", "本次活动已发生的支出。", ["ExpenseCard"]),
        slot("reimbursements", "报销", "本次活动的报销事项。", ["ReimbursementCard"]),
        slot("artifacts", "材料", "支撑该活动的文件、表单与凭证。", ["ArtifactCard"]),
        slot("approvals", "审批", "影响该活动的审批事项。", ["ApprovalCard"]),
        slot("registrations", "报名", "本次活动的报名记录。", ["RegistrationCard"]),
        slot("participations", "参与", "本次活动的参与记录。", ["ParticipationCard"]),
        slot("results", "结果", "本次活动已确认的正式结果。", ["ResultCard"]),
        slot("events", "运营事件", "运行中值得保留的重要事件。", ["OperationalEventCard"]),
        slot("plan_revisions", "计划修订", "对重要调整原因的正式记录。", ["PlanRevisionCard"]),
        slot("reviews", "复盘", "活动结束后的整体复盘。", ["ReviewCard"]),
      ],
    ),
    relatedObjects: {
      description: "关联这次真实活动对应的稳定 GlobalObject。",
      max: 1,
      uniqueCardPerObject: true,
      changePolicy: identityLinkChange,
    },
    changePolicy: activityKnowledgeChange,
  },
  card(
    "WorkPackageCard",
    "工作包",
    "表示某次 Activity 中一块完整、真实运行的工作。",
    workDimensions,
    [
      slot("definition", "工作包定义", "该工作包采用的可复用 Definition。", ["WorkPackageDefinitionCard"], "one"),
      slot("source_node", "来源步骤", "从 Playbook 套用时对应的操作指南节点。", ["GuideNodeCard"], "one"),
      slot("assignments", "负责人", "承担该工作包的工作分配。", ["AssignmentCard"]),
      slot("tasks", "任务", "该工作包中持久存在的真实任务。", ["TaskCard"]),
      slot("milestones", "里程碑", "直接影响该工作包的关键时点。", ["MilestoneCard"]),
      slot("dependencies", "依赖工作包", "当前工作开始或完成前依赖的其他工作包。", ["WorkPackageCard"]),
      slot("artifacts", "材料", "支撑该工作包的材料。", ["ArtifactCard"]),
      slot("approvals", "审批", "直接影响该工作包的审批。", ["ApprovalCard"]),
    ],
  ),
  card(
    "TaskCard",
    "任务",
    "表示一项真实需要执行、可以被单独理解和操作的任务。",
    workDimensions,
    [
      slot("definition", "任务定义", "该任务采用的可复用 Definition。", ["TaskDefinitionCard"], "one"),
      slot("assignments", "负责人", "承担该任务的工作分配。", ["AssignmentCard"]),
      slot("dependencies", "前置任务", "当前任务开始或完成前依赖的其他任务。", ["TaskCard"]),
      slot("artifacts", "材料", "支撑或由该任务产生的材料。", ["ArtifactCard"]),
      slot("approvals", "审批", "直接影响该任务的审批。", ["ApprovalCard"]),
    ],
  ),
  card(
    "MilestoneCard",
    "里程碑",
    "表示具有独立业务意义、会影响多个工作项的重要时间节点。",
    [
      text("name", "名称", "里程碑名称。", true),
      rich("description", "说明", "达到该里程碑所代表的正式结果。"),
      enumeration("status", "状态", "里程碑的当前状态。", [["UPCOMING", "待达成"], ["AT_RISK", "有风险"], ["ACHIEVED", "已达成"], ["MISSED", "已错过"], ["CANCELLED", "已取消"]], "UPCOMING"),
      date("target_date", "目标日期", "应达成该里程碑的日期。"),
    ],
  ),
  {
    ...card(
      "AssignmentCard",
      "工作分配",
      "表示某个稳定人物 Object 承担某项具体工作。",
      [
        text("role", "责任角色", "该人在这项工作中承担的角色，例如总负责、主办或协助。"),
        rich("responsibility", "责任说明", "该人具体承担的边界和交付。"),
      ],
    ),
    relatedObjects: {
      description: "只关联被稳定识别的人物 Object；Assignment 通过同 View Slot 与工作项连接。",
      min: 1,
      max: 1,
      changePolicy: identityLinkChange,
    },
  },
  card(
    "BudgetCard",
    "预算",
    "表示一个具有独立业务语义的活动预算。",
    [text("name", "名称", "预算项名称。", true), money("amount", "预算金额", "该预算项当前确认的上限或额度。"), enumeration("status", "状态", "预算的审核和使用状态。", [["DRAFT", "草案"], ["SUBMITTED", "已提交"], ["APPROVED", "已批准"], ["CLOSED", "已结算"], ["CANCELLED", "已取消"]], "DRAFT"), rich("notes", "说明", "资金来源、使用限制和核心假设。")],
    [slot("purchases", "采购", "使用该预算的采购。", ["PurchaseCard"]), slot("expenses", "支出", "计入该预算的实际支出。", ["ExpenseCard"])],
  ),
  card(
    "PurchaseCard",
    "采购",
    "表示一次真实采购事项。",
    [text("name", "名称", "采购事项名称。", true), rich("description", "说明", "需求、用途和交付要求。"), money("estimated_amount", "预估金额", "采购前的预估金额。"), enumeration("status", "状态", "采购执行状态。", [["REQUESTED", "待采购"], ["ORDERED", "已下单"], ["RECEIVED", "已收货"], ["CANCELLED", "已取消"]], "REQUESTED"), date("needed_by", "需求日期", "物资应到位的最晚日期。")],
    [slot("budget", "所属预算", "该采购占用的预算。", ["BudgetCard"], "one"), slot("assignments", "经办人", "负责采购的工作分配。", ["AssignmentCard"]), slot("artifacts", "采购材料", "清单、订单或付款材料。", ["ArtifactCard"])],
  ),
  card(
    "ExpenseCard",
    "支出",
    "表示一笔真实发生的活动支出。",
    [text("name", "名称", "支出用途的简洁名称。", true), rich("description", "说明", "支出的用途、对象和必要备注。"), money("amount", "金额", "该笔支出实际发生的金额。"), date("occurred_on", "发生日期", "支出实际发生的日期。"), enumeration("status", "状态", "支出凭证和报销归集状态。", [["RECORDED", "已登记"], ["VERIFIED", "已核验"], ["REIMBURSED", "已报销"], ["VOID", "已作废"]], "RECORDED")],
    [slot("purchase", "对应采购", "产生该支出的采购事项。", ["PurchaseCard"], "one"), slot("budget", "所属预算", "该支出归属的预算。", ["BudgetCard"], "one"), slot("artifacts", "凭证", "发票、支付记录和明细等材料。", ["ArtifactCard"])],
  ),
  card(
    "ReimbursementCard",
    "报销",
    "表示一次独立报销业务。",
    [text("name", "名称", "报销事项名称。", true), money("amount", "报销金额", "该次报销当前申请或已确认的金额。"), enumeration("status", "状态", "报销当前处理阶段。", [["DRAFT", "待整理"], ["SUBMITTED", "已提交"], ["RETURNED", "待补材料"], ["APPROVED", "已审批"], ["PAID", "已到账"], ["CANCELLED", "已取消"]], "DRAFT"), date("submitted_on", "提交日期", "报销正式提交的日期。"), date("paid_on", "到账日期", "报销款实际到账的日期。"), rich("notes", "说明", "缺失材料、审核问题或处理备注。")],
    [slot("expenses", "支出", "该报销包含的支出。", ["ExpenseCard"]), slot("artifacts", "报销材料", "申请表、凭证和审批附件。", ["ArtifactCard"]), slot("approvals", "审批", "该报销经过的审批。", ["ApprovalCard"]), slot("assignments", "经办人", "负责整理或跟进该报销的人。", ["AssignmentCard"])],
  ),
  card(
    "ArtifactCard",
    "材料",
    "表示文件、附件或外部入口在当前活动中的业务意义。",
    [text("name", "名称", "材料的业务名称。", true), text("artifact_type", "类型", "例如申请表、海报、名单、发票或回执。"), text("url", "链接", "可访问该材料的 HTTP(S) 链接或系统入口。"), enumeration("status", "状态", "材料的准备或确认状态。", [["MISSING", "待准备"], ["DRAFT", "草案"], ["READY", "已就绪"], ["ARCHIVED", "已归档"]], "MISSING"), rich("description", "说明", "材料的用途、版本或需要核对的内容。")],
  ),
  card(
    "ApprovalCard",
    "审批",
    "表示一次独立审批事项。",
    [text("name", "名称", "审批事项名称。", true), enumeration("status", "状态", "审批当前状态。", [["PENDING", "待提交"], ["SUBMITTED", "审批中"], ["APPROVED", "已通过"], ["REJECTED", "未通过"], ["WITHDRAWN", "已撤回"]], "PENDING"), date("requested_on", "提交日期", "审批正式提交的日期。"), date("resolved_on", "结果日期", "审批给出正式结果的日期。"), rich("decision", "结果说明", "审批结果、条件或退回原因。")],
    [slot("artifacts", "审批材料", "审批使用或产生的材料。", ["ArtifactCard"])],
  ),
  card(
    "RegistrationCard",
    "报名记录",
    "表示一次报名行为或报名记录。",
    [text("registrant_name", "报名人", "报名记录中的姓名或团队名称。", true), enumeration("status", "状态", "报名当前状态。", [["PENDING", "待确认"], ["CONFIRMED", "已确认"], ["WAITLISTED", "候补"], ["CANCELLED", "已取消"]], "PENDING"), datetime("registered_at", "报名时间", "报名记录产生的时间。"), rich("notes", "备注", "分组、特殊需求或需要核对的信息。")],
  ),
  {
    ...card(
      "ParticipationCard",
      "参与记录",
      "表示某个稳定主体在一次 Activity 中的参与身份和状态。",
      [text("role", "参与角色", "选手、嘉宾、工作人员或观众等业务角色。"), enumeration("status", "状态", "该主体的实际参与状态。", [["EXPECTED", "预计参与"], ["CHECKED_IN", "已签到"], ["COMPLETED", "已完成"], ["ABSENT", "未到场"], ["CANCELLED", "已取消"]], "EXPECTED"), rich("notes", "备注", "分组、结果或特殊情况。")],
    ),
    relatedObjects: {
      description: "可选地关联被稳定识别的参与者 Object。",
      max: 1,
      changePolicy: identityLinkChange,
    },
  },
  card(
    "ResultCard",
    "正式结果",
    "表示参与主体或 Activity 产生的正式结果。",
    [text("name", "名称", "结果名称。", true), rich("description", "结果内容", "排名、获奖、交付或结论。"), date("announced_on", "公布日期", "结果被正式确认或公布的日期。")],
    [slot("artifacts", "结果材料", "证明或展示该结果的材料。", ["ArtifactCard"])],
  ),
  card(
    "OperationalEventCard",
    "运营事件",
    "表示 Activity 运行中值得长期保留的重要业务事件。",
    [text("name", "名称", "事件名称。", true), rich("description", "事件说明", "发生了什么、影响什么和当时如何处理。"), datetime("occurred_at", "发生时间", "事件发生的准确时间。"), enumeration("severity", "影响程度", "事件对当前计划的影响。", [["INFO", "记录"], ["NOTICE", "需关注"], ["MAJOR", "重大"], ["CRITICAL", "紧急"]], "INFO")],
  ),
  card(
    "PlanRevisionCard",
    "计划修订",
    "记录为什么一批 Runtime Cards 或 Slots 发生了业务变化。",
    [text("name", "名称", "这次计划修订的名称。", true), rich("reason", "修订原因", "触发调整的现实变化或新信息。"), rich("summary", "变更摘要", "哪些工作状态、责任或时间发生了变化。"), datetime("revised_at", "修订时间", "计划正式修订的时间。")],
  ),
  card(
    "ReviewCard",
    "活动复盘",
    "表示某一次 Activity 的整体复盘。",
    [text("name", "名称", "复盘标题。", true), rich("summary", "总结", "本次活动的整体结果与判断。"), rich("went_well", "有效做法", "经过这次实际运行被验证有效的做法。"), rich("issues", "问题与变化", "本次发生的主要问题、例外和调整。"), rich("lessons", "经验与待验证项", "建议下一届复用、避免或重新确认的内容。"), date("reviewed_on", "复盘日期", "复盘形成正式版本的日期。")],
    [slot("experiences", "提炼经验", "从该次复盘中确认为值得复用的经验。", ["ExperienceCard"]), slot("artifacts", "复盘材料", "支撑复盘结论的文件与结果材料。", ["ArtifactCard"])],
  ),
  card(
    "ExperienceCard",
    "经验",
    "表示从一次或多次真实 Activity 中提炼的可复用经验。",
    [text("name", "名称", "经验名称。", true), rich("description", "内容", "经验的具体结论。"), rich("applicable_condition", "适用条件", "什么条件下这条经验才成立。"), rich("recommendation", "下届建议", "未来活动中建议如何使用这条经验。")],
  ),
] as const satisfies readonly CardTypeDefinition[];

export const activityOperationsViewModule: ViewModule = {
  manifest: {
    key: ACTIVITY_OPERATIONS_VIEW_KEY,
    label: "活动运营",
    specializedLabel: "活动方法与任务版图",
    schemaVersion: "3",
    description: "把可复用、可嵌套的活动组织方法套用为真实 Activity 的工作包、任务和依赖版图。",
    retrievalDescription:
      "用于设计活动组织 Playbook、嵌套流程、判断分支，并管理真实活动中的工作包、任务、负责人、截止日和前置依赖。",
    aiSemanticInstructions:
      "ActivityCard 表示某一届或某一次真实活动，不是长期活动类别；应通过 Related Object 关联已稳定识别的活动 Object。" +
      "ActivityPlaybookCard 是建议型组织方法，不代表任何一届已经执行；GuideNode 可通过 subplaybook 嵌套另一份方法。只有 activity.apply_playbook 才会把行动节点转成当前 Activity 的 WorkPackage 和 Task。" +
      "当届的时间、负责人、任务、进度、金额和材料以本 View 正式状态为准；历史 Assertion 和 Higher Memory 只作计划参考，不能自动写成当届状态。" +
      "WorkPackage 是可以独立理解、分配和跟踪的完整工作；Task 是其中可单独执行的行动。不要为二课、场地或宣传发明特殊状态结构。" +
      "Assignment 只关联可稳定指认的人物 Object，并通过目标工作项的 assignments Slot 表达本次具体分工。" +
      "所有正式状态变化只能使用已声明的 activity Commands；不建立跨 View Slot，不把聊天建议、Tool Result 或待审批 Proposal 当作已经执行。",
    defaultSettings: { aiWritePolicy: "approval_required" },
  },
  schema: {
    viewKey: ACTIVITY_OPERATIONS_VIEW_KEY,
    schemaVersion: "3",
    cardTypes: activityOperationsCardTypes,
  },
  queries: [],
  commands: activityOperationsCommands,
  invariants: activityOperationsInvariants,
  events: activityOperationsEvents,
};
