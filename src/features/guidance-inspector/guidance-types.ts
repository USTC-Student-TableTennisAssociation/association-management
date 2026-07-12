export type GuidanceKind = "workflow" | "rule" | "checklist" | "experience";
export type GuidanceStatus = "draft" | "published";
export type GuidanceRelationType =
  | "contains"
  | "triggers"
  | "requires"
  | "next"
  | "exception";

export type GuidanceJsonPrimitive = string | number | boolean | null;
export type GuidanceJsonValue =
  | GuidanceJsonPrimitive
  | GuidanceJsonValue[]
  | { [key: string]: GuidanceJsonValue };

export type GuidanceConditionOperator =
  | "eq"
  | "ne"
  | "in"
  | "not_in"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "exists";

export type GuidanceFactCondition = {
  field: string;
  operator: GuidanceConditionOperator;
  value?: GuidanceJsonValue;
};

export type GuidanceConditionGroup = {
  all?: GuidanceCondition[];
  any?: GuidanceCondition[];
};

export type GuidanceCondition = GuidanceFactCondition | GuidanceConditionGroup;

export type GuidanceSuggestedAction = {
  type: "create_task" | "request_information" | "show_checklist" | "draft_document";
  title: string;
  due?: string;
  description?: string;
};

export type GuidanceGraphNodeInput = {
  id: string;
  title: string;
  kind: GuidanceKind;
  status: GuidanceStatus;
  isMandatory: boolean;
  contentMarkdown: string;
  appliesWhen: GuidanceCondition | null;
  suggestedActions: readonly GuidanceSuggestedAction[];
  basisNote: string | null;
};

export type GuidanceGraphLinkInput = {
  fromGuidelineId: string;
  toGuidelineId: string;
  relationType: GuidanceRelationType;
  note: string | null;
};

export type GuidanceGraphSource = {
  nodes: readonly GuidanceGraphNodeInput[];
  links: readonly GuidanceGraphLinkInput[];
};

export type GuidanceGraphEdge = GuidanceGraphLinkInput & {
  id: string;
  canonicalId: string;
  sourceIndex: number;
  isRenderable: boolean;
};

export type GuidanceGraphNode = GuidanceGraphNodeInput & {
  incomingEdgeIds: readonly string[];
  outgoingEdgeIds: readonly string[];
  directNeighborIds: readonly string[];
};

export type GuidanceGraph = {
  nodes: readonly GuidanceGraphNode[];
  edges: readonly GuidanceGraphEdge[];
  renderableEdges: readonly GuidanceGraphEdge[];
  nodeById: ReadonlyMap<string, GuidanceGraphNode>;
  edgeById: ReadonlyMap<string, GuidanceGraphEdge>;
};

export type GuidanceNeighborResult = {
  selectedNodeId: string;
  firstDegreeNodeIds: readonly string[];
  secondDegreeNodeIds: readonly string[];
  firstDegreeEdgeIds: readonly string[];
  depthByNodeId: ReadonlyMap<string, 0 | 1 | 2>;
};

export type GuidanceDiagnosticSeverity = "error" | "warning" | "info";
export type GuidanceDiagnosticCode =
  | "dangling-edge"
  | "self-loop"
  | "duplicate-edge"
  | "isolated-node"
  | "workflow-without-outgoing"
  | "missing-basis-note"
  | "missing-suggested-actions"
  | "mandatory-rule-without-condition"
  | "published-requires-draft"
  | "requires-cycle";

export type GuidanceDiagnostic = {
  id: string;
  code: GuidanceDiagnosticCode;
  severity: GuidanceDiagnosticSeverity;
  title: string;
  description: string;
  nodeIds: readonly string[];
  edgeIds: readonly string[];
};

export type GuidanceGraphAnalysis = {
  diagnostics: readonly GuidanceDiagnostic[];
  diagnosticsBySeverity: Readonly<Record<GuidanceDiagnosticSeverity, number>>;
  structureWarningCount: number;
  isolatedNodeIds: readonly string[];
};

export type InspectorSelection =
  | { type: "node"; id: string }
  | { type: "edge"; id: string }
  | { type: "diagnostic"; id: string }
  | null;

export type GuidancePosition = {
  x: number;
  y: number;
};

export const guidanceKindLabels: Record<GuidanceKind, string> = {
  workflow: "流程",
  rule: "规则",
  checklist: "检查表",
  experience: "经验",
};

export const guidanceStatusLabels: Record<GuidanceStatus, string> = {
  draft: "草稿",
  published: "已发布",
};

export const guidanceRelationLabels: Record<GuidanceRelationType, string> = {
  contains: "包含",
  triggers: "触发",
  requires: "前置",
  next: "后续",
  exception: "例外",
};

export const guidanceActionLabels: Record<GuidanceSuggestedAction["type"], string> = {
  create_task: "建议创建任务",
  request_information: "请求补充信息",
  show_checklist: "展示检查表",
  draft_document: "起草文档",
};
