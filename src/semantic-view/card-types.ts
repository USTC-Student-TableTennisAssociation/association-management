import {
  ACTIVITY_OPERATIONS_VIEW,
  SOCIETY_INFORMATION_VIEW,
  type BusinessViewKey,
} from "@/semantic-view/types";
import {
  ACTIVITY_DIMENSIONS,
  GUIDE_NODE_DIMENSIONS,
  PLAYBOOK_DIMENSIONS,
  TASK_DIMENSIONS,
  WORK_PACKAGE_DIMENSIONS,
} from "@/semantic-view/activity-operations-contract";

export type SlotDefinition = {
  key: string;
  label: string;
  meaning: string;
  allowedTargetCardTypes: readonly string[];
  allowedTargetViewKey?: BusinessViewKey;
  cardinality: "one" | "many";
};

export type CardTypeDefinition = {
  key: string;
  viewKey: BusinessViewKey;
  label: string;
  meaning: string;
  seedContentDimensions: readonly string[];
  slots: Readonly<Record<string, SlotDefinition>>;
};

export type BusinessViewDefinition = {
  key: BusinessViewKey;
  label: string;
  specializedLabel?: string;
  meaning: string;
  retrievalDescription: string;
  aiSemanticInstructions: string;
  cardTypes: Readonly<Record<string, CardTypeDefinition>>;
};

export const societyInformationCardTypes = {
  SocietyCard: {
    key: "SocietyCard",
    viewKey: SOCIETY_INFORMATION_VIEW,
    label: "社团",
    meaning: "描述社团自身的基本身份与长期信息。",
    seedContentDimensions: ["社团星级", "成立时间", "宗旨", "简介"],
    slots: {
      advisor: {
        key: "advisor",
        label: "指导老师",
        meaning: "为该社团提供正式指导的人员 Card。",
        allowedTargetCardTypes: ["PersonCard"],
        cardinality: "many",
      },
      positions: {
        key: "positions",
        label: "职位",
        meaning: "该社团在具体学年中的职位实例 Card。",
        allowedTargetCardTypes: ["PositionCard"],
        cardinality: "many",
      },
      activities: {
        key: "activities",
        label: "活动",
        meaning: "对理解社团有长期意义的活动或品牌赛事 Card。",
        allowedTargetCardTypes: ["ActivityCard"],
        cardinality: "many",
      },
      platforms: {
        key: "platforms",
        label: "平台",
        meaning: "社团长期使用的平台、线上入口或公开信息渠道 Card。",
        allowedTargetCardTypes: ["PlatformCard"],
        cardinality: "many",
      },
    },
  },
  PersonCard: {
    key: "PersonCard",
    viewKey: SOCIETY_INFORMATION_VIEW,
    label: "人物",
    meaning: "在社团信息中被稳定指认和连接的人物。",
    seedContentDimensions: ["简介"],
    slots: {},
  },
  PositionCard: {
    key: "PositionCard",
    viewKey: SOCIETY_INFORMATION_VIEW,
    label: "职位",
    meaning: "职位 Object 在某个学年中的具体业务实例及其任职人员；同一职位可按不同学年形成多张 Card。",
    seedContentDimensions: ["职位名称", "学年", "简介 / 职责"],
    slots: {
      holders: {
        key: "holders",
        label: "任职人员",
        meaning: "在该学年担任这个具体职位的人员 Card。",
        allowedTargetCardTypes: ["PersonCard"],
        cardinality: "many",
      },
    },
  },
  ActivityCard: {
    key: "ActivityCard",
    viewKey: SOCIETY_INFORMATION_VIEW,
    label: "活动",
    meaning: "对理解社团有长期意义的活动、品牌赛事或持续活动。",
    seedContentDimensions: ["简介", "举办时期"],
    slots: {},
  },
  PlatformCard: {
    key: "PlatformCard",
    viewKey: SOCIETY_INFORMATION_VIEW,
    label: "平台",
    meaning: "协会长期使用的平台、线上入口或公开信息渠道。",
    seedContentDimensions: ["平台类型", "访问方式", "简介"],
    slots: {},
  },
} as const satisfies Record<string, CardTypeDefinition>;

