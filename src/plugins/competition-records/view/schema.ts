import type {
  CardTypeDefinition,
  ViewChangePolicy,
  ViewModule,
} from "@/contracts";

import { competitionRecordsCommands } from "@/plugins/competition-records/view/commands";
import { competitionRecordsEvents } from "@/plugins/competition-records/view/events";

export const COMPETITION_RECORDS_VIEW_KEY = "competition_records";

const reconcileKnowledge = {
  attention: "evaluate",
  knowledge: "reconcile",
  guidance:
    "比赛届次或赛事系列的正式事实发生变化，应与稳定 Object 和来源资料对账。",
} as const satisfies ViewChangePolicy;

const identityChange = {
  attention: "always",
  knowledge: "reconcile",
  guidance:
    "Related Objects 表示 Card 的现实身份，不表示‘属于某赛事系列’。身份不明时不得将届次绑定到系列 Object。",
} as const satisfies ViewChangePolicy;

export const competitionRecordsCardTypes = [
  {
    key: "CompetitionSeriesCard",
    label: "赛事系列",
    description:
      "表示可重复举办、可持续指认的长期赛事品牌或制度，例如‘积分赛’；不表示某一次具体举办。",
    dimensions: [
      {
        key: "name",
        label: "系列名称",
        description: "稳定的赛事系列名称。",
        type: "text",
        required: true,
        changePolicy: reconcileKnowledge,
      },
      {
        key: "description",
        label: "系列简介",
        description:
          "从多届比赛与知识库资料中归纳的稳定定位、赛制或目标，不填写单届流水。",
        type: "rich_text",
        presentation: { multiline: true },
        changePolicy: reconcileKnowledge,
      },
      {
        key: "cadence",
        label: "举办节奏",
        description:
          "资料可支持时记录该系列通常的举办频率或时段；不确定时留空。",
        type: "text",
        changePolicy: reconcileKnowledge,
      },
    ],
    slots: [],
    relatedObjects: {
      description: "关联该长期赛事系列的稳定 Object。",
      min: 1,
      max: 1,
      uniqueCardPerObject: true,
      changePolicy: identityChange,
    },
    changePolicy: reconcileKnowledge,
  },
  {
    key: "CompetitionEditionCard",
    label: "比赛届次",
    description:
      "表示一次有具体时间、参与人数和来源记录的真实比赛，例如‘第十五次积分赛’。",
    dimensions: [
      {
        key: "name",
        label: "届次名称",
        description: "该次具体比赛在来源系统或资料中的名称。",
        type: "text",
        required: true,
        changePolicy: reconcileKnowledge,
      },
      {
        key: "participant_count",
        label: "参与人数",
        description:
          "该届比赛的参与人数；应保留来源系统的统计口径，不从赛果条数猜测。",
        type: "integer",
        required: true,
        constraints: { min: 0 },
        changePolicy: reconcileKnowledge,
      },
      {
        key: "sequence_number",
        label: "届次序号",
        description: "资料明示的第 N 次或第 N 届序号。",
        type: "integer",
        constraints: { min: 1 },
        changePolicy: reconcileKnowledge,
      },
      {
        key: "held_on",
        label: "比赛日期",
        description: "该届比赛的实际或官方计划日期。",
        type: "date",
        changePolicy: reconcileKnowledge,
      },
      {
        key: "source_system",
        label: "来源系统",
        description: "该届比赛记录的权威来源系统。",
        type: "text",
        required: true,
        defaultValue: "USTCTTA",
        changePolicy: reconcileKnowledge,
      },
      {
        key: "source_id",
        label: "来源记录 ID",
        description:
          "来源系统中稳定的比赛 ID，用于同步去重，不是展示名称。",
        type: "text",
        changePolicy: reconcileKnowledge,
      },
    ],
    slots: [
      {
        key: "series",
        label: "所属赛事系列",
        description:
          "表示‘该届比赛属于哪个长期赛事系列’；这是归属关系，不是 Related Object 身份。",
        allowedTargetCardTypes: ["CompetitionSeriesCard"],
        cardinality: "one",
        changePolicy: reconcileKnowledge,
      },
    ],
    relatedObjects: {
      description:
        "如已有可唯一指认的届次 Object，关联该具体比赛 Object；不得关联其所属的系列 Object。",
      max: 1,
      uniqueCardPerObject: true,
      changePolicy: identityChange,
    },
    changePolicy: reconcileKnowledge,
  },
] as const satisfies readonly CardTypeDefinition[];

export const competitionRecordsViewModule: ViewModule = {
  manifest: {
    key: COMPETITION_RECORDS_VIEW_KEY,
    label: "赛事档案",
    specializedLabel: "赛事数据",
    schemaVersion: "1",
    description:
      "记录具体比赛届次，并从多届数据与组织资料中整理长期赛事系列。",
    retrievalDescription:
      "用于比赛届次、参与人数、来源记录、届次序号和长期赛事系列。",
    aiSemanticInstructions: [
      "CompetitionEditionCard 表示一次具体发生的比赛；CompetitionSeriesCard 表示可重复举办的长期赛事品牌或制度。",
      "例如‘第十五次积分赛’是 Edition，‘积分赛’是 Series；两者不是同一 Object。",
      "Related Objects 只表示 Card 本身的现实身份。Edition 属于 Series 必须使用 Edition.series Slot，不得把 Edition 绑定到 Series Object。",
      "记录届次时优先使用权威来源的参与人数和 source_id；不从赛果数量猜测参与人数。同一 source_system/source_id 只能对应一张 Edition Card。",
      "用户要求从届次和知识库整理赛事系列时，先读取 competition_records，再检索 Shared Brain/Library 核对系列身份、稳定定位和举办节奏，最后调用 competition.organize_series。",
      "系列简介只写多届或资料支持的稳定特征；单届日期、人数和结果留在 Edition。证据不足时留空，不补写猜测。",
      "对名称相似但缺少系列归属证据的届次，不自动关联；已属于其他 Series 的 Edition 不得静默改挂。",
    ].join("\n"),
    defaultSettings: { aiWritePolicy: "approval_required" },
  },
  schema: {
    viewKey: COMPETITION_RECORDS_VIEW_KEY,
    schemaVersion: "1",
    cardTypes: competitionRecordsCardTypes,
  },
  commands: competitionRecordsCommands,
  invariants: [],
  events: competitionRecordsEvents,
  projections: [],
};
