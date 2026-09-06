import { z } from "zod";

import type {
  CommandDefinition,
  ViewCardState,
  ViewTransaction,
} from "@sydaris/plugin-sdk";
import { zodContractSchema } from "@sydaris/plugin-sdk";

const uuid = z.string().uuid();
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "必须是 YYYY-MM-DD");
const activityStatusSchema = z.enum([
  "PLANNING",
  "RUNNING",
  "WRAP_UP",
  "COMPLETED",
  "CANCELLED",
]);
const workStatusSchema = z.enum([
  "NOT_STARTED",
  "IN_PROGRESS",
  "BLOCKED",
  "COMPLETED",
  "CANCELLED",
]);
const prioritySchema = z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]);
const milestoneStatusSchema = z.enum([
  "UPCOMING",
  "AT_RISK",
  "ACHIEVED",
  "MISSED",
  "CANCELLED",
]);
const guideNodeTypeSchema = z.enum(["ACTION", "DECISION", "REFERENCE", "END"]);
const playbookStatusSchema = z.enum(["DRAFT", "READY", "ARCHIVED"]);
const dateRangeSchema = z.object({
  start: dateString,
  end: dateString.optional(),
}).refine((value) => !value.end || value.start <= value.end, {
  message: "活动结束日期不能早于开始日期",
});

const nullableText = (maxLength: number) => z.string().trim().max(maxLength).nullable().optional();
const optionalText = (maxLength: number) => z.string().trim().max(maxLength).optional();
const hasChange = <Shape extends Record<string, unknown>>(
  input: Shape,
  identityKeys: readonly (keyof Shape)[],
): boolean => Object.entries(input).some(
  ([key, value]) => !identityKeys.includes(key as keyof Shape) && value !== undefined,
);

const createActivitySchema = z.object({
  objectId: uuid.optional(),
  name: z.string().trim().min(1).max(200),
  description: optionalText(5_000),
  status: activityStatusSchema.default("PLANNING"),
  progress: optionalText(5_000),
  time: dateRangeSchema.optional(),
  format: optionalText(200),
  venue: optionalText(500),
  scale: optionalText(200),
  participantCount: z.number().int().min(0).optional(),
});

const updateActivitySchema = z.object({
  activityId: uuid,
  name: z.string().trim().min(1).max(200).optional(),
  description: nullableText(5_000),
  status: activityStatusSchema.optional(),
  progress: nullableText(5_000),
  time: dateRangeSchema.nullable().optional(),
  format: nullableText(200),
  venue: nullableText(500),
  scale: nullableText(200),
  participantCount: z.number().int().min(0).nullable().optional(),
}).refine((input) => hasChange(input, ["activityId"]), {
  message: "至少需要一个要更新的活动字段",
});

const addWorkPackageSchema = z.object({
  activityId: uuid,
  name: z.string().trim().min(1).max(200),
  description: optionalText(5_000),
  status: workStatusSchema.default("NOT_STARTED"),
  progress: optionalText(5_000),
  priority: prioritySchema.default("NORMAL"),
  deadline: dateString.optional(),
});

const updateWorkPackageSchema = z.object({
  activityId: uuid,
  workPackageId: uuid,
  name: z.string().trim().min(1).max(200).optional(),
  description: nullableText(5_000),
  status: workStatusSchema.optional(),
  progress: nullableText(5_000),
  priority: prioritySchema.optional(),
  deadline: dateString.nullable().optional(),
}).refine((input) => hasChange(input, ["activityId", "workPackageId"]), {
  message: "至少需要一个要更新的工作包字段",
});

const addTaskSchema = z.object({
  workPackageId: uuid,
  name: z.string().trim().min(1).max(200),
  description: optionalText(5_000),
  status: workStatusSchema.default("NOT_STARTED"),
  progress: optionalText(5_000),
  priority: prioritySchema.default("NORMAL"),
  deadline: dateString.optional(),
});

const updateTaskSchema = z.object({
  workPackageId: uuid,
  taskId: uuid,
  name: z.string().trim().min(1).max(200).optional(),
  description: nullableText(5_000),
  status: workStatusSchema.optional(),
  progress: nullableText(5_000),
  priority: prioritySchema.optional(),
  deadline: dateString.nullable().optional(),
}).refine((input) => hasChange(input, ["workPackageId", "taskId"]), {
  message: "至少需要一个要更新的任务字段",
});

const removeTaskSchema = z.object({
  workPackageId: uuid,
  taskId: uuid,
  reason: z.string().trim().min(1).max(1_000),
});

const assignOwnerSchema = z.object({
  targetCardId: uuid,
  objectId: uuid,
  role: optionalText(200),
  responsibility: optionalText(5_000),
});

const unassignOwnerSchema = z.object({
  targetCardId: uuid,
  assignmentCardId: uuid,
  reason: z.string().trim().min(1).max(1_000),
});

const addMilestoneSchema = z.object({
  activityId: uuid,
  workPackageId: uuid.optional(),
  name: z.string().trim().min(1).max(200),
  description: optionalText(5_000),
  status: milestoneStatusSchema.default("UPCOMING"),
  targetDate: dateString.optional(),
});

const updateMilestoneSchema = z.object({
  activityId: uuid,
  milestoneId: uuid,
  name: z.string().trim().min(1).max(200).optional(),
  description: nullableText(5_000),
  status: milestoneStatusSchema.optional(),
  targetDate: dateString.nullable().optional(),
}).refine((input) => hasChange(input, ["activityId", "milestoneId"]), {
  message: "至少需要一个要更新的里程碑字段",
});

const createPlaybookSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: optionalText(5_000),
  applicableScenario: optionalText(5_000),
  overview: optionalText(5_000),
  notes: optionalText(5_000),
  lanes: optionalText(500),
  status: playbookStatusSchema.default("DRAFT"),
});

const localKeySchema = z.string().trim()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/, "局部 key 必须以小写字母开头，只包含小写字母、数字、_ 或 -");

const playbookTaskSchema = z.object({
  key: localKeySchema,
  name: z.string().trim().min(1).max(200),
  description: optionalText(5_000),
  roleHint: optionalText(200),
  durationHint: optionalText(500),
  deliverable: z.string().trim().min(1).max(5_000),
  dependsOnTaskKeys: z.array(localKeySchema).max(20).default([]),
});

const playbookWorkPackageSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).max(5_000),
  tasks: z.array(playbookTaskSchema).min(1).max(20),
});

const playbookGraphNodeSchema = z.object({
  key: localKeySchema,
  name: z.string().trim().min(1).max(200),
  nodeType: guideNodeTypeSchema,
  lane: z.string().trim().min(1).max(200),
  row: z.number().int().min(0).optional(),
  guide: optionalText(5_000),
  applicableCondition: optionalText(5_000),
  requiredInformation: optionalText(5_000),
  expectedOutcome: optionalText(5_000),
  aiAssistance: optionalText(5_000),
  resources: optionalText(5_000),
  durationHint: optionalText(500),
  workPackage: playbookWorkPackageSchema.optional(),
});

const playbookGraphEdgeSchema = z.object({
  fromNodeKey: localKeySchema,
  toNodeKey: localKeySchema,
  branch: z.enum(["NEXT", "YES", "NO"]),
});

const createPlaybookGraphSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5_000),
  applicableScenario: z.string().trim().min(1).max(5_000),
  overview: z.string().trim().min(1).max(5_000),
  notes: optionalText(5_000),
  lanes: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  status: playbookStatusSchema.default("DRAFT"),
  startNodeKeys: z.array(localKeySchema).min(1).max(20),
  nodes: z.array(playbookGraphNodeSchema).min(2).max(60),
  edges: z.array(playbookGraphEdgeSchema).max(120),
}).superRefine((input, context) => {
  const addIssue = (path: Array<string | number>, message: string) => context.addIssue({
    code: z.ZodIssueCode.custom,
    path,
    message,
  });
  const unique = (values: readonly string[]) => new Set(values).size === values.length;

  if (!unique(input.lanes)) addIssue(["lanes"], "泳道名称不能重复");
  const nodeKeys = input.nodes.map(({ key }) => key);
  if (!unique(nodeKeys)) addIssue(["nodes"], "节点 key 不能重复");
  const nodeByKey = new Map(input.nodes.map((node) => [node.key, node]));
  const laneSet = new Set(input.lanes);
  const outgoing = new Map<string, z.infer<typeof playbookGraphEdgeSchema>[]>();
  const edgeKeys = new Set<string>();

  for (const [index, startNodeKey] of input.startNodeKeys.entries()) {
    if (!nodeByKey.has(startNodeKey)) {
      addIssue(["startNodeKeys", index], `起点 ${startNodeKey} 不存在`);
    }
  }
  if (!unique(input.startNodeKeys)) addIssue(["startNodeKeys"], "起点不能重复");

  for (const [index, node] of input.nodes.entries()) {
    if (!laneSet.has(node.lane)) {
      addIssue(["nodes", index, "lane"], `泳道 ${node.lane} 未在 lanes 中声明`);
    }
    if (node.nodeType === "ACTION") {
      if (!node.guide) addIssue(["nodes", index, "guide"], "ACTION 必须说明怎样执行");
      if (!node.expectedOutcome) {
        addIssue(["nodes", index, "expectedOutcome"], "ACTION 必须说明完成结果");
      }
      if (!node.workPackage) {
        addIssue(["nodes", index, "workPackage"], "ACTION 必须包含可套用的工作包与任务");
      }
    } else if (node.workPackage) {
      addIssue(["nodes", index, "workPackage"], "只有 ACTION 可以包含工作包定义");
    }

    const tasks = node.workPackage?.tasks ?? [];
    const taskKeys = tasks.map(({ key }) => key);
    if (!unique(taskKeys)) addIssue(["nodes", index, "workPackage", "tasks"], "同一工作包中的任务 key 不能重复");
    const taskKeySet = new Set(taskKeys);
    const taskDependencies = new Map(tasks.map((task) => [task.key, task.dependsOnTaskKeys]));
    for (const [taskIndex, task] of tasks.entries()) {
      if (!unique(task.dependsOnTaskKeys)) {
        addIssue(["nodes", index, "workPackage", "tasks", taskIndex, "dependsOnTaskKeys"], "任务依赖不能重复");
      }
      for (const dependency of task.dependsOnTaskKeys) {
        if (!taskKeySet.has(dependency)) {
          addIssue(["nodes", index, "workPackage", "tasks", taskIndex, "dependsOnTaskKeys"], `任务依赖 ${dependency} 不存在于当前工作包`);
        } else if (dependency === task.key) {
          addIssue(["nodes", index, "workPackage", "tasks", taskIndex, "dependsOnTaskKeys"], "任务不能依赖自身");
        }
      }
    }
    const taskVisiting = new Set<string>();
    const taskVisited = new Set<string>();
    const visitTask = (key: string): boolean => {
      if (taskVisiting.has(key)) return false;
      if (taskVisited.has(key)) return true;
      taskVisiting.add(key);
      for (const dependency of taskDependencies.get(key) ?? []) {
        if (!visitTask(dependency)) return false;
      }
      taskVisiting.delete(key);
      taskVisited.add(key);
      return true;
    };
    if (tasks.some(({ key }) => !visitTask(key))) {
      addIssue(["nodes", index, "workPackage", "tasks"], "任务依赖不能形成循环");
    }
  }

  for (const [index, edge] of input.edges.entries()) {
    if (!nodeByKey.has(edge.fromNodeKey)) {
      addIssue(["edges", index, "fromNodeKey"], `来源节点 ${edge.fromNodeKey} 不存在`);
    }
    if (!nodeByKey.has(edge.toNodeKey)) {
      addIssue(["edges", index, "toNodeKey"], `目标节点 ${edge.toNodeKey} 不存在`);
    }
    if (edge.fromNodeKey === edge.toNodeKey) {
      addIssue(["edges", index], "节点不能连接自身");
    }
    const edgeKey = `${edge.fromNodeKey}:${edge.branch}:${edge.toNodeKey}`;
    if (edgeKeys.has(edgeKey)) addIssue(["edges", index], "流程连接不能重复");
    edgeKeys.add(edgeKey);
    outgoing.set(edge.fromNodeKey, [...(outgoing.get(edge.fromNodeKey) ?? []), edge]);
  }

  for (const [index, node] of input.nodes.entries()) {
    const nodeEdges = outgoing.get(node.key) ?? [];
    const branches = nodeEdges.map(({ branch }) => branch);
    if (node.nodeType === "END" && nodeEdges.length) {
      addIssue(["nodes", index], "END 不能有后续节点");
    } else if (node.nodeType === "DECISION") {
      if (branches.filter((branch) => branch === "YES").length !== 1 ||
        branches.filter((branch) => branch === "NO").length !== 1 ||
        branches.some((branch) => branch === "NEXT")) {
        addIssue(["nodes", index], "DECISION 必须且只能各有一条 YES 和 NO 分支");
      }
    } else if (branches.some((branch) => branch !== "NEXT")) {
      addIssue(["nodes", index], "只有 DECISION 可以使用 YES/NO 分支");
    }
    if (node.nodeType !== "END" && nodeEdges.length === 0) {
      addIssue(["nodes", index], "非 END 节点必须有后续路径");
    }
  }

  const reachable = new Set<string>();
  const visitReachable = (key: string): void => {
    if (reachable.has(key)) return;
    reachable.add(key);
    for (const edge of outgoing.get(key) ?? []) visitReachable(edge.toNodeKey);
  };
  for (const start of input.startNodeKeys) if (nodeByKey.has(start)) visitReachable(start);
  for (const [index, node] of input.nodes.entries()) {
    if (!reachable.has(node.key)) addIssue(["nodes", index], "节点必须能从某个起点到达");
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visitNode = (key: string): boolean => {
    if (visiting.has(key)) return false;
    if (visited.has(key)) return true;
    visiting.add(key);
    for (const edge of outgoing.get(key) ?? []) {
      if (!visitNode(edge.toNodeKey)) return false;
    }
    visiting.delete(key);
    visited.add(key);
    return true;
  };
  if (nodeKeys.some((key) => !visitNode(key))) addIssue(["edges"], "流程连接不能形成循环");
  if (!input.nodes.some(({ nodeType }) => nodeType === "END")) {
    addIssue(["nodes"], "Playbook 至少需要一个 END");
  }
});

const playbookBlueprintTaskSchema = z.object({
  name: z.string().trim().min(1).max(200),
  deliverable: z.string().trim().min(1).max(1_000),
  afterTaskIndexes: z.array(z.number().int().min(0).max(19)).max(20).default([]),
});

const playbookBlueprintNodeSchema = z.object({
  key: localKeySchema,
  name: z.string().trim().min(1).max(200),
  nodeType: guideNodeTypeSchema,
  lane: z.string().trim().min(1).max(200),
  instruction: optionalText(1_000),
  doneWhen: optionalText(1_000),
  durationHint: optionalText(300),
  taskTemplates: z.array(playbookBlueprintTaskSchema).max(8).default([]),
});

const playbookBlueprintBaseSchema = z.object({
  name: z.string().trim().min(1).max(200),
  purpose: z.string().trim().min(1).max(2_000),
  appliesWhen: z.string().trim().min(1).max(2_000),
  summary: optionalText(2_000),
  notes: optionalText(2_000),
  lanes: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  status: playbookStatusSchema.default("DRAFT"),
  startNodeKeys: z.array(localKeySchema).min(1).max(20),
  nodes: z.array(playbookBlueprintNodeSchema).min(2).max(60),
  edges: z.array(playbookGraphEdgeSchema).max(120),
});

type PlaybookBlueprintInput = z.infer<typeof playbookBlueprintBaseSchema>;
type PlaybookGraphInput = z.infer<typeof createPlaybookGraphSchema>;

function expandPlaybookBlueprint(input: PlaybookBlueprintInput): PlaybookGraphInput {
  return {
    name: input.name,
    description: input.purpose,
    applicableScenario: input.appliesWhen,
    overview: input.summary ?? input.purpose,
    notes: input.notes,
    lanes: input.lanes,
    status: input.status,
    startNodeKeys: input.startNodeKeys,
    nodes: input.nodes.map((node) => ({
      key: node.key,
      name: node.name,
      nodeType: node.nodeType,
      lane: node.lane,
      guide: node.instruction,
      expectedOutcome: node.doneWhen,
      durationHint: node.durationHint,
      ...(node.nodeType === "ACTION"
        ? {
            workPackage: {
              name: node.name,
              description: node.instruction ?? node.doneWhen ?? node.name,
              tasks: node.taskTemplates.map((task, taskIndex) => ({
                key: `task_${taskIndex + 1}`,
                name: task.name,
                deliverable: task.deliverable,
                dependsOnTaskKeys: task.afterTaskIndexes.flatMap((dependencyIndex) =>
                  node.taskTemplates[dependencyIndex]
                    ? [`task_${dependencyIndex + 1}`]
                    : []
                ),
              })),
            },
          }
        : {}),
    })),
    edges: input.edges,
  };
}

const createPlaybookBlueprintSchema = playbookBlueprintBaseSchema.superRefine((input, context) => {
  input.nodes.forEach((node, nodeIndex) => {
    if (node.nodeType === "ACTION" && node.taskTemplates.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nodes", nodeIndex, "taskTemplates"],
        message: "ACTION 至少需要一个可套用任务",
      });
    }
    if (node.nodeType !== "ACTION" && node.taskTemplates.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nodes", nodeIndex, "taskTemplates"],
        message: "只有 ACTION 可以包含任务模板",
      });
    }
    node.taskTemplates.forEach((task, taskIndex) => {
      for (const dependencyIndex of task.afterTaskIndexes) {
        if (dependencyIndex >= node.taskTemplates.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["nodes", nodeIndex, "taskTemplates", taskIndex, "afterTaskIndexes"],
            message: `任务索引 ${dependencyIndex} 不存在`,
          });
        }
        if (dependencyIndex === taskIndex) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["nodes", nodeIndex, "taskTemplates", taskIndex, "afterTaskIndexes"],
            message: "任务不能依赖自身",
          });
        }
      }
    });
  });
  const expanded = createPlaybookGraphSchema.safeParse(expandPlaybookBlueprint(input));
  if (!expanded.success) {
    for (const issue of expanded.error.issues) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: issue.path,
        message: issue.message,
      });
    }
  }
});

