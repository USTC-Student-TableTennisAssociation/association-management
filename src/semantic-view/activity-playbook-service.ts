import { Prisma, type PrismaClient } from "@/generated/prisma/client";

import { getDatabase } from "@/db";
import {
  GUIDE_NODE_DIMENSIONS,
  PLAYBOOK_DIMENSIONS,
} from "@/semantic-view/activity-operations-contract";
import {
  type ActivityPlaybookAction,
  type ActivityPlaybookCollection,
  type ActivityPlaybookEditorValues,
  type GuideNodeEditorValues,
  type GuideNodePaths,
  activityPlaybookActionSchema,
  buildActivityPlaybooks,
} from "@/semantic-view/activity-playbook";
import { cardTypeDefinition } from "@/semantic-view/card-types";
import {
  SemanticViewValidationError,
  assertSlotTarget,
  getSemanticView,
} from "@/semantic-view/service";
import { ACTIVITY_OPERATIONS_VIEW } from "@/semantic-view/types";

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

async function setDimensions(
  database: DatabaseClient,
  cardId: string,
  values: Record<string, string | number | null | undefined>,
) {
  for (const [name, value] of Object.entries(values)) {
    const contentMarkdown = value === null || value === undefined
      ? ""
      : String(value).trim();
    if (!contentMarkdown) {
      await database.semanticContentDimension.deleteMany({ where: { cardId, name } });
      continue;
    }
    await database.semanticContentDimension.upsert({
      where: { cardId_name: { cardId, name } },
      create: { cardId, name, contentMarkdown },
      update: { contentMarkdown },
    });
  }
}

async function createCard(
  database: DatabaseClient,
  cardTypeKey: "ActivityPlaybookCard" | "GuideNodeCard",
) {
  return database.semanticCard.create({
    data: {
      compilationId: null,
      sourceObjectId: null,
      viewKey: ACTIVITY_OPERATIONS_VIEW,
      cardTypeKey,
    },
  });
}

async function requireCard(
  database: DatabaseClient,
  cardId: string,
  cardTypeKey: "ActivityPlaybookCard" | "GuideNodeCard",
) {
  const card = await database.semanticCard.findUnique({ where: { id: cardId } });
  if (
    !card || card.viewKey !== ACTIVITY_OPERATIONS_VIEW ||
    card.cardTypeKey !== cardTypeKey
  ) {
    throw new SemanticViewValidationError(`${cardTypeKey} ${cardId} 不存在`);
  }
  return card;
}

function playbookDimensions(values: ActivityPlaybookEditorValues) {
  return {
    [PLAYBOOK_DIMENSIONS.name]: values.name,
    [PLAYBOOK_DIMENSIONS.description]: values.description,
    [PLAYBOOK_DIMENSIONS.applicableScenario]: values.applicableScenario,
    [PLAYBOOK_DIMENSIONS.overview]: values.overview,
    [PLAYBOOK_DIMENSIONS.notes]: values.notes,
    [PLAYBOOK_DIMENSIONS.lanes]: values.lanes.join("\n"),
  };
}

function nodeDimensions(values: GuideNodeEditorValues) {
  return {
    [GUIDE_NODE_DIMENSIONS.name]: values.name,
    [GUIDE_NODE_DIMENSIONS.nodeType]: values.nodeType,
    [GUIDE_NODE_DIMENSIONS.lane]: values.lane,
    [GUIDE_NODE_DIMENSIONS.row]: values.row,
    [GUIDE_NODE_DIMENSIONS.guide]: values.guide,
    [GUIDE_NODE_DIMENSIONS.applicableCondition]: values.applicableCondition,
    [GUIDE_NODE_DIMENSIONS.requiredInformation]: values.requiredInformation,
    [GUIDE_NODE_DIMENSIONS.expectedOutcome]: values.expectedOutcome,
    [GUIDE_NODE_DIMENSIONS.aiAssistance]: values.aiAssistance,
    [GUIDE_NODE_DIMENSIONS.resources]: values.resources,
  };
}

