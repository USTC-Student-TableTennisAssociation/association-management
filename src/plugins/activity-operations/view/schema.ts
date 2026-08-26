import type {
  CardTypeDefinition,
  DimensionDefinition,
  SlotDefinition,
  ViewModule,
} from "@/contracts";
import { activityOperationsCommands } from "@/plugins/activity-operations/view/commands";
import { activityOperationsEvents } from "@/plugins/activity-operations/view/events";

export const ACTIVITY_OPERATIONS_VIEW_KEY = "activity_operations";

const text = (key: string, label: string, required = false): DimensionDefinition => ({
  key,
  label,
  type: "text",
  ...(required ? { required: true } : {}),
});
const rich = (key: string, label: string): DimensionDefinition => ({
  key,
  label,
  type: "rich_text",
  presentation: { multiline: true },
});
const slot = (
  key: string,
  label: string,
  description: string,
  allowedTargetCardTypes: readonly string[],
  cardinality: "one" | "many" = "many",
): SlotDefinition => ({ key, label, description, allowedTargetCardTypes, cardinality });
const card = (
  key: string,
  label: string,
  description: string,
  dimensions: readonly DimensionDefinition[] = [],
  slots: readonly SlotDefinition[] = [],
): CardTypeDefinition => ({ key, label, description, dimensions, slots });

const activityStatus: DimensionDefinition = {
  key: "status",
  label: "状态",
  type: "enum",
  constraints: {
    enumOptions: [
      { key: "PLANNING", label: "筹备中" },
      { key: "RUNNING", label: "进行中" },
      { key: "WRAP_UP", label: "收尾中" },
      { key: "COMPLETED", label: "已结束" },
      { key: "CANCELLED", label: "已取消" },
    ],
  },
};
const workStatus: DimensionDefinition = {
  key: "status",
  label: "状态",
  type: "enum",
  constraints: {
    enumOptions: [
      { key: "NOT_STARTED", label: "未开始" },
      { key: "IN_PROGRESS", label: "进行中" },
      { key: "COMPLETED", label: "已完成" },
      { key: "CANCELLED", label: "已取消" },
    ],
  },
};