const updatePlaybookSchema = z.object({
  playbookId: uuid,
  name: z.string().trim().min(1).max(200).optional(),
  description: nullableText(5_000),
  applicableScenario: nullableText(5_000),
  overview: nullableText(5_000),
  notes: nullableText(5_000),
  lanes: nullableText(500),
  status: playbookStatusSchema.optional(),
}).refine((input) => hasChange(input, ["playbookId"]), {
  message: "至少需要一个要更新的 Playbook 字段",
});

const addGuideNodeSchema = z.object({
  playbookId: uuid,
  name: z.string().trim().min(1).max(200),
  nodeType: guideNodeTypeSchema.default("ACTION"),
  lane: optionalText(200),
  row: z.number().int().min(0).optional(),
  guide: optionalText(5_000),
  applicableCondition: optionalText(5_000),
  requiredInformation: optionalText(5_000),
  expectedOutcome: optionalText(5_000),
  aiAssistance: optionalText(5_000),
  durationHint: optionalText(500),
  taskSuggestions: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
});

const updateGuideNodeSchema = z.object({
  playbookId: uuid,
  nodeId: uuid,
  name: z.string().trim().min(1).max(200).optional(),
  nodeType: guideNodeTypeSchema.optional(),
  lane: nullableText(200),
  row: z.number().int().min(0).nullable().optional(),
  guide: nullableText(5_000),
  applicableCondition: nullableText(5_000),
  requiredInformation: nullableText(5_000),
  expectedOutcome: nullableText(5_000),
  aiAssistance: nullableText(5_000),
  durationHint: nullableText(500),
}).refine((input) => hasChange(input, ["playbookId", "nodeId"]), {
  message: "至少需要一个要更新的流程节点字段",
});

const setGuideEdgeSchema = z.object({
  playbookId: uuid,
  fromNodeId: uuid,
  toNodeId: uuid,
  branch: z.enum(["NEXT", "YES", "NO"]),
  connected: z.boolean().default(true),
});

const setNestedPlaybookSchema = z.object({
  playbookId: uuid,
  nodeId: uuid,
  nestedPlaybookId: uuid.nullable(),
});

const applyPlaybookSchema = z.object({
  activityId: uuid,
  playbookId: uuid,
});

const setWorkPackageDependencySchema = z.object({
  activityId: uuid,
  workPackageId: uuid,
  dependsOnWorkPackageId: uuid,
  connected: z.boolean().default(true),
});

const setTaskDependencySchema = z.object({
  activityId: uuid,
  taskId: uuid,
  dependsOnTaskId: uuid,
  connected: z.boolean().default(true),
});

function compact(entries: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined && value !== null),
  );
}

function changedKeys(entries: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(entries)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
}

function requireType(card: ViewCardState | undefined, type: string): ViewCardState {
  if (!card || card.cardTypeKey !== type) throw new Error(`需要 ${type} Card`);
  return card;
}

function requireSlotMember(parent: ViewCardState, slotKey: string, child: ViewCardState): void {
  if (!(parent.slots[slotKey] ?? []).includes(child.id)) {
    throw new Error(`${child.cardTypeKey} 不属于当前 ${parent.cardTypeKey}.${slotKey}`);
  }
}

function appendUnique(values: readonly string[] | undefined, value: string): string[] {
  return values?.includes(value) ? [...values] : [...(values ?? []), value];
}

function withConnection(
  values: readonly string[] | undefined,
  value: string,
  connected: boolean,
): string[] {
  return connected
    ? appendUnique(values, value)
    : (values ?? []).filter((candidate) => candidate !== value);
}

async function requirePlaybookNode(
  transaction: ViewTransaction,
  playbookId: string,
  nodeId: string,
): Promise<{ playbook: ViewCardState; node: ViewCardState }> {
  const playbook = requireType(
    await transaction.getCard(playbookId),
    "ActivityPlaybookCard",
  );
  const node = requireType(await transaction.getCard(nodeId), "GuideNodeCard");
  requireSlotMember(playbook, "nodes", node);
  return { playbook, node };
}

async function activityRuntime(
  transaction: ViewTransaction,
  activityId: string,
): Promise<{
  activity: ViewCardState;
  workPackages: ViewCardState[];
  tasks: ViewCardState[];
  workPackageByTaskId: Map<string, ViewCardState>;
}> {
  const activity = requireType(await transaction.getCard(activityId), "ActivityCard");
  const workPackages = (await Promise.all(
    (activity.slots.work_packages ?? []).map((cardId) => transaction.getCard(cardId)),
  )).filter((card): card is ViewCardState => card?.cardTypeKey === "WorkPackageCard");
  const taskEntries = (await Promise.all(workPackages.map(async (workPackage) => {
    const tasks = (await Promise.all(
      (workPackage.slots.tasks ?? []).map((cardId) => transaction.getCard(cardId)),
    )).filter((card): card is ViewCardState => card?.cardTypeKey === "TaskCard");
    return tasks.map((task) => ({ task, workPackage }));
  }))).flat();
  return {
    activity,
    workPackages,
    tasks: taskEntries.map(({ task }) => task),
    workPackageByTaskId: new Map(
      taskEntries.map(({ task, workPackage }) => [task.id, workPackage]),
    ),
  };
}

async function applyChanges(
  transaction: ViewTransaction,
  cardId: string,
  changes: Readonly<Record<string, unknown>>,
): Promise<void> {
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    if (value === null) await transaction.clearDimension(cardId, key);
    else await transaction.setDimension(cardId, key, value);
  }
}

