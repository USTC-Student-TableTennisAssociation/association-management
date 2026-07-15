/**
 * 《乒协生存手册》的指导层种子数据。
 *
 * 每张卡只承担一个稳定职责：工作流编排、硬规则、可验证检查表或经验。
 * 具体点击、提交、催审等动作仍以 suggestedActions 表示，未来可迁移为 ActionTemplate。
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type GuidelineKind = "workflow" | "rule" | "checklist" | "experience";
export type GuidelineStatus = "draft" | "published";
export type GuidelineRelationType = "contains" | "triggers" | "requires" | "next" | "exception";
export type ConditionOperator = "eq" | "ne" | "in" | "not_in" | "lt" | "lte" | "gt" | "gte" | "exists";

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
  activityLifecycle: "10000000-0000-4000-8000-000000000013",
  activityAdministrativeCompliance: "10000000-0000-4000-8000-000000000014",
  approvalApplicability: "10000000-0000-4000-8000-000000000015",
  approvalMaterials: "10000000-0000-4000-8000-000000000016",
  approvalSubmission: "10000000-0000-4000-8000-000000000017",
  approvalTracking: "10000000-0000-4000-8000-000000000018",
  approvalIssue: "10000000-0000-4000-8000-000000000019",
  budgetWorkflow: "10000000-0000-4000-8000-000000000020",
  expenseEligibility: "10000000-0000-4000-8000-000000000021",
  budgetDraft: "10000000-0000-4000-8000-000000000022",
  procurementBoundary: "10000000-0000-4000-8000-000000000023",
  budgetException: "10000000-0000-4000-8000-000000000024",
  venueWorkflow: "10000000-0000-4000-8000-000000000025",
  venueNeeds: "10000000-0000-4000-8000-000000000026",
  largeVenueRationale: "10000000-0000-4000-8000-000000000027",
  multiPurposeVenue: "10000000-0000-4000-8000-000000000028",
  venuePolicyConfirmation: "10000000-0000-4000-8000-000000000029",
  largeEventAdministration: "10000000-0000-4000-8000-000000000030",
  largeEventAssets: "10000000-0000-4000-8000-000000000031",
  largeEventOnSite: "10000000-0000-4000-8000-000000000032",
  largeEventCloseout: "10000000-0000-4000-8000-000000000033",
  largeEventMaterials: "10000000-0000-4000-8000-000000000034",
  largeEventRegistration: "10000000-0000-4000-8000-000000000035",
  largeEventScheduleException: "10000000-0000-4000-8000-000000000036",
  closureWorkflow: "10000000-0000-4000-8000-000000000037",
  reimbursementBudgetGate: "10000000-0000-4000-8000-000000000038",
  assetQuantityBalance: "10000000-0000-4000-8000-000000000039",
  remainingAssetInventory: "10000000-0000-4000-8000-000000000040",
  reimbursementException: "10000000-0000-4000-8000-000000000041",
  fundedNewsGate: "10000000-0000-4000-8000-000000000042",
  newsReviewRelease: "10000000-0000-4000-8000-000000000043",
  secondClassClosure: "10000000-0000-4000-8000-000000000044",
  organizationOperations: "10000000-0000-4000-8000-000000000045",
  assetLedger: "10000000-0000-4000-8000-000000000046",
  assetBorrowReturn: "10000000-0000-4000-8000-000000000047",
  keyManagement: "10000000-0000-4000-8000-000000000048",
  semesterInventory: "10000000-0000-4000-8000-000000000049",
  assetIssue: "10000000-0000-4000-8000-000000000050",
  handoverWork: "10000000-0000-4000-8000-000000000051",
  handoverAccounts: "10000000-0000-4000-8000-000000000052",
  handoverAssets: "10000000-0000-4000-8000-000000000053",
  handoverRelationships: "10000000-0000-4000-8000-000000000054",
  handoverAcceptance: "10000000-0000-4000-8000-000000000055",
  officerOrientation: "10000000-0000-4000-8000-000000000056",
  officerApprenticeship: "10000000-0000-4000-8000-000000000057",
  officerReadiness: "10000000-0000-4000-8000-000000000058",
  officerAuthorityBoundary: "10000000-0000-4000-8000-000000000059",
  reviewFeedback: "10000000-0000-4000-8000-000000000060",
  reviewDecisionRecord: "10000000-0000-4000-8000-000000000061",
  reviewDraft: "10000000-0000-4000-8000-000000000062",
  reviewHumanApproval: "10000000-0000-4000-8000-000000000063",
  reviewPublication: "10000000-0000-4000-8000-000000000064",
} as const;

type GuidelineKey = keyof typeof handbookGuidelineIds;
type DraftGuideline = Omit<GuidelineSeed, "id" | "status">;

function fact(field: string, operator: ConditionOperator, value?: JsonValue): FactCondition {
  return value === undefined ? { field, operator } : { field, operator, value };
}

function all(...conditions: GuidanceCondition[]): GuidanceCondition {
  return { all: conditions };
}

function any(...conditions: GuidanceCondition[]): GuidanceCondition {
  return { any: conditions };
}

function guideline(key: GuidelineKey, seed: DraftGuideline): GuidelineSeed {
  return { id: handbookGuidelineIds[key], ...seed, status: "draft" };
}

function action(type: SuggestedAction["type"], title: string, due?: string): SuggestedAction {
  return due ? { type, title, due } : { type, title };
}

function link(
  from: GuidelineKey,
  to: GuidelineKey,
  relationType: GuidelineRelationType,
  note: string,
): GuidelineLinkSeed {
  return {
    fromGuidelineId: handbookGuidelineIds[from],
    toGuidelineId: handbookGuidelineIds[to],
    relationType,
    note,
  };
}

const basis = {
  activity: "整理自《乒协生存手册》第 15–21 页；具体安排以当年学校通知为准。",
  approval: "整理自《乒协生存手册》第 15、19 页；手册明确的是提交时限，不是固定审批完成时限。",
  budget: "整理自《乒协生存手册》第 16–17 页 §6.2；固定金额与细则不作为永久规则导入。",
  venue: "整理自《乒协生存手册》第 17–18 页 §6.3；常规场馆时限应以当期流程确认。",
  largeEvent: "整理自《乒协生存手册》第 19–20 页 §7.1；未在手册明确的现场细则不作为硬规则。",
  closure: "整理自《乒协生存手册》第 16–17、20–21 页；结项与报销细则以当年通知为准。",
  assets: "整理自《乒协生存手册》第 18 页 §6.3.3。",
  handover: "整理自《乒协生存手册》第 24–25 页 §9.3。",
  growth: "整理自《乒协生存手册》第 24、29–30 页 §9.2、§11.2–11.3。",
  review: "整理自《乒协生存手册》第 20、23–24、30 页 §7.1.4、§9.1、§11.4。",
} as const;

export const handbookGuidelines: GuidelineSeed[] = [
  guideline("activityLifecycle", {
    title: "活动全生命周期",
    kind: "workflow",
    isMandatory: false,
    appliesWhen: all(fact("activity.type", "exists", true)),
    contentMarkdown: "## 目标\n以立项合规、筹备、现场、结项和复盘组织活动知识。各阶段只给出应阅读的模块；活动实际状态仍由人确认。",
    suggestedActions: [action("show_checklist", "按活动阶段查看当前需要处理的模块")],
    basisNote: basis.activity,
  }),
  guideline("activityAdministrativeCompliance", {
    title: "活动行政合规与二课审批",
    kind: "workflow",
    isMandatory: true,
    appliesWhen: all(fact("activity.phase", "in", ["planning", "preparation"])),
    contentMarkdown: "## 目标\n在活动开展前完成审批适用性判断、时限选择、材料提交、审核跟踪和放行检查。\n\n## 完成标准\n审批要求、提交状态和实际开展门禁均可被核对。",
    suggestedActions: [action("show_checklist", "检查二课审批和活动放行链路")],
    basisNote: basis.approval,
  }),
  guideline("approvalApplicability", {
    title: "确认活动是否需要二课审批",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: any(
      fact("activity.requires_second_class_approval", "exists", false),
      fact("activity.requires_second_class_approval", "eq", true),
    ),
    contentMarkdown: "## 检查项\n- 确认活动类型、日期、规模和是否涉及二课要求。\n- 记录是否需要审批；无法确认时不得自行假设为不需要。\n\n## 输出\n将审批适用性标记为需要、不需要或待确认。",
    suggestedActions: [action("request_information", "确认活动类型、日期与二课审批适用性")],
    basisNote: basis.approval,
  }),
  guideline("largeEventT7Submission", {
    title: "大型赛事：活动前至少 7 天提交二课申请",
    kind: "rule",
    isMandatory: true,
    appliesWhen: all(
      fact("activity.type", "eq", "large_tournament"),
      fact("activity.days_until_event", "lte", 7),
      fact("activity.approval_status", "not_in", ["submitted", "pending", "approved"]),
    ),
    contentMarkdown: "## 规则\n大型赛事应在活动前至少 7 天在二课系统**提交申请**。这条规则不把 T-7 误写成审批必须完成。",
    suggestedActions: [action("create_task", "立即提交大型赛事二课申请", "立即")],
    basisNote: basis.approval,
  }),
  guideline("regularActivityT3Submission", {
    title: "常规活动：活动前 3 天完成系统申报",
    kind: "rule",
    isMandatory: true,
    appliesWhen: all(
      fact("activity.type", "in", ["regular_training", "points_tournament"]),
      fact("activity.days_until_event", "lte", 3),
      fact("activity.approval_status", "not_in", ["submitted", "pending", "approved"]),
    ),
    contentMarkdown: "## 规则\n周常训练、积分赛等常规活动，应在活动前 3 天完成系统申报。提交后仍需按审批状态决定是否能够开展。",
    suggestedActions: [action("create_task", "完成常规活动系统申报", "活动前 3 天")],
    basisNote: "整理自《乒协生存手册》第 15 页 §6.1.2。",
  }),
  guideline("approvalMaterials", {
    title: "二课申报材料完整性检查",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(
      fact("activity.requires_second_class_approval", "eq", true),
      fact("activity.approval_status", "in", ["not_started", "returned"]),
    ),
    contentMarkdown: "## 检查项\n- 策划案及必要安全预案。\n- 预算明细。\n- 活动时间、场地、预计规模等基础信息。\n- 全校性活动是否另有纸质策划案等当年材料要求。\n\n## 通过标准\n材料可用于提交，缺项已有明确补充责任人。",
    suggestedActions: [action("show_checklist", "核对二课申请材料是否齐全")],
    basisNote: basis.approval,
  }),
  guideline("approvalSubmission", {
    title: "提交二课申请并留存凭证",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(
      fact("activity.requires_second_class_approval", "eq", true),
      fact("activity.approval_status", "eq", "not_started"),
    ),
    contentMarkdown: "## 操作结果\n在对应系统提交申请，并记录提交时间、申请编号或可复核截图、当前审核状态。\n\n## 不应假设\n提交成功不等于审批通过。",
    suggestedActions: [action("create_task", "提交二课申请并记录申请凭证")],
    basisNote: basis.approval,
  }),
  guideline("approvalTracking", {
    title: "跟踪二课审核进度",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(fact("activity.approval_status", "in", ["submitted", "pending"])),
    contentMarkdown: "## 检查项\n- 确认申请处于挂靠单位审核、管指委审批或其他当期环节。\n- 为可能的催审和补充材料预留时间。\n- 仅在可核对后记录已通过。",
    suggestedActions: [action("request_information", "确认二课申请当前审核环节和待补材料")],
    basisNote: basis.approval,
  }),
  guideline("approvalIssue", {
    title: "二课审批受阻、退回或状态不明处理",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: any(
      fact("activity.approval_status", "in", ["unknown", "returned", "rejected"]),
      fact("activity.requires_second_class_approval", "exists", false),
    ),
    contentMarkdown: "## 处理顺序\n- 状态不明：先向负责行政的同学或指导老师确认。\n- 被退回：记录退回原因，补齐材料后重新提交。\n- 临近活动仍未提交：标记风险，不能把审批完成当作既成事实。",
    suggestedActions: [action("request_information", "确认审批受阻原因、负责人和下一步要求")],
    basisNote: basis.approval,
  }),
  guideline("noApprovalNoActivity", {
    title: "未获二课审批不得进入实际开展",
    kind: "rule",
    isMandatory: true,
    appliesWhen: all(
      fact("activity.requires_second_class_approval", "eq", true),
      fact("activity.approval_status", "not_in", ["approved"]),
      fact("activity.phase", "in", ["preparation", "active"]),
    ),
    contentMarkdown: "## 规则\n需要二课审批的活动，在未获审批前不得进入实际开展阶段。该门禁不等同于 T-7 或 T-3 的提交时限规则。",
    suggestedActions: [action("show_checklist", "暂停将活动视为可执行，并核对审批状态")],
    basisNote: "整理自《乒协生存手册》第 15 页 §6.1.1。",
  }),

  guideline("budgetWorkflow", {
    title: "活动预算与采购控制",
    kind: "workflow",
    isMandatory: true,
    appliesWhen: all(fact("activity.requires_budget", "eq", true)),
    contentMarkdown: "## 目标\n在活动前形成可核对预算，采购时不突破用途和金额边界；变化与超支进入单独处理。",
    suggestedActions: [action("show_checklist", "检查预算、采购与变更处理链路")],
    basisNote: basis.budget,
  }),
  guideline("budgetBeforeActivity", {
    title: "活动支出应在活动前纳入预算",
    kind: "rule",
    isMandatory: true,
    appliesWhen: all(
      fact("activity.phase", "in", ["planning", "preparation"]),
      fact("activity.requires_budget", "eq", true),
      fact("activity.budget_status", "not_in", ["confirmed", "approved"]),
    ),
    contentMarkdown: "## 规则\n每一笔与活动有关的支出，都应在活动开始前明确列入预算。报销原则上不应超过已审批预算。",
    suggestedActions: [action("draft_document", "整理活动预算明细")],
    basisNote: basis.budget,
  }),
  guideline("expenseEligibility", {
    title: "社团经费不得用于无关私人消费",
    kind: "rule",
    isMandatory: true,
    appliesWhen: all(fact("activity.requires_budget", "eq", true)),
    contentMarkdown: "## 规则\n经费用途应与活动和社团建设直接相关，不得用于聚餐、私人娱乐或其他无关消费。用途边界不明确时，应先确认当期财务要求。",
    suggestedActions: [action("request_information", "确认拟支出的活动用途和财务适用性")],
    basisNote: basis.budget,
  }),
  guideline("budgetDraft", {
    title: "编制活动预算明细",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(
      fact("activity.requires_budget", "eq", true),
      fact("activity.budget_status", "in", ["not_started", "draft"]),
    ),
    contentMarkdown: "## 检查项\n逐项列出竞赛物资、荣誉物资、必要服务和其他支出，并注明用途、数量、单价、预计金额与负责人。",
    suggestedActions: [action("draft_document", "起草可核对的预算明细")],
    basisNote: basis.budget,
  }),
  guideline("procurementBoundary", {
    title: "采购前核对型号、数量与预算边界",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(
      fact("activity.requires_budget", "eq", true),
      fact("activity.procurement_status", "in", ["planned", "pending"]),
    ),
    contentMarkdown: "## 检查项\n采购奖品或耗材前，确认型号、数量、用途和预算条目一致；存在替代方案或数量变化时，先处理预算变更。",
    suggestedActions: [action("show_checklist", "核对采购清单与预算条目")],
    basisNote: basis.budget,
  }),
  guideline("budgetException", {
    title: "预算变更、超支或当年规则不明确处理",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: any(
      fact("activity.budget_change_needed", "eq", true),
      fact("activity.budget_status", "eq", "over_budget"),
    ),
    contentMarkdown: "## 处理顺序\n补充用途和变化说明，核对当年额度、可报范围和审批要求。参考额度不得被写成长期不变的规则。",
    suggestedActions: [action("request_information", "确认预算变更、超支风险与当年财务要求")],
    basisNote: basis.budget,
  }),

  guideline("venueWorkflow", {
    title: "场地申请与使用确认",
    kind: "workflow",
    isMandatory: true,
    appliesWhen: all(fact("activity.needs_venue", "eq", true)),
    contentMarkdown: "## 目标\n确认场地需求、规模、申请路径、使用条件和当期时限，不把未经证实的提前天数写成硬规则。",
    suggestedActions: [action("show_checklist", "检查场地申请与使用确认链路")],
    basisNote: basis.venue,
  }),
  guideline("venueNeeds", {
    title: "确认场地需求、时段与使用规模",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(fact("activity.needs_venue", "eq", true)),
    contentMarkdown: "## 检查项\n确认场地类型、使用日期和时段、预计人数、球台或区域规模，以及活动是否需要设备支持。",
    suggestedActions: [action("request_information", "补充场地类型、时段、人数和占用规模")],
    basisNote: basis.venue,
  }),
  guideline("venueApplication", {
    title: "体育场馆申请",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(
      fact("activity.needs_venue", "eq", true),
      fact("activity.venue_status", "not_in", ["submitted", "approved"]),
    ),
    contentMarkdown: "## 检查项\n需要体育场馆时，向管指委提出申请并按当期流程完成审批；记录申请状态，避免把意向场地当作已落实场地。",
    suggestedActions: [action("create_task", "提交体育场馆申请并记录状态")],
    basisNote: basis.venue,
  }),
  guideline("largeVenueRationale", {
    title: "全馆或大规模占馆合理性说明",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(
      fact("activity.needs_venue", "eq", true),
      fact("activity.venue_scale", "eq", "large"),
    ),
    contentMarkdown: "## 检查项\n说明赛事参与人数、场馆使用时段、占用范围与必要性，使大规模使用场地的理由可被核对。",
    suggestedActions: [action("draft_document", "起草大规模占馆说明")],
    basisNote: basis.venue,
  }),
  guideline("multiPurposeVenue", {
    title: "多功能场地报备与设备可用性确认",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(fact("activity.venue_type", "eq", "multi_purpose")),
    contentMarkdown: "## 检查项\n会议、复盘、观影等多功能场地使用前，向指导老师报备并确认场地、设备和时段可用。",
    suggestedActions: [action("request_information", "确认多功能场地报备要求和设备可用性")],
    basisNote: basis.venue,
  }),
  guideline("venuePolicyConfirmation", {
    title: "场地时限或流程不明确时确认当期要求",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(
      fact("activity.needs_venue", "eq", true),
      fact("activity.venue_policy_confirmed", "not_in", [true]),
    ),
    contentMarkdown: "## 处理原则\n手册未给出常规体育场馆统一提前天数。时限或流程不明确时，应确认当期要求，而不是自行硬编码期限。",
    suggestedActions: [action("request_information", "确认当前场地申请时限和审批路径")],
    basisNote: basis.venue,
  }),

  guideline("largeEventWorkflow", {
    title: "大型赛事四阶段筹备",
    kind: "workflow",
    isMandatory: false,
    appliesWhen: all(fact("activity.type", "eq", "large_tournament")),
    contentMarkdown: "## 四个阶段\n行政合规与通知、核心物资保障、现场执行与秩序维护、收尾与资产沉淀。\n\n## 使用方式\n它保留全局视野；共享的审批、预算和场地规则通过关系复用，不重复写入本流程。",
    suggestedActions: [action("show_checklist", "按四阶段检查大型赛事筹备缺口")],
    basisNote: basis.largeEvent,
  }),
  guideline("largeEventAdministration", {
    title: "大型赛事：行政合规与通知",
    kind: "workflow",
    isMandatory: true,
    appliesWhen: all(
      fact("activity.type", "eq", "large_tournament"),
      fact("activity.phase", "in", ["planning", "preparation"]),
    ),
    contentMarkdown: "## 范围\n二课申请、策划与预算材料、场地审定、通知与报名安排。具体审批与场地知识由通用流程提供。",
    suggestedActions: [action("show_checklist", "检查大型赛事行政合规与通知准备")],
    basisNote: basis.largeEvent,
  }),
  guideline("largeEventMaterials", {
    title: "大型赛事：核心物资准备检查",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(
      fact("activity.type", "eq", "large_tournament"),
      fact("activity.phase", "in", ["planning", "preparation"]),
    ),
    contentMarkdown: "## 检查项\n比赛用球、奖杯奖牌、奖状、奖品、横幅、号码布和签到物资；同时确认必要损耗与制作周期。",
    suggestedActions: [action("show_checklist", "核对大型赛事核心物资与制作周期")],
    basisNote: basis.largeEvent,
  }),
  guideline("largeEventAssets", {
    title: "大型赛事：核心物资保障",
    kind: "workflow",
    isMandatory: true,
    appliesWhen: all(
      fact("activity.type", "eq", "large_tournament"),
      fact("activity.phase", "eq", "preparation"),
    ),
    contentMarkdown: "## 目标\n将已确认的物资需求转为可领取、可清点、可追溯的保障安排，并与通用资产台账衔接。",
    suggestedActions: [action("create_task", "明确大型赛事物资准备和领取责任人")],
    basisNote: basis.largeEvent,
  }),
  guideline("largeEventOnSite", {
    title: "大型赛事：现场执行与秩序维护",
    kind: "workflow",
    isMandatory: true,
    appliesWhen: all(
      fact("activity.type", "eq", "large_tournament"),
      fact("activity.phase", "eq", "active"),
    ),
    contentMarkdown: "## 范围\n前台签到/签领、竞赛区准备、赛程弹性调度与迟到、弃权等现场异常处理。具体裁决应以当届赛事规则为准。",
    suggestedActions: [action("show_checklist", "检查现场签到、物资和赛程准备")],
    basisNote: basis.largeEvent,
  }),
  guideline("largeEventRegistration", {
    title: "大型赛事：签到与物资签领记录",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(
      fact("activity.type", "eq", "large_tournament"),
      fact("activity.phase", "eq", "active"),
    ),
    contentMarkdown: "## 检查项\n确认前台签到方式、奖品或耗材签领记录、竞赛区物资交接责任人。记录应能服务后续物资数量核对。",
    suggestedActions: [action("show_checklist", "准备签到和物资签领记录")],
    basisNote: basis.largeEvent,
  }),
  guideline("largeEventScheduleException", {
    title: "大型赛事：赛程、迟到与弃权异常处理",
    kind: "checklist",
    isMandatory: false,
    appliesWhen: all(
      fact("activity.type", "eq", "large_tournament"),
      fact("activity.on_site_issue", "eq", true),
    ),
    contentMarkdown: "## 处理原则\n记录现场异常、依据当届赛事规则处理迟到或弃权，并保留赛程调整理由。未在手册明确的裁决细则不应由系统自行发明。",
    suggestedActions: [action("request_information", "确认现场异常、适用赛事规则和处理决定")],
    basisNote: basis.largeEvent,
  }),
  guideline("largeEventCloseout", {
    title: "大型赛事：收尾与资产沉淀",
    kind: "workflow",
    isMandatory: true,
    appliesWhen: all(
      fact("activity.type", "eq", "large_tournament"),
      fact("activity.phase", "in", ["after_event", "closing", "reimbursement"]),
    ),
    contentMarkdown: "## 范围\n新闻稿和照片、二课结项、报销材料、反馈收集、复盘与经验草稿。该阶段衔接通用结项和复盘流程。",
    suggestedActions: [action("show_checklist", "检查大型赛事收尾和经验沉淀事项")],
    basisNote: basis.largeEvent,
  }),

  guideline("closureWorkflow", {
    title: "活动结项、报销与复盘衔接",
    kind: "workflow",
    isMandatory: true,
    appliesWhen: all(fact("activity.phase", "in", ["after_event", "closing", "reimbursement"])),
    contentMarkdown: "## 目标\n按新闻与二课结项、票据核对、物资闭环、报销例外和复盘沉淀处理活动收尾；不同模块各自保留完成标准。",
    suggestedActions: [action("show_checklist", "检查活动结项、报销和复盘衔接")],
    basisNote: basis.closure,
  }),
  guideline("fundedActivityClosure", {
    title: "经费活动的新闻稿、审核发布与二课结项",
    kind: "workflow",
    isMandatory: true,
    appliesWhen: all(
      fact("activity.requires_budget", "eq", true),
      fact("activity.phase", "in", ["after_event", "closing", "reimbursement"]),
      fact("activity.closure_status", "ne", "completed"),
    ),
    contentMarkdown: "## 目标\n将新闻稿、审核发布、照片材料和二课结项组成经费活动的行政闭环，再进入报销核对。",
    suggestedActions: [action("show_checklist", "检查经费活动新闻稿和二课结项材料")],
    basisNote: basis.closure,
  }),
  guideline("fundedNewsGate", {
    title: "经费活动结项前确认新闻稿要求",
    kind: "rule",
    isMandatory: true,
    appliesWhen: all(
      fact("activity.requires_budget", "eq", true),
      fact("activity.news_status", "not_in", ["published"]),
      fact("activity.phase", "in", ["after_event", "closing"]),
    ),
    contentMarkdown: "## 规则\n申请经费的活动，新闻稿是结项和报销链条的一部分。具体格式、审核人与发布要求以当年校内规定为准。",
    suggestedActions: [action("draft_document", "起草活动新闻稿并准备照片材料")],
    basisNote: basis.closure,
  }),
  guideline("newsReviewRelease", {
    title: "新闻稿校对、审核与发布确认",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(
      fact("activity.requires_budget", "eq", true),
      fact("activity.news_status", "in", ["draft", "reviewing"]),
    ),
    contentMarkdown: "## 检查项\n按当期内部流程完成校对、指导老师审核和发布；记录当前环节，不能把待审核稿件写成已发布。",
    suggestedActions: [action("create_task", "完成新闻稿校对、审核和发布确认")],
    basisNote: basis.closure,
  }),
  guideline("secondClassClosure", {
    title: "上传照片并完成二课结项",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(
      fact("activity.requires_budget", "eq", true),
      fact("activity.second_class_closure_status", "not_in", ["completed"]),
      fact("activity.phase", "in", ["after_event", "closing"]),
    ),
    contentMarkdown: "## 检查项\n上传新闻稿和照片，完成二课结项并记录结项状态。结项动作完成后，才进入后续报销材料核对。",
    suggestedActions: [action("create_task", "上传结项材料并记录二课结项状态")],
    basisNote: basis.closure,
  }),
  guideline("reimbursementBudgetGate", {
    title: "报销前确认预算与结项前置条件",
    kind: "rule",
    isMandatory: true,
    appliesWhen: all(fact("activity.phase", "in", ["closing", "reimbursement"])),
    contentMarkdown: "## 规则\n报销前应有对应活动预算，且必要结项材料已完成；报销金额原则上不超过审批预算。",
    suggestedActions: [action("show_checklist", "核对预算、结项状态和报销前置条件")],
    basisNote: basis.closure,
  }),
  guideline("reimbursementClosure", {
    title: "票据、支付记录与购买明细对应检查",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(fact("activity.phase", "in", ["closing", "reimbursement"])),
    contentMarkdown: "## 检查项\n发票、支付记录、购买明细和签领表应能够一一对应。缺失信息要显式记录，不以口头说明替代材料。",
    suggestedActions: [action("show_checklist", "逐项核对票据、支付记录、购买明细和签领表")],
    basisNote: basis.closure,
  }),
  guideline("assetQuantityBalance", {
    title: "活动物资数量必须形成闭环",
    kind: "rule",
    isMandatory: true,
    appliesWhen: all(fact("activity.phase", "in", ["closing", "reimbursement"])),
    contentMarkdown: "## 规则\n实物奖品或耗材应满足：采购数 = 已签领数 + 库存余数。无法平衡时，应进入异常说明而不是直接报销。",
    suggestedActions: [action("request_information", "补充采购、签领和库存数量")],
    basisNote: basis.closure,
  }),
  guideline("remainingAssetInventory", {
    title: "剩余奖品与耗材入库登记",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(
      fact("activity.phase", "in", ["closing", "reimbursement"]),
      fact("activity.remaining_assets", "eq", true),
    ),
    contentMarkdown: "## 检查项\n有剩余奖品或耗材时，单独登记名称、数量、位置和持有人，使其进入后续资产盘点。",
    suggestedActions: [action("create_task", "登记活动剩余物资并更新库存")],
    basisNote: basis.closure,
  }),
  guideline("reimbursementException", {
    title: "超支、跨期或单据缺失的报销例外处理",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(fact("activity.reimbursement_issue", "eq", true)),
    contentMarkdown: "## 处理顺序\n明确异常类别，按当年要求补充说明和原始单据交接；不得把参考做法当作永久财务规则。",
    suggestedActions: [action("request_information", "确认报销异常类别、缺失材料和补充要求")],
    basisNote: basis.closure,
  }),

  guideline("organizationOperations", {
    title: "社团持续运营",
    kind: "workflow",
    isMandatory: false,
    appliesWhen: any(
      fact("handover.in_progress", "eq", true),
      fact("organization.asset_inventory_due", "eq", true),
      fact("member.stage", "in", ["new_officer", "apprentice"]),
    ),
    contentMarkdown: "## 范围\n资产与钥匙、换届交接、干事培养三类持续运营工作。它们不依附于单次活动，但会为活动执行提供基础保障。",
    suggestedActions: [action("show_checklist", "查看当前持续运营事项")],
    basisNote: "整理自《乒协生存手册》第 18、24–25、29–30 页。",
  }),
  guideline("assetAndKeyManagement", {
    title: "核心物资、钥匙与盘点管理",
    kind: "workflow",
    isMandatory: true,
    appliesWhen: any(
      fact("activity.needs_core_assets", "eq", true),
      fact("handover.in_progress", "eq", true),
      fact("organization.asset_inventory_due", "eq", true),
    ),
    contentMarkdown: "## 目标\n让核心物资和钥匙的位置、数量、持有人、借用和异常处理可盘点、可交接。",
    suggestedActions: [action("show_checklist", "检查资产、钥匙和盘点事项")],
    basisNote: basis.assets,
  }),
  guideline("assetLedger", {
    title: "更新核心物资台账",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: any(
      fact("activity.needs_core_assets", "eq", true),
      fact("organization.asset_inventory_due", "eq", true),
    ),
    contentMarkdown: "## 检查项\n记录核心物资的位置、数量和实际持有人；高价值器材、耗材和奖品应可盘点。",
    suggestedActions: [action("show_checklist", "核对并更新核心物资台账")],
    basisNote: basis.assets,
  }),
  guideline("assetBorrowReturn", {
    title: "活动物资借用与归还核对",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(fact("activity.needs_core_assets", "eq", true)),
    contentMarkdown: "## 检查项\n明确借用物资、领取人、归还时间和归还后数量；活动结束后将余量回写至库存。",
    suggestedActions: [action("create_task", "登记活动物资借用与归还情况")],
    basisNote: basis.assets,
  }),
  guideline("keyManagement", {
    title: "钥匙持有人、备用机制与借用登记",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: any(
      fact("activity.needs_core_assets", "eq", true),
      fact("handover.in_progress", "eq", true),
    ),
    contentMarkdown: "## 检查项\n确认钥匙当前持有人、备用机制和借用登记。具体个人姓名、密码等受控信息不写入指导层。",
    suggestedActions: [action("request_information", "确认钥匙持有人、备用安排和借用记录")],
    basisNote: basis.assets,
  }),
  guideline("semesterInventory", {
    title: "学期末资产盘点",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(fact("organization.asset_inventory_due", "eq", true)),
    contentMarkdown: "## 检查项\n盘点资产数量、位置、状态和闲置情况；将需要维修、处置或继续保留的项目标记出来。",
    suggestedActions: [action("create_task", "完成学期末资产盘点")],
    basisNote: basis.assets,
  }),
  guideline("assetIssue", {
    title: "资产损坏、遗失或长期闲置处理",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(fact("organization.asset_issue", "eq", true)),
    contentMarkdown: "## 处理原则\n记录问题、影响和现状，按当期规则确认维修、处置或补充方案，避免无效资产长期积压。",
    suggestedActions: [action("request_information", "确认资产异常、责任人和当期处理要求")],
    basisNote: basis.assets,
  }),

  guideline("handoverChecklist", {
    title: "换届交接流程",
    kind: "workflow",
    isMandatory: true,
    appliesWhen: all(fact("handover.in_progress", "eq", true)),
    contentMarkdown: "## 目标\n按工作、线上权限、物资、关系和验收五类内容完成可核对交接。建议在春季学期结束前启动，具体日期由当届负责人确认。",
    suggestedActions: [action("show_checklist", "按五类内容生成换届交接清单")],
    basisNote: basis.handover,
  }),
  guideline("handoverWork", {
    title: "未结工作、二课与报销材料交接",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(fact("handover.in_progress", "eq", true)),
    contentMarkdown: "## 检查项\n交接未结二课、未完成报销、原始凭证、策划案、总结和关键决策记录，并明确遗留事项负责人。",
    suggestedActions: [action("show_checklist", "核对未结工作和原始材料")],
    basisNote: basis.handover,
  }),
  guideline("handoverAccounts", {
    title: "线上权限管理员转移检查",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(fact("handover.in_progress", "eq", true)),
    contentMarkdown: "## 检查项\n核对官方群、公众号、媒体账号、知识库等管理员权限是否转移。账号密码不写入指导卡，应通过受控方式交接。",
    suggestedActions: [action("show_checklist", "核对线上账号管理员权限交接")],
    basisNote: basis.handover,
  }),
  guideline("handoverAssets", {
    title: "高价值物资与场馆钥匙交接",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(fact("handover.in_progress", "eq", true)),
    contentMarkdown: "## 检查项\n核对发球机、耗材、高价值物资和全部场馆钥匙的数量、位置与去向，并与资产台账一致。",
    suggestedActions: [action("show_checklist", "核对物资和钥匙交接")],
    basisNote: basis.handover,
  }),
  guideline("handoverRelationships", {
    title: "关键校内关系介绍与交接",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(fact("handover.in_progress", "eq", true)),
    contentMarkdown: "## 检查项\n安排指导老师、场馆负责人等关键校内联系关系的平稳介绍；记录角色和沟通边界，不将私人联系方式固化为指导知识。",
    suggestedActions: [action("create_task", "安排关键校内联系人交接介绍")],
    basisNote: basis.handover,
  }),
  guideline("handoverAcceptance", {
    title: "交接验收与遗留事项登记",
    kind: "checklist",
    isMandatory: true,
    appliesWhen: all(fact("handover.in_progress", "eq", true)),
    contentMarkdown: "## 通过标准\n每类交接都有接收人、可核对材料和遗留事项；未完成项应登记，不以口头承诺替代验收。",
    suggestedActions: [action("create_task", "完成换届交接验收并登记遗留事项")],
    basisNote: basis.handover,
  }),

  guideline("newOfficerGrowth", {
    title: "新干事从见习到项目主理的培养路径",
    kind: "workflow",
    isMandatory: false,
    appliesWhen: all(fact("member.stage", "in", ["new_officer", "apprentice"])),
    contentMarkdown: "## 路径\n入门与工具熟悉、跟随完整活动见习、承担有边界工作、评估准备度、在明确责任范围内逐步主理。",
    suggestedActions: [action("show_checklist", "查看新干事当前培养阶段和下一步")],
    basisNote: basis.growth,
  }),
  guideline("officerOrientation", {
    title: "新干事入门：职责、价值观与工具熟悉",
    kind: "checklist",
    isMandatory: false,
    appliesWhen: all(fact("member.stage", "eq", "new_officer")),
    contentMarkdown: "## 检查项\n在首次例会说明服务同学的价值观、岗位职责与权限边界；完成二课系统、传承库等工具的基础入门。",
    suggestedActions: [action("create_task", "安排新干事职责说明和工具入门")],
    basisNote: basis.growth,
  }),
  guideline("officerApprenticeship", {
    title: "新干事见习与有边界任务安排",
    kind: "experience",
    isMandatory: false,
    appliesWhen: all(fact("member.stage", "in", ["new_officer", "apprentice"])),
    contentMarkdown: "## 建议做法\n跟随老骨干完成一次完整活动，并在清晰边界内承担签到、场务或物资等小范围工作；见习后形成反馈。",
    suggestedActions: [action("create_task", "为新干事安排一次有边界的见习任务")],
    basisNote: basis.growth,
  }),
  guideline("officerReadiness", {
    title: "评估干事可独立承担的工作范围",
    kind: "checklist",
    isMandatory: false,
    appliesWhen: all(fact("member.stage", "eq", "apprentice")),
    contentMarkdown: "## 检查项\n结合工具掌握情况、见习经历、反馈和项目风险，确认其可以独立负责的局部工作与仍需支持的部分。",
    suggestedActions: [action("request_information", "确认新干事见习经历、反馈和可承担范围")],
    basisNote: basis.growth,
  }),
  guideline("officerAuthorityBoundary", {
    title: "权限与责任必须在已确认边界内逐步授予",
    kind: "rule",
    isMandatory: true,
    appliesWhen: all(fact("member.stage", "in", ["new_officer", "apprentice"])),
    contentMarkdown: "## 规则\n培养路径不自动授予预算、审批或状态修改权限。权限与责任只能在负责人确认的项目边界内逐步扩大。",
    suggestedActions: [action("request_information", "确认当前项目边界、负责人和可授予权限")],
    basisNote: basis.growth,
  }),

  guideline("postmortemAndExperience", {
    title: "活动复盘与可交接经验沉淀",
    kind: "workflow",
    isMandatory: false,
    appliesWhen: all(
      fact("activity.phase", "in", ["after_event", "closing"]),
      fact("activity.review_status", "not_in", ["completed", "published"]),
    ),
    contentMarkdown: "## 目标\n收集事实与反馈，形成可审阅经验草稿；经人工补充上下文和审核后，才发布为可复用指导。",
    suggestedActions: [action("show_checklist", "按复盘与经验发布流程收集信息")],
    basisNote: basis.review,
  }),
  guideline("reviewFeedback", {
    title: "收集活动反馈与可量化数据",
    kind: "checklist",
    isMandatory: false,
    appliesWhen: all(fact("activity.phase", "in", ["after_event", "closing"])),
    contentMarkdown: "## 检查项\n收集参与者反馈、参与人数、预算使用和其他可量化数据；标注数据来源和仍待确认的部分。",
    suggestedActions: [action("request_information", "收集活动反馈、参与人数和预算使用数据")],
    basisNote: basis.review,
  }),
  guideline("reviewDecisionRecord", {
    title: "记录决策理由、踩坑与实际处理",
    kind: "checklist",
    isMandatory: false,
    appliesWhen: all(fact("activity.phase", "in", ["after_event", "closing"])),
    contentMarkdown: "## 检查项\n记录关键决策及权衡、行政事故或突发情况、实际处理办法和结果；不要把推测写成既成事实。",
    suggestedActions: [action("draft_document", "记录活动决策、踩坑和实际处理")],
    basisNote: basis.review,
  }),
  guideline("reviewDraft", {
    title: "区分事实、经验、风险与待确认问题形成草稿",
    kind: "checklist",
    isMandatory: false,
    appliesWhen: all(fact("activity.review_status", "in", ["not_started", "draft"])),
    contentMarkdown: "## 输出结构\n分别写明适用条件、实际做法、结果、下次建议，以及尚未确认的问题；这是一份待审经验草稿，不是最终规则。",
    suggestedActions: [action("draft_document", "生成区分事实与经验的复盘草稿")],
    basisNote: basis.review,
  }),
  guideline("reviewHumanApproval", {
    title: "未经人工确认的经验不得直接发布或覆盖既有知识",
    kind: "rule",
    isMandatory: true,
    appliesWhen: all(fact("activity.review_status", "in", ["draft", "reviewing"])),
    contentMarkdown: "## 规则\n模型总结或个人草稿需经人审核、补充上下文后才能发布为可复用经验；不得自动覆盖既有指导或活动状态。",
    suggestedActions: [action("create_task", "安排复盘草稿的人审与上下文补充")],
    basisNote: basis.review,
  }),
  guideline("reviewPublication", {
    title: "发布已审核的可交接经验",
    kind: "checklist",
    isMandatory: false,
    appliesWhen: all(fact("activity.review_status", "eq", "approved")),
    contentMarkdown: "## 通过标准\n经验已保留适用条件、证据边界和审核结论，可以被后续活动和换届交接复用。",
    suggestedActions: [action("create_task", "将已审核复盘整理为可交接经验")],
    basisNote: basis.review,
  }),
];

export const handbookGuidelineLinks: GuidelineLinkSeed[] = [
  link("activityLifecycle", "activityAdministrativeCompliance", "contains", "活动筹备阶段进入行政合规模块。"),
  link("activityLifecycle", "budgetWorkflow", "contains", "活动预算与采购作为筹备阶段的独立模块。"),
  link("activityLifecycle", "venueWorkflow", "contains", "需要场地的活动从生命周期进入场地确认模块。"),
  link("activityLifecycle", "largeEventWorkflow", "contains", "大型赛事在通用活动生命周期中加载专项筹备流程。"),
  link("activityLifecycle", "closureWorkflow", "contains", "活动后进入结项、报销与复盘衔接模块。"),
  link("activityLifecycle", "postmortemAndExperience", "contains", "复盘与经验沉淀是活动生命周期的收尾模块。"),

  link("activityAdministrativeCompliance", "approvalApplicability", "contains", "先判断活动是否适用二课审批。"),
  link("activityAdministrativeCompliance", "largeEventT7Submission", "contains", "大型赛事适用独立的 T-7 提交规则。"),
  link("activityAdministrativeCompliance", "regularActivityT3Submission", "contains", "常规活动适用独立的 T-3 申报规则。"),
  link("activityAdministrativeCompliance", "approvalMaterials", "contains", "二课申请材料完整性需要单独核对。"),
  link("activityAdministrativeCompliance", "approvalSubmission", "contains", "材料齐全后提交申请并留存凭证。"),
  link("activityAdministrativeCompliance", "approvalTracking", "contains", "提交后进入审核进度跟踪。"),
  link("activityAdministrativeCompliance", "approvalIssue", "contains", "审批受阻、退回或不明时进入异常处理。"),
  link("activityAdministrativeCompliance", "noApprovalNoActivity", "contains", "实际开展前需通过审批门禁检查。"),
  link("approvalApplicability", "largeEventT7Submission", "triggers", "判断为大型赛事时加载 T-7 提交规则。"),
  link("approvalApplicability", "regularActivityT3Submission", "triggers", "判断为常规活动时加载 T-3 申报规则。"),
  link("largeEventT7Submission", "approvalMaterials", "next", "时限规则提示后应先核对申报材料。"),
  link("regularActivityT3Submission", "approvalMaterials", "next", "常规活动申报也需要核对材料。"),
  link("approvalSubmission", "approvalMaterials", "requires", "提交申请以前需完成材料完整性检查。"),
  link("approvalSubmission", "approvalTracking", "next", "提交凭证形成后进入审核跟踪。"),
  link("approvalTracking", "approvalIssue", "exception", "状态不明、退回或受阻时进入异常处理。"),
  link("approvalIssue", "approvalSubmission", "next", "补正完成后重新提交申请并更新凭证。"),

  link("budgetWorkflow", "budgetBeforeActivity", "contains", "活动前预算是预算控制的硬门槛。"),
  link("budgetWorkflow", "expenseEligibility", "contains", "经费用途边界需要独立说明。"),
  link("budgetWorkflow", "budgetDraft", "contains", "预算明细由独立检查表形成。"),
  link("budgetWorkflow", "procurementBoundary", "contains", "采购前需核对预算边界。"),
  link("budgetWorkflow", "budgetException", "contains", "预算变更或超支进入异常处理。"),
  link("budgetDraft", "procurementBoundary", "next", "预算明细确认后再核对采购边界。"),
  link("procurementBoundary", "budgetException", "exception", "采购变化或超支风险进入预算异常处理。"),

  link("venueWorkflow", "venueNeeds", "contains", "场地申请从需求、时段和规模确认开始。"),
  link("venueWorkflow", "venueApplication", "contains", "体育场馆申请独立于场地需求确认。"),
  link("venueWorkflow", "largeVenueRationale", "contains", "全馆或大规模占馆需说明合理性。"),
  link("venueWorkflow", "multiPurposeVenue", "contains", "多功能场地需要独立报备与设备确认。"),
  link("venueWorkflow", "venuePolicyConfirmation", "contains", "时限不明时应确认当期流程。"),
  link("venueNeeds", "venueApplication", "next", "确认需求后提交相应场地申请。"),
  link("venueApplication", "largeVenueRationale", "triggers", "大规模场馆使用时补充合理性说明。"),
  link("venueApplication", "venuePolicyConfirmation", "exception", "流程或时限不明时进入当期要求确认。"),

  link("largeEventWorkflow", "largeEventAdministration", "contains", "第一阶段是行政合规与通知。"),
  link("largeEventWorkflow", "largeEventAssets", "contains", "第二阶段是核心物资保障。"),
  link("largeEventWorkflow", "largeEventOnSite", "contains", "第三阶段是现场执行与秩序维护。"),
  link("largeEventWorkflow", "largeEventCloseout", "contains", "第四阶段是收尾与资产沉淀。"),
  link("largeEventAdministration", "largeEventMaterials", "contains", "大型赛事行政阶段需要核对专项物资与制作周期。"),
  link("largeEventOnSite", "largeEventRegistration", "contains", "现场阶段包含签到与物资签领记录。"),
  link("largeEventOnSite", "largeEventScheduleException", "contains", "现场异常处理作为现场阶段的独立卡片。"),
  link("largeEventWorkflow", "activityAdministrativeCompliance", "requires", "大型赛事需要复用通用审批与放行流程。"),
  link("largeEventWorkflow", "budgetWorkflow", "requires", "涉及经费时需要复用通用预算流程。"),
  link("largeEventWorkflow", "venueWorkflow", "requires", "大型赛事需要复用通用场地申请流程。"),
  link("largeEventAdministration", "largeEventAssets", "next", "行政合规完成后进入物资保障。"),
  link("largeEventAssets", "largeEventOnSite", "next", "物资保障后进入现场执行准备。"),
  link("largeEventOnSite", "largeEventCloseout", "next", "现场结束后进入收尾与资产沉淀。"),
  link("largeEventOnSite", "largeEventScheduleException", "exception", "赛程、迟到或弃权等异常进入现场处理卡。"),
  link("largeEventCloseout", "closureWorkflow", "next", "大型赛事收尾进入通用结项与报销流程。"),

  link("closureWorkflow", "fundedActivityClosure", "contains", "经费活动需要额外处理新闻稿与二课结项。"),
  link("closureWorkflow", "reimbursementBudgetGate", "contains", "报销前置条件以独立规则检查。"),
  link("closureWorkflow", "reimbursementClosure", "contains", "票据与支付材料以独立检查表核对。"),
  link("closureWorkflow", "assetQuantityBalance", "contains", "活动物资数量闭环是独立规则。"),
  link("closureWorkflow", "remainingAssetInventory", "contains", "剩余物资需要入库登记。"),
  link("closureWorkflow", "reimbursementException", "contains", "超支、跨期或材料缺失进入异常处理。"),
  link("fundedActivityClosure", "fundedNewsGate", "contains", "新闻稿要求是经费活动行政闭环的门槛。"),
  link("fundedActivityClosure", "newsReviewRelease", "contains", "新闻稿审核发布由独立检查表确认。"),
  link("fundedActivityClosure", "secondClassClosure", "contains", "照片上传与二课结项单独核对。"),
  link("fundedNewsGate", "newsReviewRelease", "next", "确认新闻稿要求后进入审核发布。"),
  link("newsReviewRelease", "secondClassClosure", "next", "发布和照片材料准备后进入二课结项。"),
  link("secondClassClosure", "reimbursementClosure", "next", "结项材料完成后进入报销材料核对。"),
  link("reimbursementClosure", "reimbursementBudgetGate", "requires", "票据核对以前需满足预算和结项前置条件。"),
  link("assetQuantityBalance", "reimbursementException", "exception", "数量无法平衡时进入异常说明。"),
  link("reimbursementClosure", "reimbursementException", "exception", "单据缺失、超支或跨期时进入异常处理。"),
  link("closureWorkflow", "postmortemAndExperience", "next", "结项过程中或完成后应形成复盘与经验草稿。"),

  link("organizationOperations", "assetAndKeyManagement", "contains", "持续运营包含资产与钥匙管理。"),
  link("organizationOperations", "handoverChecklist", "contains", "持续运营包含换届交接。"),
  link("organizationOperations", "newOfficerGrowth", "contains", "持续运营包含新干事培养。"),
  link("assetAndKeyManagement", "assetLedger", "contains", "资产台账是物资管理基础。"),
  link("assetAndKeyManagement", "assetBorrowReturn", "contains", "活动借用与归还需要单独核对。"),
  link("assetAndKeyManagement", "keyManagement", "contains", "钥匙管理需要单独维护。"),
  link("assetAndKeyManagement", "semesterInventory", "contains", "学期末盘点是独立检查表。"),
  link("assetAndKeyManagement", "assetIssue", "contains", "损坏、遗失和闲置进入异常处理。"),
  link("assetBorrowReturn", "assetLedger", "requires", "借还记录应回写至资产台账。"),
  link("semesterInventory", "assetIssue", "exception", "盘点发现问题时进入资产异常处理。"),

  link("handoverChecklist", "handoverWork", "contains", "换届交接首先核对未结工作与材料。"),
  link("handoverChecklist", "handoverAccounts", "contains", "线上权限由独立检查表交接。"),
  link("handoverChecklist", "handoverAssets", "contains", "物资和钥匙由独立检查表交接。"),
  link("handoverChecklist", "handoverRelationships", "contains", "关键关系通过介绍与边界说明交接。"),
  link("handoverChecklist", "handoverAcceptance", "contains", "最终以验收和遗留登记确认交接。"),
  link("handoverChecklist", "assetAndKeyManagement", "requires", "交接前需核对资产与钥匙台账。"),
  link("handoverChecklist", "postmortemAndExperience", "requires", "已审核经验可降低换届信息断层。"),
  link("handoverWork", "handoverAccounts", "next", "未结工作梳理后依次完成权限、物资和关系交接。"),
  link("handoverAccounts", "handoverAssets", "next", "线上权限交接后继续核对物资与钥匙。"),
  link("handoverAssets", "handoverRelationships", "next", "物资交接后安排关键关系介绍。"),
  link("handoverRelationships", "handoverAcceptance", "next", "四类交接完成后进行验收和遗留登记。"),

  link("newOfficerGrowth", "officerOrientation", "contains", "培养路径从职责和工具入门开始。"),
  link("newOfficerGrowth", "officerApprenticeship", "contains", "入门后通过完整活动见习积累经验。"),
  link("newOfficerGrowth", "officerReadiness", "contains", "见习后评估可独立承担的工作范围。"),
  link("newOfficerGrowth", "officerAuthorityBoundary", "contains", "权限边界始终作为培养路径的硬规则。"),
  link("officerOrientation", "officerApprenticeship", "next", "完成职责和工具入门后进入见习。"),
  link("officerApprenticeship", "officerReadiness", "next", "见习反馈用于评估下一步承担范围。"),
  link("officerReadiness", "officerAuthorityBoundary", "requires", "范围评估不等于自动授予权限。"),

  link("postmortemAndExperience", "reviewFeedback", "contains", "复盘从反馈和数据收集开始。"),
  link("postmortemAndExperience", "reviewDecisionRecord", "contains", "决策理由和踩坑处理应单独记录。"),
  link("postmortemAndExperience", "reviewDraft", "contains", "事实、经验和待确认问题应先形成草稿。"),
  link("postmortemAndExperience", "reviewHumanApproval", "contains", "经验发布前必须完成人工确认。"),
  link("postmortemAndExperience", "reviewPublication", "contains", "已审核经验才进入可交接知识。"),
  link("reviewFeedback", "reviewDecisionRecord", "next", "收集数据后补充决策与异常记录。"),
  link("reviewDecisionRecord", "reviewDraft", "next", "记录完成后形成区分事实与经验的草稿。"),
  link("reviewDraft", "reviewHumanApproval", "next", "草稿需要人工审核和上下文补充。"),
  link("reviewHumanApproval", "reviewPublication", "next", "审核通过后才发布为可复用经验。"),
];
