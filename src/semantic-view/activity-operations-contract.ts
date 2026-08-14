export const ACTIVITY_DIMENSIONS = {
  name: "名称",
  description: "简介",
  status: "状态",
  progress: "进度",
  time: "活动时间",
  format: "活动形式",
  scale: "活动规模",
  participantCount: "参与人数",
} as const;

export const WORK_PACKAGE_DIMENSIONS = {
  name: "名称",
  description: "简介",
  status: "状态",
  progress: "进度",
  deadline: "截止时间",
} as const;

export const TASK_DIMENSIONS = {
  name: "名称",
  status: "状态",
} as const;

export const PLAYBOOK_DIMENSIONS = {
  name: "名称",
  description: "简介",
  applicableScenario: "适用场景",
  overview: "整体说明",
  notes: "注意事项",
  lanes: "泳道顺序",
} as const;

export const GUIDE_NODE_DIMENSIONS = {
  name: "名称",
  nodeType: "节点类型",
  lane: "泳道",
  row: "纵向位置",
  guide: "操作指南",
  applicableCondition: "适用条件",
  requiredInformation: "所需信息",
  expectedOutcome: "预期结果",
  aiAssistance: "AI 协助说明",
  resources: "资源与入口",
} as const;

export const GUIDE_NODE_TYPES = [
  "ACTION",
  "DECISION",
  "REFERENCE",
  "END",
] as const;

export type GuideNodeType = typeof GUIDE_NODE_TYPES[number];

export const GUIDE_NODE_TYPE_LABELS: Record<GuideNodeType, string> = {
  ACTION: "操作建议",
  DECISION: "判断",
  REFERENCE: "资料 / 系统",
  END: "结果",
};

export const ACTIVITY_STATUSES = [
  "PLANNING",
  "RUNNING",
  "WRAP_UP",
  "COMPLETED",
  "CANCELLED",
] as const;

export type ActivityStatus = typeof ACTIVITY_STATUSES[number];

export const WORK_PACKAGE_STATUSES = [
  "NOT_STARTED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
] as const;

export type WorkPackageStatus = typeof WORK_PACKAGE_STATUSES[number];

export const ACTIVITY_STATUS_LABELS: Record<ActivityStatus, string> = {
  PLANNING: "筹备中",
  RUNNING: "进行中",
  WRAP_UP: "收尾中",
  COMPLETED: "已结束",
  CANCELLED: "已取消",
};

export const WORK_PACKAGE_STATUS_LABELS: Record<WorkPackageStatus, string> = {
  NOT_STARTED: "未开始",
  IN_PROGRESS: "进行中",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
};