export const societyInformationViewDefinition = {
  key: SOCIETY_INFORMATION_VIEW,
  label: "社团信息",
  specializedLabel: "社团概览",
  meaning: "组织社团身份、基本信息、指导关系、学年职位、长期活动和平台入口。",
  retrievalDescription:
    "用于社团身份、基本信息、宗旨、星级、成立时间、指导老师、稳定人物关系、" +
    "学年职位、长期活动、平台与公开入口等稳定社团信息。",
  aiSemanticInstructions:
    "Card identity 必须来自 Shared Brain Object。ContentDimension 是开放结构；" +
    "Slot schema 只允许使用本 View 定义的 advisor、positions、activities、platforms 和 holders。" +
    "职位 Object 可以跨学年复用；PositionCard 必须设置学年，同一职位 Object 与同一学年只能有一张 Card；" +
    "PositionCard.holders 是任职关系的 canonical direction。",
  cardTypes: societyInformationCardTypes,
} as const satisfies BusinessViewDefinition;

function activityOperationsCardType(
  key: string,
  label: string,
  meaning: string,
  seedContentDimensions: readonly string[] = [],
  slots: Readonly<Record<string, SlotDefinition>> = {},
): CardTypeDefinition {
  return {
    key,
    viewKey: ACTIVITY_OPERATIONS_VIEW,
    label,
    meaning,
    seedContentDimensions,
    slots,
  };
}

/**
 * Activity Operations 当前最小业务词汇表。
 *
 * 这里只注册已经确定的 Card identity，并只保留已明确用于 Work Graph 主干的 Slots。
 * 它不是最终 Card、ContentDimension 或 Slot schema。
 */
