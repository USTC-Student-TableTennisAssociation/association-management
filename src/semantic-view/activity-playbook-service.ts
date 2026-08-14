import { Prisma, type PrismaClient } from "@/generated/prisma/client";

import { getDatabase } from "@/db";
import {
  GUIDE_NODE_DIMENSIONS,
  PLAYBOOK_DIMENSIONS,
} from "@/semantic-view/activity-operations-contract";
import {
  ACTIVITY_PLAYBOOK_STARTER_NAMES,
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

const purchaseReimbursementLanes = [
  "项目负责人",
  "预算与审批",
  "采购执行",
  "财务报销",
  "二课系统",
  "知识与材料",
];

const purchaseReimbursementNodes: SampleNode[] = [
  {
    key: "purchase_start", name: "确认采购需求", nodeType: "ACTION", lane: "项目负责人", row: 0,
    guide: "先说明要买什么、为什么需要、预计数量和使用时间。这里只需要形成可讨论的采购需求，不要求立刻提交审批。",
    requiredInformation: "物品或服务名称、用途、预计数量、需要时间、关联 Activity（如有）。",
    aiAssistance: "AI 可以把零散需求整理成采购清单，并标出数量、规格、日期或用途中的缺失项。",
    next: ["budget_check"],
  },
  {
    key: "budget_check", name: "确认预算来源与报销条件", nodeType: "ACTION", lane: "预算与审批", row: 1,
    guide: "在下单前确认经费来源、预算额度、允许采购的品类、发票要求，以及是否需要询价或事前审批。不要先假设所有支出都能报销。",
    requiredInformation: "预计总额、经费来源、采购品类、当前适用的财务要求。",
    expectedOutcome: "得到可以采购、需要调整或需要补充审批的明确意见。",
    resources: "在这里维护当前有效的采购制度、预算负责人和咨询入口。",
    next: ["budget_approved"],
  },
  {
    key: "budget_approved", name: "预算与采购方式是否确认？", nodeType: "DECISION", lane: "预算与审批", row: 2,
    guide: "这是下单前的风险提示。若预算或采购方式尚未确认，先调整需求或补充审批；确认后再执行采购。",
    yes: "execute_purchase", no: "revise_purchase",
  },
  {
    key: "revise_purchase", name: "调整需求或补充审批", nodeType: "ACTION", lane: "项目负责人", row: 3,
    guide: "根据反馈调整品类、数量、预算、供应商选择方式或活动安排，再次确认是否满足采购条件。",
    aiAssistance: "AI 可以根据反馈生成差异清单和修改后的采购方案，但不能代替预算负责人批准。",
    next: ["budget_check"],
  },
  {
    key: "execute_purchase", name: "执行询价与采购", nodeType: "ACTION", lane: "采购执行", row: 3,
    guide: "按已经确认的采购方式询价、比选和下单，并保留订单、报价、付款和收货记录。若实际价格明显变化，应重新确认预算。",
    requiredInformation: "已确认的规格、数量、预算上限和采购方式。",
    expectedOutcome: "取得所需物品或服务，同时保留可解释采购过程的原始材料。",
    next: ["collect_invoice"],
  },
  {
    key: "collect_invoice", name: "取得发票与付款凭证", nodeType: "ACTION", lane: "采购执行", row: 4,
    guide: "向供应方取得符合当前报销要求的发票，并保存付款凭证、订单或收据。发票抬头、税号、项目内容等字段以当前财务要求为准。",
    requiredInformation: "开票信息、实际金额、供应方信息和支付记录。",
    resources: "在这里维护当前有效的开票信息和发票示例；不要让 AI 猜测抬头或税号。",
    next: ["invoice_valid"],
  },
  {
    key: "invoice_valid", name: "发票与凭证是否完整？", nodeType: "DECISION", lane: "财务报销", row: 5,
    guide: "检查金额、日期、购买内容、开票信息和支付记录是否一致，并确认是否还有签领表、验收材料或其他附件要求。",
    yes: "prepare_materials", no: "replace_invoice",
  },
  {
    key: "replace_invoice", name: "补开或更正材料", nodeType: "ACTION", lane: "采购执行", row: 6,
    guide: "联系供应方补开发票、更正字段或补充订单与付款凭证。无法更正时，先向财务负责人说明真实情况并确认处理方式。",
    next: ["invoice_valid"],
  },
  {
    key: "prepare_materials", name: "整理报销材料包", nodeType: "REFERENCE", lane: "知识与材料", row: 6,
    guide: "把预算或审批记录、采购清单、订单/报价、发票、付款凭证和收货/使用说明集中整理，保留原始文件。",
    expectedOutcome: "形成一份可核对、可补正、可归档的报销材料包。",
    aiAssistance: "AI 可以按当前规则检查材料清单和命名，但不能判断发票真伪或虚构缺失附件。",
    next: ["second_class_needed"],
  },
  {
    key: "second_class_needed", name: "是否关联二课活动结项？", nodeType: "DECISION", lane: "二课系统", row: 7,
    guide: "若这笔支出依赖二课活动的结项或活动材料，先确认对应要求；与二课无关时可以直接进入签领和报销表准备。",
    yes: "second_class_close", no: "sign_form",
  },
  {
    key: "second_class_close", name: "完成二课结项材料", nodeType: "ACTION", lane: "二课系统", row: 8,
    guide: "按当前二课系统要求整理签到、总结、照片或其他结项材料并提交。流程地图只提供提醒，不据此判断系统已经结项。",
    requiredInformation: "二课活动记录和当前系统要求的真实附件。",
    resources: "在这里维护当前二课结项入口和材料清单。",
    next: ["sign_form"],
  },
  {
    key: "sign_form", name: "填写签领表与报销表", nodeType: "ACTION", lane: "财务报销", row: 9,
    guide: "使用当前有效模板填写报销或签领信息。姓名、金额、用途、账户等字段应来自真实材料，并由相关人员自行核对。",
    requiredInformation: "最终金额、用途、经办/签领人员和当前模板要求的信息。",
    aiAssistance: "AI 可以根据材料生成表格初稿并提示空缺字段，但不能代签、猜测账户或替人确认金额。",
    resources: "在这里维护当前有效的签领表、报销表模板及填写示例。",
    next: ["submit_reimbursement"],
  },
  {
    key: "submit_reimbursement", name: "提交报销审核", nodeType: "ACTION", lane: "财务报销", row: 10,
    guide: "按当前规定把材料提交给对应审核人或系统，并保留提交版本和时间，方便后续补正。",
    resources: "在这里维护当前提交入口、接收人和纸质材料要求。",
    next: ["reimbursement_approved"],
  },
  {
    key: "reimbursement_approved", name: "报销审核是否通过？", nodeType: "DECISION", lane: "财务报销", row: 11,
    guide: "如被退回，按真实审核意见补正后重新提交；通过后记录到账或签领结果并归档。",
    yes: "purchase_end", no: "supplement_materials",
  },
  {
    key: "supplement_materials", name: "按审核意见补正", nodeType: "ACTION", lane: "知识与材料", row: 12,
    guide: "逐条记录审核意见，补充或更正对应材料。若意见涉及规则解释，应直接向审核人确认，不让 AI 自行解释成既定规则。",
    aiAssistance: "AI 可以将审核意见转成补正清单并帮助检查新旧版本差异。",
    next: ["submit_reimbursement"],
  },
  {
    key: "purchase_end", name: "记录结果并归档", nodeType: "END", lane: "知识与材料", row: 13,
    guide: "记录实际报销金额、到账或签领结果，并将最终表单与关键凭证归档，供后续活动复用经验。",
    expectedOutcome: "报销结果可追溯，材料和经验可在需要时被找到。",
  },
];

const venueApplicationLanes = [
  "项目负责人",
  "知识与材料",
  "行政与资源",
  "场地管理方",
];

const venueApplicationNodes: SampleNode[] = [
  {
    key: "venue_start", name: "确认场地需求", nodeType: "ACTION", lane: "项目负责人", row: 0,
    guide: "确认活动是否需要学校管理的教室、体育场地或公共空间，并说明期望日期、时段、人数、布置和设备需求。",
    requiredInformation: "Activity 名称、日期、时段、有依据的参与人数、场地类型和设施需求。",
    aiAssistance: "AI 可以从当前 Activity 整理需求草稿；时间、人数或设备未确定时应明确标为待确认。",
    next: ["venue_information"],
  },
  {
    key: "venue_information", name: "核对活动基本信息", nodeType: "ACTION", lane: "知识与材料", row: 1,
    guide: "汇总申请表会用到的活动简介、负责人、联系方式、参与对象和组织安排，确保不同材料中的日期和人数一致。",
    expectedOutcome: "形成一份可直接用于申请表的真实信息摘要。",
    next: ["venue_template"],
  },
  {
    key: "venue_template", name: "取得当前申请模板与要求", nodeType: "REFERENCE", lane: "行政与资源", row: 2,
    guide: "从可信入口取得当前有效的场地申请表、可申请场地范围、提前量、签字盖章和提交要求。旧模板只可作为参考。",
    resources: "在这里维护学校当前有效的模板、办理说明、提交地点和联系方式。",
    next: ["fill_venue_form"],
  },
  {
    key: "fill_venue_form", name: "填写场地申请材料", nodeType: "ACTION", lane: "知识与材料", row: 3,
    guide: "按模板填写活动、日期、时段、人数、负责人、场地与设备需求；对尚未确认的信息留出明确标记，不编造答案。",
    aiAssistance: "AI 可以根据已确认的 Activity 信息生成表单初稿和缺失字段清单。",
    next: ["internal_review"],
  },
  {
    key: "internal_review", name: "完成内部核对与签批", nodeType: "ACTION", lane: "行政与资源", row: 4,
    guide: "由负责人核对活动信息和风险事项，并根据当前要求完成必要的指导老师、社团或相关单位签字盖章。",
    requiredInformation: "填好的申请材料和当前要求的真实签批信息。",
    next: ["submit_venue"],
  },
  {
    key: "submit_venue", name: "向场地管理方提交", nodeType: "ACTION", lane: "场地管理方", row: 5,
    guide: "通过当前有效入口提交申请，保存提交版本、时间和接收方式；需要纸质材料时按要求递交。",
    resources: "在这里维护当前线上入口或线下提交地点，不使用未经核实的旧地址。",
    next: ["venue_approved"],
  },
  {
    key: "venue_approved", name: "场地申请是否确认？", nodeType: "DECISION", lane: "场地管理方", row: 6,
    guide: "只有收到管理方明确确认后，才把场地作为已确定信息。被退回或无法安排时，根据反馈调整。",
    yes: "record_venue", no: "adjust_venue",
  },
  {
    key: "adjust_venue", name: "按反馈调整时间或场地", nodeType: "ACTION", lane: "项目负责人", row: 7,
    guide: "根据管理方反馈调整日期、时段、人数、场地类型或材料，并同步检查 Activity 和宣传信息是否需要修改。",
    aiAssistance: "AI 可以整理可选方案和受影响信息，但不能把未获确认的备选场地写成最终场地。",
    next: ["fill_venue_form"],
  },
  {
    key: "record_venue", name: "记录场地确认信息", nodeType: "REFERENCE", lane: "知识与材料", row: 7,
    guide: "保存确认通知、最终日期时段、具体场地、使用规则、联系人和设备安排，并更新 Activity 正式信息。",
    expectedOutcome: "团队使用同一份经过确认的场地信息。",
    next: ["notify_venue"],
  },
  {
    key: "notify_venue", name: "同步相关人员与宣传材料", nodeType: "ACTION", lane: "项目负责人", row: 8,
    guide: "将最终场地信息同步给组织人员和参与者，并更新宣传、物资、签到和现场安排。只传播已经确认的版本。",
    next: ["venue_end"],
  },
  {
    key: "venue_end", name: "归档申请与使用要求", nodeType: "END", lane: "知识与材料", row: 9,
    guide: "归档最终申请表、确认记录和场地使用要求。活动结束后可补充真实经验，供下一次申请参考。",
    expectedOutcome: "场地申请材料与有效经验可追溯、可复用。",
  },
];

type StarterPlaybook = {
  name: typeof ACTIVITY_PLAYBOOK_STARTER_NAMES[number];
  description: string;
  applicableScenario: string;
  overview: string;
  notes: string;
  lanes: string[];
  nodes: SampleNode[];
  startNodeKey: string;
};

export const ACTIVITY_PLAYBOOK_STARTERS: StarterPlaybook[] = [{
  name: "社团活动筹备操作手册",
  description: "从活动想法到结项的建议型泳道图，用于阅读、导航和 AI 辅助，不用于监督打卡。",
  applicableScenario: "需要多角色协作的校园社团活动筹备。",
  overview: "这张图展示常见工作、判断和资料入口。用户可从任意节点阅读；路径只表示参考关系。",
  notes: "流程节点不保存完成状态。AI 只能结合当前 Activity 的真实状态提出建议，不得仅根据图猜测已经执行到哪里。",
  lanes: sampleLanes,
  nodes: sampleNodes,
  startNodeKey: "start",
}, {
  name: "采购与报销操作指南",
  description: "从采购需求、预算确认、发票凭证到报销审核与归档的建议型节点链。",
  applicableScenario: "社团活动或日常运营中需要采购，并可能使用组织经费报销。",
  overview: "先确认可采购和可报销条件，再保留真实凭证、准备二课或签领材料并提交审核。路径用于提示风险和材料关系，不是审批系统。",
  notes: "财务规则、模板、开票信息和提交入口必须以当前有效来源为准。AI 可整理和检查信息，但不能批准预算、验证发票、代签或猜测账户信息。",
  lanes: purchaseReimbursementLanes,
  nodes: purchaseReimbursementNodes,
  startNodeKey: "purchase_start",
}, {
  name: "校内场地申请操作指南",
  description: "从场地需求、模板填写和签批提交，到确认、同步与归档的建议型节点链。",
  applicableScenario: "活动需要使用学校管理的教室、体育场地或公共空间。",
  overview: "帮助负责人准备真实申请信息、找到当前入口并处理反馈。获得明确确认前，不把备选场地当作最终安排。",
  notes: "模板、签批要求、办理提前量和提交地点可能变化，应持续维护可靠来源；流程图不代表申请已经完成。",
  lanes: venueApplicationLanes,
  nodes: venueApplicationNodes,
  startNodeKey: "venue_start",
}];

async function existingPlaybookNames(database: DatabaseClient) {
  const existingPlaybooks = await database.semanticCard.findMany({
    where: { viewKey: ACTIVITY_OPERATIONS_VIEW, cardTypeKey: "ActivityPlaybookCard" },
    include: { contentDimensions: true },
  });
  return new Set(existingPlaybooks.flatMap((playbook) =>
    playbook.contentDimensions
      .filter((dimension) => dimension.name === PLAYBOOK_DIMENSIONS.name)
      .map((dimension) => dimension.contentMarkdown)));
}

async function createStarterPlaybook(
  database: DatabaseClient,
  starter: StarterPlaybook,
) {
  const playbook = await createCard(database, "ActivityPlaybookCard");
  await setDimensions(database, playbook.id, playbookDimensions(starter));
  const nodesByKey = new Map<string, Awaited<ReturnType<typeof createCard>>>();
  for (const sample of starter.nodes) {
    const node = await createCard(database, "GuideNodeCard");
    nodesByKey.set(sample.key, node);
    await setDimensions(database, node.id, nodeDimensions(sample));
    await addBinding(database, playbook, "nodes", node);
  }
  await addBinding(
    database,
    playbook,
    "start_nodes",
    nodesByKey.get(starter.startNodeKey)!,
  );
  for (const sample of starter.nodes) {
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

async function createSamplePlaybook(database: DatabaseClient) {
  const existingNames = await existingPlaybookNames(database);
  const sample = ACTIVITY_PLAYBOOK_STARTERS[0];
  if (existingNames.has(sample.name)) {
    throw new SemanticViewValidationError("示例操作手册已经存在");
  }
  await createStarterPlaybook(database, sample);
}

async function installStarterPlaybooks(database: DatabaseClient) {
  const existingNames = await existingPlaybookNames(database);
  for (const starter of ACTIVITY_PLAYBOOK_STARTERS) {
    if (!existingNames.has(starter.name)) {
      await createStarterPlaybook(database, starter);
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
      case "INSTALL_STARTER_PLAYBOOKS":
        await installStarterPlaybooks(transaction);
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
  }, { timeout: 30_000 });
  return getActivityPlaybooks();
}
