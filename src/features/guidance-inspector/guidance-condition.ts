import type { GuidanceCondition, GuidanceFactCondition, GuidanceJsonValue } from "./guidance-types";

export type FormattedGuidanceCondition =
  | { type: "fact"; text: string }
  | { type: "group"; label: string; children: readonly FormattedGuidanceCondition[] };

const fieldLabels: Record<string, string> = {
  "activity.type": "活动类型",
  "activity.days_until_event": "距活动天数",
  "activity.requires_second_class_approval": "是否需要二课审批",
  "activity.approval_status": "审批状态",
  "activity.phase": "活动阶段",
  "activity.requires_budget": "是否需要经费",
  "activity.budget_status": "预算状态",
  "activity.needs_venue": "是否需要场地",
  "activity.venue_status": "场地状态",
  "activity.closure_status": "结项状态",
  "activity.needs_core_assets": "是否需要核心物资",
  "activity.review_status": "复盘状态",
  "handover.in_progress": "是否正在交接",
  "member.stage": "成员阶段",
  "organization.asset_inventory_due": "是否到资产盘点期",
};

const operatorLabels: Record<GuidanceFactCondition["operator"], string> = {
  eq: "等于",
  ne: "不等于",
  in: "属于",
  not_in: "不属于",
  lt: "小于",
  lte: "小于或等于",
  gt: "大于",
  gte: "大于或等于",
  exists: "是否存在",
};

const valueLabels: Record<string, string> = {
  large_tournament: "大型赛事",
  regular_training: "周常训练",
  points_tournament: "积分赛",
  planning: "筹划中",
  preparation: "准备中",
  after_event: "活动结束后",
  closing: "结项中",
  reimbursement: "报销中",
  not_started: "未开始",
  submitted: "已提交",
  approved: "已批准",
  confirmed: "已确认",
  completed: "已完成",
  published: "已发布",
  in_progress: "进行中",
  new_officer: "新干事",
  apprentice: "见习期",
};

function isFactCondition(condition: GuidanceCondition): condition is GuidanceFactCondition {
  return "field" in condition;
}

function formatValue(value: GuidanceJsonValue | undefined): string {
  if (Array.isArray(value)) {
    return value.map((item) => formatValue(item)).join("、");
  }
  if (typeof value === "string") {
    return valueLabels[value] ?? value;
  }
  if (typeof value === "boolean") {
    return value ? "是" : "否";
  }
  if (value === null || value === undefined) {
    return "未设置";
  }
  if (typeof value === "number") {
    return String(value);
  }
  return JSON.stringify(value);
}

export function formatGuidanceCondition(
  condition: GuidanceCondition | null,
): FormattedGuidanceCondition {
  if (!condition) {
    return { type: "fact", text: "未设置适用条件" };
  }

  if (isFactCondition(condition)) {
    const field = fieldLabels[condition.field] ?? condition.field;
    const operator = operatorLabels[condition.operator];
    if (condition.operator === "exists") {
      return { type: "fact", text: `${field} ${operator}：${formatValue(condition.value)}` };
    }
    return {
      type: "fact",
      text: `${field} ${operator} ${formatValue(condition.value)}`,
    };
  }

  if (condition.all) {
    return {
      type: "group",
      label: "同时满足以下条件",
      children: condition.all.map((child) => formatGuidanceCondition(child)),
    };
  }

  if (condition.any) {
    return {
      type: "group",
      label: "满足以下任一条件",
      children: condition.any.map((child) => formatGuidanceCondition(child)),
    };
  }

  return { type: "fact", text: "未设置有效适用条件" };
}