export const activityOperationsCardTypes = {
  DimensionDefinitionCard: activityOperationsCardType(
    "DimensionDefinitionCard",
    "特征定义",
    "定义理解 Activity 时值得关注的一项业务特征。",
  ),
  WorkPackageDefinitionCard: activityOperationsCardType(
    "WorkPackageDefinitionCard",
    "工作包定义",
    "描述某一类完整业务工作通常是什么，而不是某次 Activity 的真实工作。",
  ),
  TaskDefinitionCard: activityOperationsCardType(
    "TaskDefinitionCard",
    "任务定义",
    "描述值得复用的典型任务，但不要求每项真实任务都来自定义。",
  ),
  AdaptationPatternCard: activityOperationsCardType(
    "AdaptationPatternCard",
    "调整模式",
    "描述业务特征出现后，Activity 计划通常应怎样调整。",
  ),
  ActivityPlaybookCard: activityOperationsCardType(
    "ActivityPlaybookCard",
    "活动操作手册",
    "组织一张给人和 AI 阅读的建议型流程地图，不保存 Runtime 执行进度。",
    Object.values(PLAYBOOK_DIMENSIONS),
    {
      nodes: {
        key: "nodes",
        label: "指南节点",
        meaning: "这张操作手册中可导航、可解释的全部节点。",
        allowedTargetCardTypes: ["GuideNodeCard"],
        cardinality: "many",
      },
      start_nodes: {
        key: "start_nodes",
        label: "起点",
        meaning: "建议型流程地图的一个或多个阅读起点。",
        allowedTargetCardTypes: ["GuideNodeCard"],
        cardinality: "many",
      },
    },
  ),
  GuideNodeCard: activityOperationsCardType(
    "GuideNodeCard",
    "操作指南节点",
    "流程地图中的一个建议、判断、资料入口或结果；节点本身不要求打卡。",
    Object.values(GUIDE_NODE_DIMENSIONS),
    {
      next: {
        key: "next",
        label: "后续建议",
        meaning: "从当前节点可以继续阅读的普通后续节点；可表示并行建议。",
        allowedTargetCardTypes: ["GuideNodeCard"],
        cardinality: "many",
      },
      when_yes: {
        key: "when_yes",
        label: "是",
        meaning: "判断为是时建议查看的节点。",
        allowedTargetCardTypes: ["GuideNodeCard"],
        cardinality: "one",
      },
      when_no: {
        key: "when_no",
        label: "否",
        meaning: "判断为否时建议查看的节点。",
        allowedTargetCardTypes: ["GuideNodeCard"],
        cardinality: "one",
      },
      definition: {
        key: "definition",
        label: "工作包定义",
        meaning: "该指南节点所解释的可复用 Work Package Definition。",
        allowedTargetCardTypes: ["WorkPackageDefinitionCard"],
        cardinality: "one",
      },
      resources: {
        key: "resources",
        label: "支撑材料",
        meaning: "模板、表单或参考材料 Card；简单网址也可先写在资源与入口 Dimension。",
        allowedTargetCardTypes: ["ArtifactCard"],
        cardinality: "many",
      },
    },
  ),
  ActivityCard: activityOperationsCardType(
    "ActivityCard",
    "活动",
    "表示一次真实 Activity，并作为其 Activity Workspace 的业务根。",
    Object.values(ACTIVITY_DIMENSIONS),
    {
      work_packages: {
        key: "work_packages",
        label: "工作包",
        meaning: "该 Activity 中持久存在的 Runtime Work Package Cards。",
        allowedTargetCardTypes: ["WorkPackageCard"],
        cardinality: "many",
      },
      assignments: {
        key: "assignments",
        label: "负责人",
        meaning: "承担该 Activity 负责工作的 Assignment Cards。",
        allowedTargetCardTypes: ["AssignmentCard"],
        cardinality: "many",
      },
    },
  ),
  WorkPackageCard: activityOperationsCardType(
    "WorkPackageCard",
    "工作包",
    "表示某次 Activity 中一块完整、真实运行的工作。",
    Object.values(WORK_PACKAGE_DIMENSIONS),
    {
      definition: {
        key: "definition",
        label: "工作包定义",
        meaning: "该 Runtime Work Package 采用的可复用 Definition；临时工作包可以为空。",
        allowedTargetCardTypes: ["WorkPackageDefinitionCard"],
        cardinality: "one",
      },
      assignments: {
        key: "assignments",
        label: "负责人",
        meaning: "承担该 Work Package 负责工作的 Assignment Cards。",
        allowedTargetCardTypes: ["AssignmentCard"],
        cardinality: "many",
      },
      tasks: {
        key: "tasks",
        label: "任务",
        meaning: "该工作包中持久存在的真实 Task Cards。",
        allowedTargetCardTypes: ["TaskCard"],
        cardinality: "many",
      },
    },
  ),
  TaskCard: activityOperationsCardType(
    "TaskCard",
    "任务",
    "表示一项真实需要执行、可以被单独理解和操作的任务。",
    Object.values(TASK_DIMENSIONS),
  ),
  MilestoneCard: activityOperationsCardType(
    "MilestoneCard",
    "里程碑",
    "表示具有独立业务意义、会影响多个工作项的重要时间节点。",
  ),
  AssignmentCard: activityOperationsCardType(
    "AssignmentCard",
    "工作分配",
    "表示某个人承担某项具体工作的业务事实。",
    [],
    {
      assignee: {
        key: "assignee",
        label: "负责人",
        meaning: "承担这项工作的 Society Information Person Card。",
        allowedTargetCardTypes: ["PersonCard"],
        allowedTargetViewKey: SOCIETY_INFORMATION_VIEW,
        cardinality: "one",
      },
    },
  ),
  BudgetCard: activityOperationsCardType(
    "BudgetCard",
    "预算",
    "表示一个具有独立业务语义的预算。",
  ),
  PurchaseCard: activityOperationsCardType(
    "PurchaseCard",
    "采购",
    "表示一次真实采购事项。",
  ),
  ExpenseCard: activityOperationsCardType(
    "ExpenseCard",
    "支出",
    "表示一笔真实支出，金额等信息属于它自身的 ContentDimension。",
  ),
  ReimbursementCard: activityOperationsCardType(
    "ReimbursementCard",
    "报销",
    "表示一次真实报销业务。",
  ),
  ArtifactCard: activityOperationsCardType(
    "ArtifactCard",
    "材料",
    "表示文件或附件在业务上是什么；文件本身只是 backing file。",
  ),
  ApprovalCard: activityOperationsCardType(
    "ApprovalCard",
    "审批",
    "表示一次独立审批事项。",
  ),
  RegistrationCard: activityOperationsCardType(
    "RegistrationCard",
    "报名记录",
    "表示一次报名行为或报名记录。",
  ),
  ParticipationCard: activityOperationsCardType(
    "ParticipationCard",
    "参与记录",
    "表示某个主体在一次 Activity 中的参与身份和状态。",
  ),
  ResultCard: activityOperationsCardType(
    "ResultCard",
    "正式结果",
    "表示参与主体或 Activity 产生的正式结果。",
  ),
  OperationalEventCard: activityOperationsCardType(
    "OperationalEventCard",
    "运营事件",
    "表示 Activity 运行中值得长期保留的重要业务事件，而不是操作日志。",
  ),
  PlanRevisionCard: activityOperationsCardType(
    "PlanRevisionCard",
    "计划修订",
    "记录为什么一批 Runtime Cards 或 Slots 发生了有业务意义的变化。",
  ),
  ReviewCard: activityOperationsCardType(
    "ReviewCard",
    "活动复盘",
    "表示某一次 Activity 的整体复盘，属于具体 Case。",
  ),
  ExperienceCard: activityOperationsCardType(
    "ExperienceCard",
    "经验",
    "表示从一次或多次真实 Activity 中提炼、值得未来参考的一条经验。",
  ),
} as const satisfies Record<string, CardTypeDefinition>;