function activityChanges(input: z.infer<typeof updateActivitySchema>) {
  return {
    name: input.name,
    description: input.description,
    status: input.status,
    progress: input.progress,
    time: input.time,
    format: input.format,
    venue: input.venue,
    scale: input.scale,
    participant_count: input.participantCount,
  };
}

function workChanges(input: {
  name?: string;
  description?: string | null;
  status?: z.infer<typeof workStatusSchema>;
  progress?: string | null;
  priority?: z.infer<typeof prioritySchema>;
  deadline?: string | null;
}) {
  return {
    name: input.name,
    description: input.description,
    status: input.status,
    progress: input.progress,
    priority: input.priority,
    deadline: input.deadline,
  };
}

async function requireActivityWorkPackage(
  transaction: ViewTransaction,
  activityId: string,
  workPackageId: string,
): Promise<{ activity: ViewCardState; workPackage: ViewCardState }> {
  const activity = requireType(await transaction.getCard(activityId), "ActivityCard");
  const workPackage = requireType(
    await transaction.getCard(workPackageId),
    "WorkPackageCard",
  );
  requireSlotMember(activity, "work_packages", workPackage);
  return { activity, workPackage };
}

async function requireWorkPackageTask(
  transaction: ViewTransaction,
  workPackageId: string,
  taskId: string,
): Promise<{ workPackage: ViewCardState; task: ViewCardState }> {
  const workPackage = requireType(
    await transaction.getCard(workPackageId),
    "WorkPackageCard",
  );
  const task = requireType(await transaction.getCard(taskId), "TaskCard");
  requireSlotMember(workPackage, "tasks", task);
  return { workPackage, task };
}

