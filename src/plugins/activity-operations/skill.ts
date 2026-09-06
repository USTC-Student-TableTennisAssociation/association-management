import { z } from "zod";

import {
  zodContractSchema,
  type SkillExtension,
} from "@sydaris/plugin-sdk";

const uuid = z.string().uuid();
const phase = z.enum(["discuss", "propose"]).default("discuss");

export const activityPlaybookDesignerSkill: SkillExtension = {
  id: "sydaris.activity-operations.design-playbook",
  version: "2.2.0",
  label: "确定活动组织工作流",
  description:
    "先确定一种活动应当怎样组织，再规划某一届的具体执行。当用户准备负责或筹办真实活动，但尚未选定已确认的 Playbook，或希望沿用、整理往届框架时优先使用；也用于设计、完善或审查可复用 Playbook。",
  inputSchema: zodContractSchema(z.object({
    operation: z.enum(["design", "refine", "review"]).default("design"),
    phase,
    playbookId: uuid.optional(),
    nodeId: uuid.optional(),
    focus: z.string().trim().min(1).max(500).optional(),
  })),
  actionActivation: {
    inputField: "phase",
    allowedValues: ["propose"],
  },
  instructions: [
    "当前阶段只确定可复用工作流。先检查方法库；没有合适且已确认的方法时，从 Shared Brain 和少量高价值原文归纳，不进入某届 Activity 的负责人、日期、预算或进度。‘沿用往届框架’表示把历史实践作为方法来源，不表示直接复制为当届状态。",
    "先形成 Workflow Baseline：目的与适用边界、稳定责任域、可独立负责的 ACTION、并行与前置依赖、改变路线的 DECISION、关键产出与完成标志、例外路径。泳道是责任域而非时间阶段；所有路径最终到达 END。",
    "phase=discuss 输出一版完整方法草案、证据覆盖和只会改变方法结构的待确认项。不要同时输出当届任务版图，也不要追问仅属于实例的日期、人员或金额。用户确认方法后，再进入提议或另起下一阶段套用到真实 Activity。",
    "phase=propose 才能打开 activity_operations Actions。新建方法使用 activity.create_playbook_from_blueprint：提交完整但紧凑的方法骨架，由 Runtime 原子展开技术结构；默认只保留独立责任节点及每节点少量必要任务，不在 Command 参数里复述证据或讨论过程。既有方法使用局部更新命令。资料直接记载、跨资料归纳和 AI 建议要可区分；信息不足时保持 DRAFT。",
  ].join("\n"),
  viewAccess: [{
    viewKey: "activity_operations",
    schemaVersion: "3",
    mode: "write",
    planningCardTypes: [
      "ActivityPlaybookCard",
      "GuideNodeCard",
      "WorkPackageDefinitionCard",
      "TaskDefinitionCard",
      "ArtifactCard",
    ],
    commands: [
      "activity.create_playbook_from_blueprint",
      "activity.create_playbook_graph",
      "activity.update_playbook",
      "activity.add_guide_node",
      "activity.update_guide_node",
      "activity.set_guide_edge",
      "activity.set_nested_playbook",
    ],
  }],
  requiresCapabilities: [],
};

export const activityTaskMapPlannerSkill: SkillExtension = {
  id: "sydaris.activity-operations.plan-task-map",
  version: "1.1.0",
  label: "规划活动任务版图",
  description:
    "把已确认的 Playbook 套用为某次真实 Activity 的工作包、任务、负责人、里程碑、截止日和依赖，或维护 View 中已经存在的 Activity。仅在方法已经选定、正式 Activity 已存在，或用户明确要求跳过方法层时使用；一般的‘准备负责/筹办活动’应先使用确定活动组织工作流 Skill。",
  inputSchema: zodContractSchema(z.object({
    operation: z.enum(["create", "plan", "review"]).default("plan"),
    phase,
    workflowBasis: z.enum([
      "confirmed_playbook",
      "existing_activity",
      "explicit_direct_plan",
    ]),
    activityId: uuid.optional(),
    playbookId: uuid.optional(),
    workItemId: uuid.optional(),
    focus: z.string().trim().min(1).max(500).optional(),
  })),
  actionActivation: {
    inputField: "phase",
    allowedValues: ["propose"],
  },
  instructions: [
    "本 Skill 只处理真实 Activity。workflowBasis 必须来自真实前提：confirmed_playbook 表示已选定方法，existing_activity 表示 View 中已有正式 Activity，explicit_direct_plan 表示用户明确要求跳过方法层；不得自行假定。前提不成立时回到确定活动组织工作流阶段。",
    "先读取 activity_operations，核对目标 Activity、采用的方法、现有工作包、任务、依赖和分配。confirmed_playbook 应优先套用该方法，再补充本届差异；历史资料只用于风险与差异参考，不能自动成为本届事实。",
    "区分 WorkPackage 与 Task：工作包可独立理解、分配和跟踪，任务是其中的具体行动。前置关系表达真正依赖；并行工作不要画成单线。",
    "只有当届已确认信息才能写入负责人、日期、金额、进度和状态。按当前决策所需渐进询问，不要在方法尚未确定时一次索取全部实例信息。",
    "phase=discuss 只给本届版图草案、差异、风险和当前必要缺口；phase=propose 才打开 business_view Actions 并提交可审批变更。",
  ].join("\n"),
  viewAccess: [{
    viewKey: "activity_operations",
    schemaVersion: "3",
    mode: "write",
    planningCardTypes: [
      "ActivityCard",
      "WorkPackageCard",
      "TaskCard",
      "AssignmentCard",
      "MilestoneCard",
      "ActivityPlaybookCard",
    ],
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
  requiresCapabilities: [],
};