async function addBinding(
  database: DatabaseClient,
  source: { id: string; viewKey: string; cardTypeKey: string },
  slotKey: string,
  target: { id: string; viewKey: string; cardTypeKey: string },
) {
  const slot = cardTypeDefinition(source.viewKey, source.cardTypeKey)?.slots[slotKey];
  if (!slot) throw new SemanticViewValidationError(`${source.cardTypeKey} 没有 Slot ${slotKey}`);
  assertSlotTarget({
    sourceCard: { selector: source.id, viewKey: source.viewKey, cardTypeKey: source.cardTypeKey },
    targetCard: { selector: target.id, viewKey: target.viewKey, cardTypeKey: target.cardTypeKey },
    slot,
  });
  await database.semanticSlotBinding.create({
    data: { sourceCardId: source.id, slotKey, targetCardId: target.id },
  });
}

async function playbookNodeIds(database: DatabaseClient, playbookCardId: string) {
  const bindings = await database.semanticSlotBinding.findMany({
    where: { sourceCardId: playbookCardId, slotKey: "nodes" },
    select: { targetCardId: true },
  });
  return new Set(bindings.map((binding) => binding.targetCardId));
}

async function replacePaths(
  database: DatabaseClient,
  playbookCardId: string,
  node: { id: string; viewKey: string; cardTypeKey: string },
  paths: GuideNodePaths,
) {
  const allowedIds = await playbookNodeIds(database, playbookCardId);
  if (!allowedIds.has(node.id)) {
    throw new SemanticViewValidationError("只能编辑当前操作手册中的节点路径");
  }
  const targetIds = [
    ...paths.nextCardIds,
    ...(paths.whenYesCardId ? [paths.whenYesCardId] : []),
    ...(paths.whenNoCardId ? [paths.whenNoCardId] : []),
  ];
  if (targetIds.some((id) => !allowedIds.has(id))) {
    throw new SemanticViewValidationError("流程路径只能连接同一操作手册中的节点");
  }
  if (targetIds.includes(node.id)) {
    throw new SemanticViewValidationError("节点不能直接连接自身");
  }
  const targets = await database.semanticCard.findMany({
    where: { id: { in: [...new Set(targetIds)] } },
  });
  const targetsById = new Map(targets.map((target) => [target.id, target]));
  await database.semanticSlotBinding.deleteMany({
    where: { sourceCardId: node.id, slotKey: { in: ["next", "when_yes", "when_no"] } },
  });
  for (const targetId of paths.nextCardIds) {
    await addBinding(database, node, "next", targetsById.get(targetId)!);
  }
  if (paths.whenYesCardId) {
    await addBinding(database, node, "when_yes", targetsById.get(paths.whenYesCardId)!);
  }
  if (paths.whenNoCardId) {
    await addBinding(database, node, "when_no", targetsById.get(paths.whenNoCardId)!);
  }
}

type SampleNode = GuideNodeEditorValues & {
  key: string;
  next?: string[];
  yes?: string;
  no?: string;
};

const sampleLanes = [
  "会长",
  "活动管理",
  "项目负责人",
  "知识与材料",
  "二课系统",
  "采购",
  "宣传",
  "行政与资源",
];

