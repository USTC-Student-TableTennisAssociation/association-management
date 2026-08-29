import { z } from "zod";

import {
  zodContractSchema,
  type SkillExtension,
} from "@sydaris/plugin-sdk";

const uuid = z.string().uuid();
const phase = z.enum(["discuss", "propose"]).default("discuss");

export const activityPlaybookDesignerSkill: SkillExtension = {
  id: "echo.activity-operations.design-playbook",
  version: "1.0.0",
  label: "设计活动组织方法",
  description:
    "从 Activity View、Shared Brain 和活动原始资料中整理、新建、完善或审查活动 Playbook，包含泳道、可嵌套流程、判断分支和可生成的典型任务。用户讨论活动组织方法、流程或任务模板时使用。",
  inputSchema: zodContractSchema(z.object({
    operation: z.enum(["design", "refine", "review"]).default("design"),
    phase,
    playbookId: uuid.optional(),
    nodeId: uuid.optional(),
    focus: z.string().trim().min(1).max(500).optional(),
  })),
  instructions: [
    "目标是将有来源的活动经验整理为建议型 Playbook，不得把模型常识冒充为协会已有方法。",
    "1. 先打开 activity_operations Business Context，核对现有 Playbook、节点、嵌套关系和任务定义。View 为空只表示尚未建立方法，不表示知识库没有活动经验。",
    "2. 使用 synthesis 检索 Shared Brain，覆盖实际活动的流程、分工、审批、宣传、场地、物资、风险和复盘经验；宽综合需要继续定位 Library 文件并回读高价值原文。",
    "3. 明确分开三层：资料直接记载的做法、跨活动归纳的稳定模式、仅由 AI 提出的设计建议。前两层引用真实证据；第三层明确标记为建议。",
    "4. 将有据内容映射为泳道、ACTION/DECISION/REFERENCE/END 节点、YES/NO/NEXT 连线、无循环的子 Playbook，以及行动节点的工作包和典型任务定义。不要因为 Schema 支持某个字段就臆造具体流程。",
    "5. phase=discuss 时只输出来源覆盖、结构草案、推断边界和待确认项；不得打开 Actions，不得调用任何 View Command。",
    "6. phase=propose 时重新核对当前 View 和必要证据，再打开 business_view Actions；只提交本 Skill 允许的 Playbook Command。证据不足的可选细节留空或标记建议，不得写成已验证经验。",
  ].join("\n"),
  viewAccess: [{
    viewKey: "activity_operations",
    schemaVersion: "3",
    mode: "write",
    commands: [
      "activity.create_playbook",
      "activity.update_playbook",
      "activity.add_guide_node",
      "activity.update_guide_node",
      "activity.set_guide_edge",
      "activity.set_nested_playbook",
    ],
  }],
  knowledge: ["shared_brain", "library", "source_documents"],
  requiresCapabilities: [],
};

export const activityTaskMapPlannerSkill: SkillExtension = {
  id: "echo.activity-operations.plan-task-map",
  version: "1.0.0",
  label: "规划活动任务版图",
  description:
    "建立、完善或检查一次真实活动的工作包、任务、负责人、里程碑、截止日和前置依赖。用户要创建活动、套用组织方法、拆解任务或检查执行风险时使用。",
  inputSchema: zodContractSchema(z.object({
    operation: z.enum(["create", "plan", "review"]).default("plan"),
    phase,
    activityId: uuid.optional(),
    workItemId: uuid.optional(),
    focus: z.string().trim().min(1).max(500).optional(),
  })),
  instructions: [
    "目标是管理当前真实 Activity 的执行版图，而不是把历史活动的负责人、进度、日期或金额复制为当届事实。",
    "1. 先打开 activity_operations Business Context，核对目标 Activity、已套用方法、工作包、任务、依赖和分配。",
    "2. 需要参考经验时用 synthesis 检索 Shared Brain 并按需回读原文；历史资料只用于发现工作类型、常见依赖和风险。",
    "3. 区分 WorkPackage 与 Task：工作包必须可独立理解、分配和跟踪；任务是其中可单独执行的行动。前置关系表达必须先完成的工作，不要用文本顺序代替。",
    "4. 只有当届已确认信息才能写入负责人、日期、进度和状态；缺少创建 Activity 的必要身份或时间时再询问用户。",
    "5. phase=discuss 时只输出版图草案、依赖、风险和信息缺口，不得调用 View Command。phase=propose 时才打开 business_view Actions 并提交可审批变更。",
  ].join("\n"),
  viewAccess: [{
    viewKey: "activity_operations",
    schemaVersion: "3",
    mode: "write",
    commands: [
      "activity.create_activity",
      "activity.update_activity",
      "activity.add_work_package",
      "activity.update_work_package",
      "activity.add_task",
      "activity.update_task",
      "activity.remove_task",
      "activity.assign_owner",
      "activity.unassign_owner",
      "activity.add_milestone",
      "activity.update_milestone",
      "activity.apply_playbook",
      "activity.set_work_package_dependency",
      "activity.set_task_dependency",
    ],
  }],
  knowledge: ["shared_brain", "library", "source_documents"],
  requiresCapabilities: [],
};

