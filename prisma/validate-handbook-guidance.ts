import { pathToFileURL } from "node:url";

import {
  handbookGuidelineIds,
  handbookGuidelineLinks,
  handbookGuidelines,
  type ConditionOperator,
  type FactCondition,
  type GuidanceCondition,
  type GuidelineLinkSeed,
  type GuidelineSeed,
  type JsonValue,
} from "./handbook-guidance.data.js";

export type ValidationIssue = {
  path: string;
  message: string;
};

export type ValidationResult = {
  issues: ValidationIssue[];
  scenarioResults: ScenarioResult[];
};

type ScenarioResult = {
  name: string;
  matchedGuidelineIds: string[];
  expectedGuidelineIds: string[];
  excludedGuidelineIds: string[];
};

type FactContext = Record<string, unknown>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedKinds = new Set(["workflow", "rule", "checklist", "experience"]);
const allowedStatuses = new Set(["draft", "published"]);
const allowedRelationTypes = new Set(["contains", "triggers", "requires", "next", "exception"]);
const allowedOperators = new Set<ConditionOperator>([
  "eq",
  "ne",
  "in",
  "not_in",
  "lt",
  "lte",
  "gt",
  "gte",
  "exists",
]);
const allowedFactFields = new Set([
  "activity.type",
  "activity.days_until_event",
  "activity.requires_second_class_approval",
  "activity.approval_status",
  "activity.phase",
  "activity.requires_budget",
  "activity.budget_status",
  "activity.needs_venue",
  "activity.venue_status",
  "activity.closure_status",
  "activity.needs_core_assets",
  "activity.review_status",
  "handover.in_progress",
  "member.stage",
  "organization.asset_inventory_due",
]);
const allowedActionTypes = new Set([
  "create_task",
  "request_information",
  "show_checklist",
  "draft_document",
]);
const allowedActionKeys = new Set(["type", "title", "due", "description"]);

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  const objectValue = value as Record<string, unknown>;
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(objectValue[key])}`)
    .join(",")}}`;
}

export function guidelineContentMatchesSeed(
  existing: {
    title: string;
    kind: string;
    contentMarkdown: string;
    isMandatory: boolean;
    appliesWhen: unknown;
    suggestedActions: unknown;
    basisNote: string | null;
  },
  seed: GuidelineSeed,
): boolean {
  return (
    existing.title === seed.title &&
    existing.kind === seed.kind &&
    existing.contentMarkdown === seed.contentMarkdown &&
    existing.isMandatory === seed.isMandatory &&
    stableJson(existing.appliesWhen) === stableJson(seed.appliesWhen) &&
    stableJson(existing.suggestedActions) === stableJson(seed.suggestedActions) &&
    existing.basisNote === seed.basisNote
  );
}

function isFactCondition(condition: GuidanceCondition): condition is FactCondition {
  return "field" in condition;
}

function getFact(context: FactContext, field: string): unknown {
  return field.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && part in current) {
      return (current as Record<string, unknown>)[part];
    }

    return undefined;
  }, context);
}

function isEqual(left: unknown, right: JsonValue | undefined): boolean {
  return stableJson(left) === stableJson(right);
}

export function conditionMatches(condition: GuidanceCondition, context: FactContext): boolean {
  if (!isFactCondition(condition)) {
    if (condition.all) {
      return condition.all.every((item) => conditionMatches(item, context));
    }

    if (condition.any) {
      return condition.any.some((item) => conditionMatches(item, context));
    }

    return false;
  }

  const actual = getFact(context, condition.field);
  const expected = condition.value;

  switch (condition.operator) {
    case "eq":
      return isEqual(actual, expected);
    case "ne":
      return !isEqual(actual, expected);
    case "in":
      return Array.isArray(expected) && expected.some((item) => isEqual(actual, item));
    case "not_in":
      return Array.isArray(expected) && !expected.some((item) => isEqual(actual, item));
    case "lt":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "lte":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "gt":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "gte":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "exists":
      return expected === true ? actual !== undefined && actual !== null : actual === undefined || actual === null;
  }
}

function validateCondition(condition: GuidanceCondition, path: string, issues: ValidationIssue[]): void {
  if (isFactCondition(condition)) {
    if (!allowedFactFields.has(condition.field)) {
      issues.push({ path, message: `使用了未声明的事实字段：${condition.field}` });
    }

    if (!allowedOperators.has(condition.operator)) {
      issues.push({ path, message: `使用了不支持的条件操作符：${condition.operator}` });
    }

    if (condition.operator !== "exists" && condition.value === undefined) {
      issues.push({ path, message: `${condition.operator} 条件必须提供 value` });
    }

    if (
      condition.field === "activity.days_until_event" &&
      !["lt", "lte", "gt", "gte"].includes(condition.operator)
    ) {
      issues.push({ path, message: "activity.days_until_event 只能使用数值比较操作符" });
    }

    return;
  }

  const hasAll = Array.isArray(condition.all);
  const hasAny = Array.isArray(condition.any);

  if (hasAll === hasAny) {
    issues.push({ path, message: "条件组必须且只能使用 all 或 any 其中之一" });
    return;
  }

  const children = condition.all ?? condition.any ?? [];
  if (children.length === 0) {
    issues.push({ path, message: "条件组不能为空" });
  }

  children.forEach((child, index) => validateCondition(child, `${path}.${hasAll ? "all" : "any"}[${index}]`, issues));
}