const createActivity: CommandDefinition<z.infer<typeof createActivitySchema>> = {
  key: "activity.create_activity",
  version: "1",
  label: "创建本届活动工作台",
  allowedInitiators: ["human", "ai"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(createActivitySchema),
  inputReferences: [{
    path: ["objectId"],
    kind: "object",
    inferFromCanonicalNamePath: ["name"],
  }],
  proposalApprovalConflictPolicy: () => "revalidate_latest",
  async execute(context, input) {
    const cardId = await context.transaction.createCard({
      cardTypeKey: "ActivityCard",
      relatedObjectIds: input.objectId ? [input.objectId] : [],
      dimensions: compact({
        name: input.name,
        description: input.description,
        status: input.status,
        progress: input.progress,
        time: input.time,
        format: input.format,
        venue: input.venue,
        scale: input.scale,
        participant_count: input.participantCount,
      }),
    });
    return {
      summary: { cardId, objectId: input.objectId },
      events: [{ type: "activity.activity_created", version: "1", payload: { cardId } }],
    };
  },
};

const updateActivity: CommandDefinition<z.infer<typeof updateActivitySchema>> = {
  key: "activity.update_activity",
  version: "1",
  label: "更新活动概况与阶段",
  allowedInitiators: ["human", "ai"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(updateActivitySchema),
  inputReferences: [{ path: ["activityId"], kind: "card" }],
  async execute(context, input) {
    const activity = requireType(
      await context.transaction.getCard(input.activityId),
      "ActivityCard",
    );
    const changes = activityChanges(input);
    await applyChanges(context.transaction, activity.id, changes);
    return {
      summary: { cardId: activity.id, changedDimensions: changedKeys(changes) },
      events: [{
        type: "activity.activity_updated",
        version: "1",
        payload: { cardId: activity.id, changedDimensions: changedKeys(changes) },
      }],
    };
  },
};

const addWorkPackage: CommandDefinition<z.infer<typeof addWorkPackageSchema>> = {
  key: "activity.add_work_package",
  version: "1",
  label: "添加工作包",
  allowedInitiators: ["human", "ai"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(addWorkPackageSchema),
  inputReferences: [{ path: ["activityId"], kind: "card" }],
  proposalApprovalConflictPolicy: () => "revalidate_latest",
  async execute(context, input) {
    const activity = requireType(await context.transaction.getCard(input.activityId), "ActivityCard");
    const cardId = await context.transaction.createCard({
      cardTypeKey: "WorkPackageCard",
      dimensions: compact({
        name: input.name,
        description: input.description,
        status: input.status,
        progress: input.progress,
        priority: input.priority,
        deadline: input.deadline,
      }),
    });
    await context.transaction.setSlot(
      activity.id,
      "work_packages",
      [...(activity.slots.work_packages ?? []), cardId],
    );
    return {
      summary: { cardId, activityId: activity.id },
      events: [{
        type: "activity.work_package_added",
        version: "1",
        payload: { cardId, activityId: activity.id },
      }],
    };
  },
};

const updateWorkPackage: CommandDefinition<z.infer<typeof updateWorkPackageSchema>> = {
  key: "activity.update_work_package",
  version: "1",
  label: "更新工作包",
  allowedInitiators: ["human", "ai"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(updateWorkPackageSchema),
  inputReferences: [
    { path: ["activityId"], kind: "card" },
    { path: ["workPackageId"], kind: "card" },
  ],
  async execute(context, input) {
    const { workPackage } = await requireActivityWorkPackage(
      context.transaction,
      input.activityId,
      input.workPackageId,
    );
    const changes = workChanges(input);
    await applyChanges(context.transaction, workPackage.id, changes);
    return {
      summary: { cardId: workPackage.id, changedDimensions: changedKeys(changes) },
      events: [{
        type: "activity.work_package_updated",
        version: "1",
        payload: {
          cardId: workPackage.id,
          activityId: input.activityId,
          changedDimensions: changedKeys(changes),
        },
      }],
    };
  },
};

const addTask: CommandDefinition<z.infer<typeof addTaskSchema>> = {
  key: "activity.add_task",
  version: "1",
  label: "添加任务",
  allowedInitiators: ["human", "ai"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(addTaskSchema),
  inputReferences: [{ path: ["workPackageId"], kind: "card" }],
  proposalApprovalConflictPolicy: () => "revalidate_latest",
  async execute(context, input) {
    const workPackage = requireType(
      await context.transaction.getCard(input.workPackageId),
      "WorkPackageCard",
    );
    const cardId = await context.transaction.createCard({
      cardTypeKey: "TaskCard",
      dimensions: compact({
        name: input.name,
        description: input.description,
        status: input.status,
        progress: input.progress,
        priority: input.priority,
        deadline: input.deadline,
      }),
    });
    await context.transaction.setSlot(
      workPackage.id,
      "tasks",
      [...(workPackage.slots.tasks ?? []), cardId],
    );
    return {
      summary: { cardId, workPackageId: workPackage.id },
      events: [{
        type: "activity.task_added",
        version: "1",
        payload: { cardId, workPackageId: workPackage.id },
      }],
    };
  },
};

const updateTask: CommandDefinition<z.infer<typeof updateTaskSchema>> = {
  key: "activity.update_task",
  version: "1",
  label: "更新任务",
  allowedInitiators: ["human", "ai"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(updateTaskSchema),
  inputReferences: [
    { path: ["workPackageId"], kind: "card" },
    { path: ["taskId"], kind: "card" },
  ],
  async execute(context, input) {
    const { task } = await requireWorkPackageTask(
      context.transaction,
      input.workPackageId,
      input.taskId,
    );
    const changes = workChanges(input);
    await applyChanges(context.transaction, task.id, changes);
    return {
      summary: { cardId: task.id, changedDimensions: changedKeys(changes) },
      events: [{
        type: "activity.task_updated",
        version: "1",
        payload: {
          cardId: task.id,
          workPackageId: input.workPackageId,
          changedDimensions: changedKeys(changes),
        },
      }],
    };
  },
};

const removeTask: CommandDefinition<z.infer<typeof removeTaskSchema>> = {
  key: "activity.remove_task",
  version: "1",
  label: "移除不再适用的任务",
  allowedInitiators: ["human", "ai"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(removeTaskSchema),
  inputReferences: [
    { path: ["workPackageId"], kind: "card" },
    { path: ["taskId"], kind: "card" },
  ],
  async execute(context, input) {
    const { workPackage, task } = await requireWorkPackageTask(
      context.transaction,
      input.workPackageId,
      input.taskId,
    );

    const allTasks = await context.transaction.queryCards({ cardTypeKey: "TaskCard" });
    for (const candidate of allTasks) {
      const dependencies = candidate.slots.dependencies ?? [];
      if (dependencies.includes(task.id)) {
        await context.transaction.setSlot(
          candidate.id,
          "dependencies",
          dependencies.filter((cardId) => cardId !== task.id),
        );
      }
    }
    const assignmentIds = [...(task.slots.assignments ?? [])];
    await context.transaction.setSlot(
      workPackage.id,
      "tasks",
      (workPackage.slots.tasks ?? []).filter((cardId) => cardId !== task.id),
    );
    if (assignmentIds.length) {
      await context.transaction.setSlot(task.id, "assignments", []);
    }
    for (const assignmentId of assignmentIds) {
      await context.transaction.deleteCard(assignmentId);
    }
    await context.transaction.deleteCard(task.id);
    return {
      summary: { cardId: task.id, workPackageId: workPackage.id, reason: input.reason },
      events: [{
        type: "activity.task_removed",
        version: "1",
        payload: { cardId: task.id, workPackageId: workPackage.id, reason: input.reason },
      }],
    };
  },
};

const assignOwner: CommandDefinition<z.infer<typeof assignOwnerSchema>> = {
  key: "activity.assign_owner",
  version: "1",
  label: "为活动、工作包或任务分配负责人",
  allowedInitiators: ["human", "ai"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(assignOwnerSchema),
  inputReferences: [
    { path: ["targetCardId"], kind: "card" },
    { path: ["objectId"], kind: "object" },
  ],
  async execute(context, input) {
    const target = await context.transaction.getCard(input.targetCardId);
    if (!target || !["ActivityCard", "WorkPackageCard", "TaskCard", "PurchaseCard", "ReimbursementCard"].includes(target.cardTypeKey)) {
      throw new Error("当前 Card 不支持分配负责人");
    }
    const existingAssignments = await Promise.all(
      (target.slots.assignments ?? []).map((cardId) => context.transaction.getCard(cardId)),
    );
    if (existingAssignments.some((assignment) => assignment?.relatedObjectIds.includes(input.objectId))) {
      throw new Error("该人物已经承担这项工作");
    }
    const cardId = await context.transaction.createCard({
      cardTypeKey: "AssignmentCard",
      relatedObjectIds: [input.objectId],
      dimensions: compact({ role: input.role, responsibility: input.responsibility }),
    });
    await context.transaction.setSlot(
      target.id,
      "assignments",
      [...(target.slots.assignments ?? []), cardId],
    );
    return {
      summary: { cardId, targetCardId: target.id, objectId: input.objectId },
      events: [{
        type: "activity.owner_assigned",
        version: "1",
        payload: { cardId, targetCardId: target.id, objectId: input.objectId },
      }],
    };
  },
};

const unassignOwner: CommandDefinition<z.infer<typeof unassignOwnerSchema>> = {
  key: "activity.unassign_owner",
  version: "1",
  label: "移除工作分配",
  allowedInitiators: ["human", "ai"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(unassignOwnerSchema),
  inputReferences: [
    { path: ["targetCardId"], kind: "card" },
    { path: ["assignmentCardId"], kind: "card" },
  ],
  async execute(context, input) {
    const target = await context.transaction.getCard(input.targetCardId);
    if (!target || !(target.slots.assignments ?? []).includes(input.assignmentCardId)) {
      throw new Error("工作分配不属于当前目标 Card");
    }
    const assignment = requireType(
      await context.transaction.getCard(input.assignmentCardId),
      "AssignmentCard",
    );
    await context.transaction.setSlot(
      target.id,
      "assignments",
      (target.slots.assignments ?? []).filter((cardId) => cardId !== assignment.id),
    );
    await context.transaction.deleteCard(assignment.id);
    return {
      summary: { cardId: assignment.id, targetCardId: target.id, reason: input.reason },
      events: [{
        type: "activity.owner_unassigned",
        version: "1",
        payload: { cardId: assignment.id, targetCardId: target.id, reason: input.reason },
      }],
    };
  },
};

const addMilestone: CommandDefinition<z.infer<typeof addMilestoneSchema>> = {
  key: "activity.add_milestone",
  version: "1",
  label: "添加里程碑",
  allowedInitiators: ["human", "ai"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(addMilestoneSchema),
  inputReferences: [
    { path: ["activityId"], kind: "card" },
    { path: ["workPackageId"], kind: "card" },
  ],
  proposalApprovalConflictPolicy: () => "revalidate_latest",
  async execute(context, input) {
    const activity = requireType(await context.transaction.getCard(input.activityId), "ActivityCard");
    const parent = input.workPackageId
      ? (await requireActivityWorkPackage(context.transaction, activity.id, input.workPackageId)).workPackage
      : activity;
    const cardId = await context.transaction.createCard({
      cardTypeKey: "MilestoneCard",
      dimensions: compact({
        name: input.name,
        description: input.description,
        status: input.status,
        target_date: input.targetDate,
      }),
    });
    await context.transaction.setSlot(
      parent.id,
      "milestones",
      [...(parent.slots.milestones ?? []), cardId],
    );
    return {
      summary: { cardId, activityId: activity.id, parentCardId: parent.id },
      events: [{
        type: "activity.milestone_added",
        version: "1",
        payload: { cardId, activityId: activity.id, parentCardId: parent.id },
      }],
    };
  },
};

const updateMilestone: CommandDefinition<z.infer<typeof updateMilestoneSchema>> = {
  key: "activity.update_milestone",
  version: "1",
  label: "更新里程碑",
  allowedInitiators: ["human", "ai"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(updateMilestoneSchema),
  inputReferences: [
    { path: ["activityId"], kind: "card" },
    { path: ["milestoneId"], kind: "card" },
  ],
  async execute(context, input) {
    const activity = requireType(await context.transaction.getCard(input.activityId), "ActivityCard");
    const milestone = requireType(
      await context.transaction.getCard(input.milestoneId),
      "MilestoneCard",
    );
    const activityOwns = (activity.slots.milestones ?? []).includes(milestone.id);
    const workPackages = await Promise.all(
      (activity.slots.work_packages ?? []).map((cardId) => context.transaction.getCard(cardId)),
    );
    const workPackageOwns = workPackages.some((workPackage) =>
      workPackage?.slots.milestones?.includes(milestone.id)
    );
    if (!activityOwns && !workPackageOwns) throw new Error("里程碑不属于当前 Activity");
    const changes = {
      name: input.name,
      description: input.description,
      status: input.status,
      target_date: input.targetDate,
    };
    await applyChanges(context.transaction, milestone.id, changes);
    return {
      summary: { cardId: milestone.id, changedDimensions: changedKeys(changes) },
      events: [{
        type: "activity.milestone_updated",
        version: "1",
        payload: {
          cardId: milestone.id,
          activityId: activity.id,
          changedDimensions: changedKeys(changes),
        },
      }],
    };
  },
};

const createPlaybook: CommandDefinition<z.infer<typeof createPlaybookSchema>> = {
  key: "activity.create_playbook",
  version: "1",
  label: "创建活动组织方法",
  allowedInitiators: ["human", "ai"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(createPlaybookSchema),
  proposalApprovalConflictPolicy: () => "revalidate_latest",
  async execute(context, input) {
    const cardId = await context.transaction.createCard({
      cardTypeKey: "ActivityPlaybookCard",
      dimensions: compact({
        name: input.name,
        description: input.description,
        applicable_scenario: input.applicableScenario,
        overview: input.overview,
        notes: input.notes,
        lanes: input.lanes,
        status: input.status,
      }),
    });
    return {
      summary: { cardId },
      events: [{ type: "activity.playbook_created", version: "1", payload: { cardId } }],
    };
  },
};

async function createPlaybookGraphCards(
  transaction: ViewTransaction,
  input: PlaybookGraphInput,
) {
    const playbookId = await transaction.createCard({
      cardTypeKey: "ActivityPlaybookCard",
      dimensions: compact({
        name: input.name,
        description: input.description,
        applicable_scenario: input.applicableScenario,
        overview: input.overview,
        notes: input.notes,
        lanes: input.lanes.join("\n"),
        status: input.status,
      }),
    });

    const nodeIdByKey = new Map<string, string>();
    const laneRows = new Map<string, number>();
    let workPackageDefinitionCount = 0;
    let taskDefinitionCount = 0;

    for (const node of input.nodes) {
      const inferredRow = laneRows.get(node.lane) ?? 0;
      laneRows.set(node.lane, Math.max(inferredRow, node.row ?? inferredRow) + 1);
      const nodeId = await transaction.createCard({
        cardTypeKey: "GuideNodeCard",
        dimensions: compact({
          name: node.name,
          node_type: node.nodeType,
          lane: node.lane,
          row: node.row ?? inferredRow,
          guide: node.guide,
          applicable_condition: node.applicableCondition,
          required_information: node.requiredInformation,
          expected_outcome: node.expectedOutcome,
          ai_assistance: node.aiAssistance,
          resources: node.resources,
          duration_hint: node.durationHint,
        }),
      });
      nodeIdByKey.set(node.key, nodeId);

      if (node.nodeType !== "ACTION" || !node.workPackage) continue;
      const definitionId = await transaction.createCard({
        cardTypeKey: "WorkPackageDefinitionCard",
        dimensions: {
          name: node.workPackage.name ?? node.name,
          description: node.workPackage.description,
        },
      });
      workPackageDefinitionCount += 1;
      const taskIdByKey = new Map<string, string>();
      for (const task of node.workPackage.tasks) {
        const taskId = await transaction.createCard({
          cardTypeKey: "TaskDefinitionCard",
          dimensions: compact({
            name: task.name,
            description: task.description,
            role_hint: task.roleHint,
            duration_hint: task.durationHint,
            deliverable: task.deliverable,
          }),
        });
        taskIdByKey.set(task.key, taskId);
        taskDefinitionCount += 1;
      }
      for (const task of node.workPackage.tasks) {
        if (!task.dependsOnTaskKeys.length) continue;
        await transaction.setSlot(
          taskIdByKey.get(task.key)!,
          "dependencies",
          task.dependsOnTaskKeys.map((key) => taskIdByKey.get(key)!),
        );
      }
      await transaction.setSlot(
        definitionId,
        "tasks",
        node.workPackage.tasks.map(({ key }) => taskIdByKey.get(key)!),
      );
      await transaction.setSlot(nodeId, "definition", [definitionId]);
    }

    for (const node of input.nodes) {
      const nodeId = nodeIdByKey.get(node.key)!;
      const outgoing = input.edges.filter(({ fromNodeKey }) => fromNodeKey === node.key);
      const next = outgoing
        .filter(({ branch }) => branch === "NEXT")
        .map(({ toNodeKey }) => nodeIdByKey.get(toNodeKey)!);
      const yes = outgoing.find(({ branch }) => branch === "YES");
      const no = outgoing.find(({ branch }) => branch === "NO");
      if (next.length) await transaction.setSlot(nodeId, "next", next);
      if (yes) await transaction.setSlot(nodeId, "when_yes", [nodeIdByKey.get(yes.toNodeKey)!]);
      if (no) await transaction.setSlot(nodeId, "when_no", [nodeIdByKey.get(no.toNodeKey)!]);
    }

    await transaction.setSlot(
      playbookId,
      "nodes",
      input.nodes.map(({ key }) => nodeIdByKey.get(key)!),
    );
    await transaction.setSlot(
      playbookId,
      "start_nodes",
      input.startNodeKeys.map((key) => nodeIdByKey.get(key)!),
    );
    return {
      summary: {
        cardId: playbookId,
        createdNodes: input.nodes.length,
        createdWorkPackageDefinitions: workPackageDefinitionCount,
        createdTaskDefinitions: taskDefinitionCount,
      },
      events: [{
        type: "activity.playbook_graph_created",
        version: "1",
        payload: {
          cardId: playbookId,
          createdNodes: input.nodes.length,
          createdWorkPackageDefinitions: workPackageDefinitionCount,
          createdTaskDefinitions: taskDefinitionCount,
        },
      }],
    };
}

const createPlaybookFromBlueprint: CommandDefinition<z.infer<typeof createPlaybookBlueprintSchema>> = {
  key: "activity.create_playbook_from_blueprint",
  version: "1",
  label: "从紧凑蓝图创建活动组织方法",
  allowedInitiators: ["human", "ai"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(createPlaybookBlueprintSchema),
  proposalApprovalConflictPolicy: () => "revalidate_latest",
  async execute(context, input) {
    return createPlaybookGraphCards(
      context.transaction,
      createPlaybookGraphSchema.parse(expandPlaybookBlueprint(input)),
    );
  },
};

const createPlaybookGraph: CommandDefinition<z.infer<typeof createPlaybookGraphSchema>> = {
  key: "activity.create_playbook_graph",
  version: "1",
  label: "创建完整活动组织方法",
  allowedInitiators: ["human", "ai"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(createPlaybookGraphSchema),
  proposalApprovalConflictPolicy: () => "revalidate_latest",
  async execute(context, input) {
    return createPlaybookGraphCards(context.transaction, input);
  },
};

const updatePlaybook: CommandDefinition<z.infer<typeof updatePlaybookSchema>> = {
  key: "activity.update_playbook",
  version: "1",
  label: "更新活动组织方法",
  allowedInitiators: ["human", "ai"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(updatePlaybookSchema),
  inputReferences: [{ path: ["playbookId"], kind: "card" }],
  async execute(context, input) {
    const playbook = requireType(
      await context.transaction.getCard(input.playbookId),
      "ActivityPlaybookCard",
    );
    const changes = {
      name: input.name,
      description: input.description,
      applicable_scenario: input.applicableScenario,
      overview: input.overview,
      notes: input.notes,
      lanes: input.lanes,
      status: input.status,
    };
    await applyChanges(context.transaction, playbook.id, changes);
    return {
      summary: { cardId: playbook.id, changedDimensions: changedKeys(changes) },
      events: [{
        type: "activity.playbook_updated",
        version: "1",
        payload: { cardId: playbook.id, changedDimensions: changedKeys(changes) },
      }],
    };
  },
};

const addGuideNode: CommandDefinition<z.infer<typeof addGuideNodeSchema>> = {
  key: "activity.add_guide_node",
  version: "1",
  label: "向组织方法添加步骤",
  allowedInitiators: ["human", "ai"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(addGuideNodeSchema),
  inputReferences: [{ path: ["playbookId"], kind: "card" }],
  proposalApprovalConflictPolicy: () => "revalidate_latest",
  async execute(context, input) {
    const playbook = requireType(
      await context.transaction.getCard(input.playbookId),
      "ActivityPlaybookCard",
    );
    const nodeId = await context.transaction.createCard({
      cardTypeKey: "GuideNodeCard",
      dimensions: compact({
        name: input.name,
        node_type: input.nodeType,
        lane: input.lane,
        row: input.row,
        guide: input.guide,
        applicable_condition: input.applicableCondition,
        required_information: input.requiredInformation,
        expected_outcome: input.expectedOutcome,
        ai_assistance: input.aiAssistance,
        duration_hint: input.durationHint,
      }),
    });

    if (input.nodeType === "ACTION") {
      const definitionId = await context.transaction.createCard({
        cardTypeKey: "WorkPackageDefinitionCard",
        dimensions: compact({
          name: input.name,
          description: input.expectedOutcome ?? input.guide,
        }),
      });
      const taskDefinitionIds: string[] = [];
      for (const taskName of input.taskSuggestions) {
        taskDefinitionIds.push(await context.transaction.createCard({
          cardTypeKey: "TaskDefinitionCard",
          dimensions: { name: taskName },
        }));
      }
      if (taskDefinitionIds.length) {
        await context.transaction.setSlot(definitionId, "tasks", taskDefinitionIds);
      }
      await context.transaction.setSlot(nodeId, "definition", [definitionId]);
    }

    const nodes = appendUnique(playbook.slots.nodes, nodeId);
    await context.transaction.setSlot(playbook.id, "nodes", nodes);
    if (!(playbook.slots.nodes ?? []).length) {
      await context.transaction.setSlot(playbook.id, "start_nodes", [nodeId]);
    }
    return {
      summary: { cardId: nodeId, playbookId: playbook.id },
      events: [{
        type: "activity.guide_node_added",
        version: "1",
        payload: { cardId: nodeId, playbookId: playbook.id },
      }],
    };
  },
};

const updateGuideNode: CommandDefinition<z.infer<typeof updateGuideNodeSchema>> = {
  key: "activity.update_guide_node",
  version: "1",
  label: "更新组织方法步骤",
  allowedInitiators: ["human", "ai"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(updateGuideNodeSchema),
  inputReferences: [
    { path: ["playbookId"], kind: "card" },
    { path: ["nodeId"], kind: "card" },
  ],
  async execute(context, input) {
    const { node } = await requirePlaybookNode(
      context.transaction,
      input.playbookId,
      input.nodeId,
    );
    const changes = {
      name: input.name,
      node_type: input.nodeType,
      lane: input.lane,
      row: input.row,
      guide: input.guide,
      applicable_condition: input.applicableCondition,
      required_information: input.requiredInformation,
      expected_outcome: input.expectedOutcome,
      ai_assistance: input.aiAssistance,
      duration_hint: input.durationHint,
    };
    await applyChanges(context.transaction, node.id, changes);
    return {
      summary: { cardId: node.id, changedDimensions: changedKeys(changes) },
      events: [{
        type: "activity.guide_node_updated",
        version: "1",
        payload: {
          cardId: node.id,
          playbookId: input.playbookId,
          changedDimensions: changedKeys(changes),
        },
      }],
    };
  },
};

const setGuideEdge: CommandDefinition<z.infer<typeof setGuideEdgeSchema>> = {
  key: "activity.set_guide_edge",
  version: "1",
  label: "连接或断开组织步骤",
  allowedInitiators: ["human", "ai"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(setGuideEdgeSchema),
  inputReferences: [
    { path: ["playbookId"], kind: "card" },
    { path: ["fromNodeId"], kind: "card" },
    { path: ["toNodeId"], kind: "card" },
  ],
  async execute(context, input) {
    if (input.fromNodeId === input.toNodeId) throw new Error("流程步骤不能连接自身");
    const { node: from } = await requirePlaybookNode(
      context.transaction,
      input.playbookId,
      input.fromNodeId,
    );
    await requirePlaybookNode(context.transaction, input.playbookId, input.toNodeId);
    const slotKey = input.branch === "NEXT"
      ? "next"
      : input.branch === "YES" ? "when_yes" : "when_no";
    const targets = slotKey === "next"
      ? withConnection(from.slots[slotKey], input.toNodeId, input.connected)
      : input.connected
        ? [input.toNodeId]
        : (from.slots[slotKey] ?? []).filter((cardId) => cardId !== input.toNodeId);
    await context.transaction.setSlot(from.id, slotKey, targets);
    return {
      summary: { cardId: from.id, targetCardId: input.toNodeId, connected: input.connected },
      events: [{
        type: "activity.guide_edge_changed",
        version: "1",
        payload: {
          playbookId: input.playbookId,
          fromNodeId: from.id,
          toNodeId: input.toNodeId,
          branch: input.branch,
          connected: input.connected,
        },
      }],
    };
  },
};

const setNestedPlaybook: CommandDefinition<z.infer<typeof setNestedPlaybookSchema>> = {
  key: "activity.set_nested_playbook",
  version: "1",
  label: "设置步骤的嵌套方法",
  allowedInitiators: ["human", "ai"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(setNestedPlaybookSchema),
  inputReferences: [
    { path: ["playbookId"], kind: "card" },
    { path: ["nodeId"], kind: "card" },
    { path: ["nestedPlaybookId"], kind: "card" },
  ],
  async execute(context, input) {
    const { node } = await requirePlaybookNode(
      context.transaction,
      input.playbookId,
      input.nodeId,
    );
    if (input.nestedPlaybookId === input.playbookId) throw new Error("Playbook 不能嵌套自身");
    if (input.nestedPlaybookId) {
      requireType(
        await context.transaction.getCard(input.nestedPlaybookId),
        "ActivityPlaybookCard",
      );
    }
    await context.transaction.setSlot(
      node.id,
      "subplaybook",
      input.nestedPlaybookId ? [input.nestedPlaybookId] : [],
    );
    return {
      summary: { cardId: node.id, nestedPlaybookId: input.nestedPlaybookId },
      events: [{
        type: "activity.nested_playbook_changed",
        version: "1",
        payload: {
          playbookId: input.playbookId,
          nodeId: node.id,
          nestedPlaybookId: input.nestedPlaybookId,
        },
      }],
    };
  },
};

const applyPlaybook: CommandDefinition<z.infer<typeof applyPlaybookSchema>> = {
  key: "activity.apply_playbook",
  version: "1",
  label: "把组织方法套用到活动",
  allowedInitiators: ["human", "ai"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(applyPlaybookSchema),
  inputReferences: [
    { path: ["activityId"], kind: "card" },
    { path: ["playbookId"], kind: "card" },
  ],
  async execute(context, input) {
    const runtime = await activityRuntime(context.transaction, input.activityId);
    const playbook = requireType(
      await context.transaction.getCard(input.playbookId),
      "ActivityPlaybookCard",
    );
    if (playbook.dimensions.status !== "READY") {
      throw new Error("只有成熟度为 READY 的活动组织方法可以套用到真实 Activity");
    }
    const nodes = (await Promise.all(
      (playbook.slots.nodes ?? []).map((cardId) => context.transaction.getCard(cardId)),
    )).filter((card): card is ViewCardState => card?.cardTypeKey === "GuideNodeCard");

    const workPackageByNodeId = new Map<string, ViewCardState>();
    for (const workPackage of runtime.workPackages) {
      const sourceNodeId = workPackage.slots.source_node?.[0];
      if (sourceNodeId) workPackageByNodeId.set(sourceNodeId, workPackage);
    }
    const workPackageByDefinitionId = new Map<string, ViewCardState>();
    const taskByDefinitionId = new Map<string, ViewCardState>();
    const createdWorkPackageIds: string[] = [];
    const createdTaskIds: string[] = [];

    for (const node of nodes) {
      if (node.dimensions.node_type !== "ACTION" || workPackageByNodeId.has(node.id)) continue;
      const definitionId = node.slots.definition?.[0];
      const definition = definitionId
        ? await context.transaction.getCard(definitionId)
        : undefined;
      const workPackageId = await context.transaction.createCard({
        cardTypeKey: "WorkPackageCard",
        dimensions: compact({
          name: node.dimensions.name,
          description: node.dimensions.expected_outcome ?? node.dimensions.guide,
          status: "NOT_STARTED",
          priority: "NORMAL",
        }),
      });
      await context.transaction.setSlot(workPackageId, "source_node", [node.id]);
      if (definition?.cardTypeKey === "WorkPackageDefinitionCard") {
        await context.transaction.setSlot(workPackageId, "definition", [definition.id]);
      }
      const taskIds: string[] = [];
      if (definition?.cardTypeKey === "WorkPackageDefinitionCard") {
        for (const taskDefinitionId of definition.slots.tasks ?? []) {
          const taskDefinition = await context.transaction.getCard(taskDefinitionId);
          if (taskDefinition?.cardTypeKey !== "TaskDefinitionCard") continue;
          const taskId = await context.transaction.createCard({
            cardTypeKey: "TaskCard",
            dimensions: compact({
              name: taskDefinition.dimensions.name,
              description: taskDefinition.dimensions.description ?? taskDefinition.dimensions.deliverable,
              status: "NOT_STARTED",
              priority: "NORMAL",
            }),
          });
          await context.transaction.setSlot(taskId, "definition", [taskDefinition.id]);
          taskIds.push(taskId);
          createdTaskIds.push(taskId);
          taskByDefinitionId.set(taskDefinition.id, requireType(
            await context.transaction.getCard(taskId),
            "TaskCard",
          ));
        }
      }
      if (taskIds.length) await context.transaction.setSlot(workPackageId, "tasks", taskIds);
      const workPackage = requireType(
        await context.transaction.getCard(workPackageId),
        "WorkPackageCard",
      );
      workPackageByNodeId.set(node.id, workPackage);
      if (definition?.cardTypeKey === "WorkPackageDefinitionCard") {
        workPackageByDefinitionId.set(definition.id, workPackage);
      }
      createdWorkPackageIds.push(workPackageId);
    }

    for (const workPackage of runtime.workPackages) {
      const definitionId = workPackage.slots.definition?.[0];
      if (definitionId) workPackageByDefinitionId.set(definitionId, workPackage);
      for (const taskId of workPackage.slots.tasks ?? []) {
        const task = await context.transaction.getCard(taskId);
        const taskDefinitionId = task?.slots.definition?.[0];
        if (task && taskDefinitionId) taskByDefinitionId.set(taskDefinitionId, task);
      }
    }

    const predecessors = new Map<string, string[]>();
    for (const node of nodes) {
      for (const targetNodeId of [
        ...(node.slots.next ?? []),
        ...(node.slots.when_yes ?? []),
        ...(node.slots.when_no ?? []),
      ]) {
        predecessors.set(
          targetNodeId,
          appendUnique(predecessors.get(targetNodeId), node.id),
        );
      }
    }
    const previousActionNodeIds = (nodeId: string): string[] => {
      const found = new Set<string>();
      const visited = new Set<string>();
      const visit = (candidateId: string): void => {
        if (visited.has(candidateId)) return;
        visited.add(candidateId);
        if (workPackageByNodeId.has(candidateId)) {
          found.add(candidateId);
          return;
        }
        for (const previousId of predecessors.get(candidateId) ?? []) visit(previousId);
      };
      for (const previousId of predecessors.get(nodeId) ?? []) visit(previousId);
      return [...found];
    };

    for (const node of nodes) {
      const source = workPackageByNodeId.get(node.id);
      if (!source) continue;
      for (const previousNodeId of previousActionNodeIds(node.id)) {
        const dependency = workPackageByNodeId.get(previousNodeId);
        if (!dependency || dependency.id === source.id) continue;
        const latestSource = requireType(
          await context.transaction.getCard(source.id),
          "WorkPackageCard",
        );
        await context.transaction.setSlot(
          source.id,
          "dependencies",
          appendUnique(latestSource.slots.dependencies, dependency.id),
        );
      }
      const definitionId = source.slots.definition?.[0];
      const definition = definitionId
        ? await context.transaction.getCard(definitionId)
        : undefined;
      for (const dependencyDefinitionId of definition?.slots.dependencies ?? []) {
        const dependency = workPackageByDefinitionId.get(dependencyDefinitionId);
        if (dependency) {
          const latestSource = requireType(
            await context.transaction.getCard(source.id),
            "WorkPackageCard",
          );
          await context.transaction.setSlot(
            source.id,
            "dependencies",
            appendUnique(latestSource.slots.dependencies, dependency.id),
          );
        }
      }
    }

    for (const [definitionId, task] of taskByDefinitionId) {
      const definition = await context.transaction.getCard(definitionId);
      const dependencies = (definition?.slots.dependencies ?? [])
        .map((dependencyId) => taskByDefinitionId.get(dependencyId)?.id)
        .filter((cardId): cardId is string => Boolean(cardId));
      if (dependencies.length) {
        await context.transaction.setSlot(task.id, "dependencies", dependencies);
      }
    }

    await context.transaction.setSlot(
      runtime.activity.id,
      "work_packages",
      [...runtime.workPackages.map(({ id }) => id), ...createdWorkPackageIds],
    );
    await context.transaction.setSlot(runtime.activity.id, "adopted_playbook", [playbook.id]);
    return {
      summary: {
        cardId: runtime.activity.id,
        playbookId: playbook.id,
        createdWorkPackages: createdWorkPackageIds.length,
        createdTasks: createdTaskIds.length,
      },
      events: [{
        type: "activity.playbook_applied",
        version: "1",
        payload: {
          cardId: runtime.activity.id,
          playbookId: playbook.id,
          createdWorkPackages: createdWorkPackageIds.length,
          createdTasks: createdTaskIds.length,
        },
      }],
    };
  },
};

const setWorkPackageDependency: CommandDefinition<z.infer<typeof setWorkPackageDependencySchema>> = {
  key: "activity.set_work_package_dependency",
  version: "1",
  label: "设置工作包前置依赖",
  allowedInitiators: ["human", "ai"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(setWorkPackageDependencySchema),
  inputReferences: [
    { path: ["activityId"], kind: "card" },
    { path: ["workPackageId"], kind: "card" },
    { path: ["dependsOnWorkPackageId"], kind: "card" },
  ],
  async execute(context, input) {
    if (input.workPackageId === input.dependsOnWorkPackageId) {
      throw new Error("工作包不能依赖自身");
    }
    const runtime = await activityRuntime(context.transaction, input.activityId);
    const workPackage = runtime.workPackages.find(({ id }) => id === input.workPackageId);
    const dependency = runtime.workPackages.find(({ id }) => id === input.dependsOnWorkPackageId);
    if (!workPackage || !dependency) throw new Error("两个工作包必须属于同一 Activity");
    await context.transaction.setSlot(
      workPackage.id,
      "dependencies",
      withConnection(workPackage.slots.dependencies, dependency.id, input.connected),
    );
    return {
      summary: { cardId: workPackage.id, dependencyId: dependency.id, connected: input.connected },
      events: [{
        type: "activity.dependency_changed",
        version: "1",
        payload: {
          cardId: workPackage.id,
          dependencyId: dependency.id,
          dependencyType: "WORK_PACKAGE",
          connected: input.connected,
        },
      }],
    };
  },
};

const setTaskDependency: CommandDefinition<z.infer<typeof setTaskDependencySchema>> = {
  key: "activity.set_task_dependency",
  version: "1",
  label: "设置任务前置依赖",
  allowedInitiators: ["human", "ai"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(setTaskDependencySchema),
  inputReferences: [
    { path: ["activityId"], kind: "card" },
    { path: ["taskId"], kind: "card" },
    { path: ["dependsOnTaskId"], kind: "card" },
  ],
  async execute(context, input) {
    if (input.taskId === input.dependsOnTaskId) throw new Error("任务不能依赖自身");
    const runtime = await activityRuntime(context.transaction, input.activityId);
    const task = runtime.tasks.find(({ id }) => id === input.taskId);
    const dependency = runtime.tasks.find(({ id }) => id === input.dependsOnTaskId);
    if (!task || !dependency) throw new Error("两个任务必须属于同一 Activity");
    await context.transaction.setSlot(
      task.id,
      "dependencies",
      withConnection(task.slots.dependencies, dependency.id, input.connected),
    );
    return {
      summary: { cardId: task.id, dependencyId: dependency.id, connected: input.connected },
      events: [{
        type: "activity.dependency_changed",
        version: "1",
        payload: {
          cardId: task.id,
          dependencyId: dependency.id,
          dependencyType: "TASK",
          connected: input.connected,
        },
      }],
    };
  },
};

export const activityOperationsCommands: readonly CommandDefinition[] = [
  createActivity,
  updateActivity,
  addWorkPackage,
  updateWorkPackage,
  addTask,
  updateTask,
  removeTask,
  assignOwner,
  unassignOwner,
  addMilestone,
  updateMilestone,
  createPlaybook,
  createPlaybookFromBlueprint,
  createPlaybookGraph,
  updatePlaybook,
  addGuideNode,
  updateGuideNode,
  setGuideEdge,
  setNestedPlaybook,
  applyPlaybook,
  setWorkPackageDependency,
  setTaskDependency,
];