export const activityOperationsViewDefinition = {
  key: ACTIVITY_OPERATIONS_VIEW,
  label: "Activity Operations",
  specializedLabel: "活动总览",
  meaning: "组织真实 Activity 的运营状态、可复用业务知识和复盘经验。",
  retrievalDescription:
    "用于真实活动、工作包、任务、里程碑、分配、预算、采购、支出、报销、材料、审批、" +
    "报名、参与、结果、重要运营事件、计划修订、复盘和活动运营经验。",
  aiSemanticInstructions:
    "这是持续演化的最小骨架。Business State 只由 SemanticCard、ContentDimension 和 SlotBinding 表达；" +
    "不使用通用 Relation。ContentDimension 是开放的语义内容区域，不限于简单字符串；" +
    "Activity 状态只用 PLANNING|RUNNING|WRAP_UP|COMPLETED|CANCELLED；" +
    "WorkPackage 状态只用 NOT_STARTED|IN_PROGRESS|COMPLETED|CANCELLED；进度保留自然语言业务语境；" +
    "参与人数只记录有确定依据的整数，不根据活动规模猜测人数；" +
    "ActivityPlaybook 和 GuideNode 是建议型程序知识；它们用 next|when_yes|when_no 表达可视化路径，但不表达 Runtime 完成状态，不得据此声称用户执行到某一步；" +
    "Slot 只能使用当前开发者合同，不得自行补全最终 Slot 或 ContentDimension schema；负责人必须通过 Assignment.assignee 指向 Person Card；" +
    "Work Graph 就是持久 Runtime Cards、ContentDimensions 与 SlotBindings，不得另建 graph snapshot。",
  cardTypes: activityOperationsCardTypes,
} as const satisfies BusinessViewDefinition;

export const businessViewDefinitions = {
  [SOCIETY_INFORMATION_VIEW]: societyInformationViewDefinition,
  [ACTIVITY_OPERATIONS_VIEW]: activityOperationsViewDefinition,
} as const satisfies Record<BusinessViewKey, BusinessViewDefinition>;

export function businessViewDefinition(
  viewKey: string,
): BusinessViewDefinition | undefined {
  return businessViewDefinitions[viewKey as BusinessViewKey];
}

export function cardTypeDefinition(
  viewKey: string,
  cardTypeKey: string,
): CardTypeDefinition | undefined {
  return businessViewDefinition(viewKey)?.cardTypes[cardTypeKey];
}

export function cardTypePromptContract(viewKey: BusinessViewKey): string {
  const view = businessViewDefinitions[viewKey];
  return [
    `${view.key}（${view.label}）：${view.meaning}`,
    view.aiSemanticInstructions,
    ...Object.values(view.cardTypes).map((cardType) => {
      const slots = Object.values(cardType.slots) as SlotDefinition[];
      return [
        `${cardType.key}（${cardType.label}）：${cardType.meaning}`,
        `  seed ContentDimensions：${cardType.seedContentDimensions.join("、") || "无；ContentDimension 仍是开放结构"}`,
        `  slots：${slots.length ? slots.map((slot) => `${slot.key}（${slot.label}，${slot.cardinality}，target=${slot.allowedTargetCardTypes.join("|")}）`).join("；") : "无"}`,
      ].join("\n");
    }),
  ].join("\n");
}

export function businessViewRetrievalDescriptions(): string {
  return Object.values(businessViewDefinitions)
    .map((view) => `${view.key}（${view.label}）：${view.retrievalDescription}`)
    .join("\n");
}