const sampleNodes: SampleNode[] = [
  {
    key: "start", name: "发起活动", nodeType: "ACTION", lane: "会长", row: 0,
    guide: "说明想要举办的活动、大致时间和目标。这里是发起讨论，不要求一次写完全部方案。",
    requiredInformation: "活动想法、大致时间、主要目标。",
    aiAssistance: "AI 可以将零散想法整理成 Activity 初稿，但不应猜测未确定的人数和时间。",
    next: ["basic"],
  },
  {
    key: "basic", name: "建立活动基本信息", nodeType: "ACTION", lane: "活动管理", row: 0,
    guide: "建立 Activity，先保存名称、简介、大致时间、形式、规模和当前自然语言进展。",
    aiAssistance: "AI 可以根据对话提议创建 ActivityCard，但要等用户确认后才写入。",
    next: ["owner"],
  },
  {
    key: "owner", name: "确认项目负责人", nodeType: "ACTION", lane: "项目负责人", row: 0,
    guide: "确认谁负责整体推进和跨部门协调。这不等于所有工作都由该人完成。",
    requiredInformation: "一名已在社团信息中建立 PersonCard 的人员。",
    next: ["knowledge", "venue_decision", "purchase", "publicity"],
  },
  {
    key: "knowledge", name: "建立活动资料页", nodeType: "REFERENCE", lane: "知识与材料", row: 1,
    guide: "创建一个方便协作人员查看的资料页，放置活动简介、日期、初步预算和后续产生的材料。",
    resources: "可使用当前团队已有的飞书知识库或其他共享文档。",
    next: ["upload"],
  },
  {
    key: "venue_decision", name: "是否需要校内场地？", nodeType: "DECISION", lane: "行政与资源", row: 1,
    guide: "这是建议性判断，不是系统关卡。如果活动需要教室、体育场地或公共空间，可查看场地申请指南。",
    applicableCondition: "活动地点尚未确认，且可能使用学校管理的场地。",
    yes: "venue", no: "upload",
  },
  {
    key: "venue", name: "进行场地申请", nodeType: "ACTION", lane: "行政与资源", row: 2,
    guide: "先取得场地申请表，填写活动名称、使用日期、时段、参与人数和场地需求，再按学校当前要求提交。",
    requiredInformation: "活动名称、日期、使用时段、有依据的参与人数、场地和设施需求。",
    expectedOutcome: "获得场地确认，或收到调整时间/场地的反馈。",
    aiAssistance: "AI 可以根据当前 Activity 生成申请表初稿；缺少时段或场地需求时应先询问。",
    resources: "在这里补充当前有效的场地申请表模板、提交地点和联系方式。",
    next: ["upload"],
  },
  {
    key: "purchase", name: "参考采购指南", nodeType: "REFERENCE", lane: "采购", row: 1,
    guide: "如果活动需要采购物品，查看当前采购与报销要求。暂不要求在这张图中逐步汇报。",
    applicableCondition: "存在明确采购需求。",
    next: ["upload"],
  },
  {
    key: "publicity", name: "参考宣传指南", nodeType: "REFERENCE", lane: "宣传", row: 1,
    guide: "根据活动时间和对象确定宣传节奏、文案、视觉材料和发布渠道。",
    applicableCondition: "活动需要对内或对外招募参与者。",
    aiAssistance: "AI 可以根据已确定的活动信息生成文案初稿，不应把未确认的场地写成既定事实。",
    next: ["upload"],
  },
  {
    key: "upload", name: "汇总二课申报信息", nodeType: "ACTION", lane: "知识与材料", row: 3,
    guide: "汇总采购、宣传、场地和活动基本信息，准备二课申报所需内容。",
    requiredInformation: "活动介绍、日期、地点或场地计划、参与对象、组织安排和所需附件。",
    next: ["second_class"],
  },
  {
    key: "second_class", name: "进行二课申报", nodeType: "ACTION", lane: "二课系统", row: 4,
    guide: "根据已汇总的信息在当前二课系统完成申报。系统入口和字段要求可在资源区持续更新。",
    resources: "在这里补充当前二课系统入口和申报说明。",
    next: ["approved"],
  },
  {
    key: "approved", name: "二课是否通过？", nodeType: "DECISION", lane: "二课系统", row: 5,
    guide: "如未通过，按审核反馈修改申报信息后重新提交；如已通过，继续保存活动材料和经验。",
    yes: "experience", no: "second_class",
  },
  {
    key: "experience", name: "保留活动材料与经验", nodeType: "REFERENCE", lane: "知识与材料", row: 6,
    guide: "在活动进行中持续收集之后可复用的表单、文案、决策依据和经验。不要为了沉淀而强迫用户填写每个过程节点。",
    next: ["end"],
  },
  {
    key: "end", name: "活动结项", nodeType: "END", lane: "活动管理", row: 7,
    guide: "当活动的主要工作已结束，可将 Activity 进入收尾或已结束状态，并按需补充自然语言总结。",
    expectedOutcome: "Activity 状态和自然语言进度能够如实反映已结束或收尾中。",
  },
];