function validateGuideline(seed: GuidelineSeed, index: number, ids: Set<string>, issues: ValidationIssue[]): void {
  const path = `guidelines[${index}]`;

  if (!uuidPattern.test(seed.id)) {
    issues.push({ path, message: "id 不是有效 UUID" });
  }

  if (ids.has(seed.id)) {
    issues.push({ path, message: `重复的 Guideline id：${seed.id}` });
  }
  ids.add(seed.id);

  if (!seed.title.trim()) {
    issues.push({ path, message: "标题不能为空" });
  }
  if (!allowedKinds.has(seed.kind)) {
    issues.push({ path, message: `kind 不在 schema 枚举中：${seed.kind}` });
  }
  if (!allowedStatuses.has(seed.status)) {
    issues.push({ path, message: `status 不在 schema 枚举中：${seed.status}` });
  }
  if (seed.status !== "draft") {
    issues.push({ path, message: "手册首批导入必须先保留为 draft" });
  }
  if (!seed.contentMarkdown.trim()) {
    issues.push({ path, message: "内容不能为空" });
  }
  if (!seed.basisNote.trim()) {
    issues.push({ path, message: "首批手册导入必须保留简短形成依据" });
  }
  if (seed.isMandatory && seed.suggestedActions.length === 0) {
    issues.push({ path, message: "强制指导至少要提供一个待确认动作" });
  }

  validateCondition(seed.appliesWhen, `${path}.appliesWhen`, issues);

  seed.suggestedActions.forEach((action, actionIndex) => {
    const actionPath = `${path}.suggestedActions[${actionIndex}]`;
    if (!allowedActionTypes.has(action.type)) {
      issues.push({ path: actionPath, message: `不允许的动作类型：${action.type}` });
    }
    if (!action.title.trim()) {
      issues.push({ path: actionPath, message: "动作标题不能为空" });
    }
    Object.keys(action).forEach((key) => {
      if (!allowedActionKeys.has(key)) {
        issues.push({ path: actionPath, message: `动作包含不允许的字段：${key}` });
      }
    });
  });
}

function validateLinks(ids: Set<string>, links: GuidelineLinkSeed[], issues: ValidationIssue[]): void {
  const duplicateKeys = new Set<string>();

  links.forEach((link, index) => {
    const path = `links[${index}]`;
    if (!ids.has(link.fromGuidelineId) || !ids.has(link.toGuidelineId)) {
      issues.push({ path, message: "连线指向了不存在的 Guideline" });
    }
    if (link.fromGuidelineId === link.toGuidelineId) {
      issues.push({ path, message: "不允许 Guideline 自环" });
    }
    if (!allowedRelationTypes.has(link.relationType)) {
      issues.push({ path, message: `relationType 不在 schema 枚举中：${link.relationType}` });
    }
    if (!link.note.trim()) {
      issues.push({ path, message: "首批导入的连线需要写明维护备注" });
    }

    const key = `${link.fromGuidelineId}:${link.toGuidelineId}:${link.relationType}`;
    if (duplicateKeys.has(key)) {
      issues.push({ path, message: "出现重复的联合主键连线" });
    }
    duplicateKeys.add(key);
  });
}

function validateAcyclicRelations(links: GuidelineLinkSeed[], issues: ValidationIssue[]): void {
  const relationTypes = new Set(["contains", "next", "requires"]);
  const graph = new Map<string, string[]>();

  links
    .filter((link) => relationTypes.has(link.relationType))
    .forEach((link) => {
      graph.set(link.fromGuidelineId, [...(graph.get(link.fromGuidelineId) ?? []), link.toGuidelineId]);
    });

  const visiting = new Set<string>();
  const visited = new Set<string>();

  function walk(node: string): void {
    if (visiting.has(node)) {
      issues.push({ path: "links", message: "contains、next 或 requires 关系中出现循环" });
      return;
    }
    if (visited.has(node)) {
      return;
    }

    visiting.add(node);
    (graph.get(node) ?? []).forEach(walk);
    visiting.delete(node);
    visited.add(node);
  }

  Array.from(graph.keys()).forEach(walk);
}