export const activityOperationsCardTypes = [
  card("DimensionDefinitionCard", "特征定义", "定义理解 Activity 时值得关注的一项业务特征。"),
  card("WorkPackageDefinitionCard", "工作包定义", "描述某一类完整业务工作通常是什么。"),
  card("TaskDefinitionCard", "任务定义", "描述值得复用的典型任务。"),
  card("AdaptationPatternCard", "调整模式", "描述业务特征出现后 Activity 计划通常应如何调整。"),
  card(
    "ActivityPlaybookCard",
    "活动操作手册",
    "组织一张给人和 AI 阅读的建议型流程地图。",
    [
      text("name", "名称", true),
      rich("description", "简介"),
      rich("applicable_scenario", "适用场景"),
      rich("overview", "整体说明"),
      rich("notes", "注意事项"),
      text("lanes", "泳道顺序"),
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
      text("name", "名称", true),
      {
        key: "node_type",
        label: "节点类型",
        type: "enum",
        constraints: { enumOptions: ["ACTION", "DECISION", "REFERENCE", "END"].map((key) => ({ key, label: key })) },
      },
      text("lane", "泳道"),
      { key: "row", label: "纵向位置", type: "integer", constraints: { min: 0 } },
      rich("guide", "操作指南"),
      rich("applicable_condition", "适用条件"),
      rich("required_information", "所需信息"),
      rich("expected_outcome", "预期结果"),
      rich("ai_assistance", "AI 协助说明"),
      rich("resources", "资源与入口"),
    ],
    [
      slot("next", "后续建议", "可以继续阅读的普通后续节点。", ["GuideNodeCard"]),
      slot("when_yes", "是", "判断为是时建议查看的节点。", ["GuideNodeCard"], "one"),
      slot("when_no", "否", "判断为否时建议查看的节点。", ["GuideNodeCard"], "one"),
      slot("definition", "工作包定义", "节点解释的可复用工作包定义。", ["WorkPackageDefinitionCard"], "one"),
      slot("resources", "支撑材料", "模板、表单或参考材料 Card。", ["ArtifactCard"]),
    ],
  ),
  {
    ...card(
      "ActivityCard",
      "活动",
      "表示一次真实 Activity，并作为其 Activity Workspace 的业务根。",
      [
        text("name", "名称", true),
        rich("description", "简介"),
        activityStatus,
        rich("progress", "进度"),
        { key: "time", label: "活动时间", type: "date_range" },
        text("format", "活动形式"),
        text("scale", "活动规模"),
        { key: "participant_count", label: "参与人数", type: "integer", constraints: { min: 0 } },
      ],
      [
        slot("work_packages", "工作包", "该 Activity 中持久存在的 Runtime Work Package Cards。", ["WorkPackageCard"]),
        slot("assignments", "负责人", "承担该 Activity 负责工作的 Assignment Cards。", ["AssignmentCard"]),
      ],
    ),
    relatedObjects: {
      description: "关联该真实活动对应的稳定 GlobalObject。",
      max: 1,
      uniqueCardPerObject: true,
    },
  },
  card(
    "WorkPackageCard",
    "工作包",
    "表示某次 Activity 中一块完整、真实运行的工作。",
    [text("name", "名称", true), rich("description", "简介"), workStatus, rich("progress", "进度"), { key: "deadline", label: "截止时间", type: "date" }],
    [
      slot("definition", "工作包定义", "该 Runtime Work Package 采用的可复用 Definition。", ["WorkPackageDefinitionCard"], "one"),
      slot("assignments", "负责人", "承担该 Work Package 的 Assignment Cards。", ["AssignmentCard"]),
      slot("tasks", "任务", "该工作包中持久存在的真实 Task Cards。", ["TaskCard"]),
    ],
  ),
  card("TaskCard", "任务", "表示一项真实需要执行、可以被单独理解和操作的任务。", [text("name", "名称", true), workStatus]),
  card("MilestoneCard", "里程碑", "表示具有独立业务意义、会影响多个工作项的重要时间节点。"),
  {
    ...card("AssignmentCard", "工作分配", "表示某个稳定人物 Object 承担某项具体工作的业务 Card。"),
    relatedObjects: {
      description: "只关联被稳定识别的人物 Object；Assignment Card 通过同 View Slot 与工作项连接。",
      min: 1,
      max: 1,
    },
  },
  card("BudgetCard", "预算", "表示一个具有独立业务语义的预算。"),
  card("PurchaseCard", "采购", "表示一次真实采购事项。"),
  card("ExpenseCard", "支出", "表示一笔真实支出。"),
  card("ReimbursementCard", "报销", "表示一次真实报销业务。"),
  card("ArtifactCard", "材料", "表示文件或附件在业务上是什么。"),
  card("ApprovalCard", "审批", "表示一次独立审批事项。"),
  card("RegistrationCard", "报名记录", "表示一次报名行为或报名记录。"),
  card("ParticipationCard", "参与记录", "表示某个主体在一次 Activity 中的参与身份和状态。"),
  card("ResultCard", "正式结果", "表示参与主体或 Activity 产生的正式结果。"),
  card("OperationalEventCard", "运营事件", "表示 Activity 运行中值得长期保留的重要业务事件。"),
  card("PlanRevisionCard", "计划修订", "记录为什么一批 Runtime Cards 或 Slots 发生了业务变化。"),
  card("ReviewCard", "活动复盘", "表示某一次 Activity 的整体复盘。"),
  card("ExperienceCard", "经验", "表示从一次或多次真实 Activity 中提炼的经验。"),
] as const satisfies readonly CardTypeDefinition[];

export const activityOperationsViewModule: ViewModule = {
  manifest: {
    key: ACTIVITY_OPERATIONS_VIEW_KEY,
    label: "Activity Operations",
    specializedLabel: "活动总览",
    schemaVersion: "1",
    description: "组织真实 Activity 的运营状态、可复用业务知识和复盘经验。",
    retrievalDescription:
      "用于真实活动、工作包、任务、里程碑、分配、预算、采购、支出、报销、材料、审批、报名、参与、结果、重要运营事件、计划修订、复盘和活动运营经验。",
    aiSemanticInstructions:
      "正式业务状态使用统一 Card Graph、Typed Dimensions 和 View-local Slots。跨 View 只读，不建立跨 View Slot。",
    defaultSettings: { aiWritePolicy: "approval_required" },
  },
  schema: {
    viewKey: ACTIVITY_OPERATIONS_VIEW_KEY,
    schemaVersion: "1",
    cardTypes: activityOperationsCardTypes,
  },
  commands: activityOperationsCommands,
  invariants: [],
  events: activityOperationsEvents,
  projections: [],
};