async function createSamplePlaybook(database: DatabaseClient) {
  const existingPlaybooks = await database.semanticCard.findMany({
    where: { viewKey: ACTIVITY_OPERATIONS_VIEW, cardTypeKey: "ActivityPlaybookCard" },
    include: { contentDimensions: true },
  });
  if (existingPlaybooks.some((playbook) => playbook.contentDimensions.some(
    (dimension) => dimension.name === PLAYBOOK_DIMENSIONS.name &&
      dimension.contentMarkdown === "社团活动筹备操作手册",
  ))) {
    throw new SemanticViewValidationError("示例操作手册已经存在");
  }
  const playbook = await createCard(database, "ActivityPlaybookCard");
  await setDimensions(database, playbook.id, playbookDimensions({
    name: "社团活动筹备操作手册",
    description: "从活动想法到结项的建议型泳道图，用于阅读、导航和 AI 辅助，不用于监督打卡。",
    applicableScenario: "需要多角色协作的校园社团活动筹备。",
    overview: "这张图展示常见工作、判断和资料入口。用户可从任意节点阅读；路径只表示参考关系。",
    notes: "流程节点不保存完成状态。AI 只能结合当前 Activity 的真实状态提出建议，不得仅根据图猜测已经执行到哪里。",
    lanes: sampleLanes,
  }));
  const nodesByKey = new Map<string, Awaited<ReturnType<typeof createCard>>>();
  for (const sample of sampleNodes) {
    const node = await createCard(database, "GuideNodeCard");
    nodesByKey.set(sample.key, node);
    await setDimensions(database, node.id, nodeDimensions(sample));
    await addBinding(database, playbook, "nodes", node);
  }
  await addBinding(database, playbook, "start_nodes", nodesByKey.get("start")!);
  for (const sample of sampleNodes) {
    const source = nodesByKey.get(sample.key)!;
    for (const targetKey of sample.next ?? []) {
      await addBinding(database, source, "next", nodesByKey.get(targetKey)!);
    }
    if (sample.yes) {
      await addBinding(database, source, "when_yes", nodesByKey.get(sample.yes)!);
    }
    if (sample.no) {
      await addBinding(database, source, "when_no", nodesByKey.get(sample.no)!);
    }
  }
}

export async function getActivityPlaybooks(): Promise<ActivityPlaybookCollection> {
  return buildActivityPlaybooks(await getSemanticView(ACTIVITY_OPERATIONS_VIEW));
}

export async function executeActivityPlaybookAction(
  input: ActivityPlaybookAction,
): Promise<ActivityPlaybookCollection> {
  const action = activityPlaybookActionSchema.parse(input);
  const database = getDatabase();
  await database.$transaction(async (transaction) => {
    switch (action.type) {
      case "CREATE_SAMPLE_PLAYBOOK":
        await createSamplePlaybook(transaction);
        break;
      case "CREATE_PLAYBOOK": {
        const playbook = await createCard(transaction, "ActivityPlaybookCard");
        await setDimensions(transaction, playbook.id, playbookDimensions(action.values));
        break;
      }
      case "UPDATE_PLAYBOOK":
        await requireCard(transaction, action.cardId, "ActivityPlaybookCard");
        await setDimensions(transaction, action.cardId, playbookDimensions(action.values));
        break;
      case "CREATE_GUIDE_NODE": {
        const playbook = await requireCard(
          transaction,
          action.playbookCardId,
          "ActivityPlaybookCard",
        );
        const node = await createCard(transaction, "GuideNodeCard");
        await setDimensions(transaction, node.id, nodeDimensions(action.values));
        await addBinding(transaction, playbook, "nodes", node);
        const startNodeCount = await transaction.semanticSlotBinding.count({
          where: { sourceCardId: playbook.id, slotKey: "start_nodes" },
        });
        if (startNodeCount === 0) {
          await addBinding(transaction, playbook, "start_nodes", node);
        }
        break;
      }
      case "UPDATE_GUIDE_NODE": {
        await requireCard(transaction, action.playbookCardId, "ActivityPlaybookCard");
        const node = await requireCard(transaction, action.cardId, "GuideNodeCard");
        await setDimensions(transaction, node.id, nodeDimensions(action.values));
        await replacePaths(transaction, action.playbookCardId, node, action.paths);
        break;
      }
    }
  });
  return getActivityPlaybooks();
}