const regressionScenarios: Array<{
  name: string;
  context: FactContext;
  expected: string[];
  excluded: string[];
}> = [
  {
    name: "正常大型赛事筹备：仍有两周，尚未提交二课",
    context: {
      activity: {
        type: "large_tournament",
        days_until_event: 14,
        requires_second_class_approval: true,
        approval_status: "not_started",
        phase: "planning",
        requires_budget: true,
        budget_status: "not_started",
        needs_venue: true,
        venue_status: "not_started",
      },
    },
    expected: [
      handbookGuidelineIds.noApprovalNoActivity,
      handbookGuidelineIds.budgetBeforeActivity,
      handbookGuidelineIds.venueApplication,
      handbookGuidelineIds.largeEventWorkflow,
    ],
    excluded: [handbookGuidelineIds.largeEventT7Submission],
  },
  {
    name: "临期大型赛事：距活动 7 天仍未提交二课",
    context: {
      activity: {
        type: "large_tournament",
        days_until_event: 7,
        requires_second_class_approval: true,
        approval_status: "not_started",
        phase: "planning",
        requires_budget: true,
        budget_status: "not_started",
        needs_venue: true,
        venue_status: "not_started",
      },
    },
    expected: [
      handbookGuidelineIds.noApprovalNoActivity,
      handbookGuidelineIds.largeEventT7Submission,
      handbookGuidelineIds.largeEventWorkflow,
    ],
    excluded: [handbookGuidelineIds.regularActivityT3Submission],
  },
  {
    name: "常规活动临期：距活动 3 天内仍未申报",
    context: {
      activity: {
        type: "points_tournament",
        days_until_event: 2,
        requires_second_class_approval: true,
        approval_status: "not_started",
        phase: "preparation",
        requires_budget: false,
        needs_venue: false,
      },
    },
    expected: [handbookGuidelineIds.noApprovalNoActivity, handbookGuidelineIds.regularActivityT3Submission],
    excluded: [handbookGuidelineIds.largeEventT7Submission],
  },
  {
    name: "活动收尾但报销材料不完整",
    context: {
      activity: {
        phase: "closing",
        requires_budget: true,
        closure_status: "in_progress",
        review_status: "not_started",
      },
    },
    expected: [
      handbookGuidelineIds.reimbursementClosure,
      handbookGuidelineIds.fundedActivityClosure,
      handbookGuidelineIds.postmortemAndExperience,
    ],
    excluded: [handbookGuidelineIds.largeEventT7Submission],
  },
];

function validateRegressionScenarios(issues: ValidationIssue[]): ScenarioResult[] {
  return regressionScenarios.map((scenario) => {
    const matchedGuidelineIds = handbookGuidelines
      .filter((guideline) => conditionMatches(guideline.appliesWhen, scenario.context))
      .map((guideline) => guideline.id);

    scenario.expected.forEach((guidelineId) => {
      if (!matchedGuidelineIds.includes(guidelineId)) {
        issues.push({
          path: `scenarios.${scenario.name}`,
          message: `缺少预期命中的 Guideline：${guidelineId}`,
        });
      }
    });

    scenario.excluded.forEach((guidelineId) => {
      if (matchedGuidelineIds.includes(guidelineId)) {
        issues.push({
          path: `scenarios.${scenario.name}`,
          message: `错误命中了不应出现的 Guideline：${guidelineId}`,
        });
      }
    });

    return {
      name: scenario.name,
      matchedGuidelineIds,
      expectedGuidelineIds: scenario.expected,
      excludedGuidelineIds: scenario.excluded,
    };
  });
}

export function validateHandbookGuidance(): ValidationResult {
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();

  handbookGuidelines.forEach((guideline, index) => validateGuideline(guideline, index, ids, issues));

  const expectedIds = new Set(Object.values(handbookGuidelineIds));
  if (handbookGuidelines.length !== 12 || ids.size !== expectedIds.size) {
    issues.push({ path: "guidelines", message: "首批手册导入必须恰好覆盖 12 条 Guideline" });
  }
  expectedIds.forEach((id) => {
    if (!ids.has(id)) {
      issues.push({ path: "guidelines", message: `缺少预期的首批 Guideline：${id}` });
    }
  });

  const t7Guideline = handbookGuidelines.find((item) => item.id === handbookGuidelineIds.largeEventT7Submission);
  if (!t7Guideline?.contentMarkdown.includes("提交")) {
    issues.push({ path: "guidelines.largeEventT7Submission", message: "T-7 指导必须明确写为提交申请" });
  }
  if (t7Guideline?.contentMarkdown.includes("T-7 前审批通过")) {
    issues.push({ path: "guidelines.largeEventT7Submission", message: "不能把手册的 T-7 提交要求写成审批完成要求" });
  }

  validateLinks(ids, handbookGuidelineLinks, issues);
  validateAcyclicRelations(handbookGuidelineLinks, issues);
  const scenarioResults = validateRegressionScenarios(issues);

  return { issues, scenarioResults };
}

function printReport(result: ValidationResult): void {
  if (result.issues.length > 0) {
    console.error(`指导层种子校验失败：${result.issues.length} 项问题`);
    result.issues.forEach((issue) => console.error(`- ${issue.path}: ${issue.message}`));
    return;
  }

  console.log(`指导层种子校验通过：${handbookGuidelines.length} 条 Guideline，${handbookGuidelineLinks.length} 条连线。`);
  result.scenarioResults.forEach((scenario) => {
    console.log(`- ${scenario.name}：命中 ${scenario.matchedGuidelineIds.length} 条指导。`);
  });
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const result = validateHandbookGuidance();
  printReport(result);
  if (result.issues.length > 0) {
    process.exitCode = 1;
  }
}
