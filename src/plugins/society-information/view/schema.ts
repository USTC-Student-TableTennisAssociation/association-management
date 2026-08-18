import type {
  CardTypeDefinition,
  DimensionDefinition,
  ViewModule,
} from "@/contracts";
import { societyInformationCommands } from "@/plugins/society-information/view/commands";
import { societyInformationEvents } from "@/plugins/society-information/view/events";

export const SOCIETY_INFORMATION_VIEW_KEY = "society_information";

const richText = (key: string, label: string): DimensionDefinition => ({
  key,
  label,
  type: "rich_text",
  presentation: { multiline: true },
});

export const societyInformationCardTypes = [
  {
    key: "SocietyCard",
    label: "社团",
    description: "描述社团自身的基本身份与长期信息。",
    dimensions: [
      { key: "rating", label: "社团星级", type: "text" },
      { key: "founded_on", label: "成立时间", type: "date" },
      richText("purpose", "宗旨"),
      richText("description", "简介"),
    ],
    slots: [
      {
        key: "advisor",
        label: "指导老师",
        description: "为该社团提供正式指导的人员 Card。",
        allowedTargetCardTypes: ["PersonCard"],
        cardinality: "many",
      },
      {
        key: "positions",
        label: "职位",
        description: "该社团在具体学年中的职位实例 Card。",
        allowedTargetCardTypes: ["PositionCard"],
        cardinality: "many",
      },
      {
        key: "activities",
        label: "活动",
        description: "对理解社团有长期意义的活动或品牌赛事 Card。",
        allowedTargetCardTypes: ["ActivityCard"],
        cardinality: "many",
      },
      {
        key: "platforms",
        label: "平台",
        description: "社团长期使用的平台、线上入口或公开信息渠道 Card。",
        allowedTargetCardTypes: ["PlatformCard"],
        cardinality: "many",
      },
    ],
    relatedObjects: {
      description: "关联被稳定识别的社团 Object。",
      min: 1,
      max: 1,
      uniqueCardPerObject: true,
    },
  },
  {
    key: "PersonCard",
    label: "人物",
    description: "在社团信息中被稳定指认和连接的人物。",
    dimensions: [richText("description", "简介")],
    slots: [],
    relatedObjects: {
      description: "关联该人物的稳定 Object。",
      min: 1,
      max: 1,
      uniqueCardPerObject: true,
    },
  },
  {
    key: "PositionCard",
    label: "职位",
    description: "职位 Object 在某个学年中的具体业务实例及其任职人员。",
    dimensions: [
      { key: "name", label: "职位名称", type: "text", required: true },
      { key: "academic_year", label: "学年", type: "text", required: true },
      richText("description", "简介 / 职责"),
    ],
    slots: [{
      key: "holders",
      label: "任职人员",
      description: "在该学年担任这个具体职位的人员 Card。",
      allowedTargetCardTypes: ["PersonCard"],
      cardinality: "many",
    }],
    relatedObjects: {
      description: "可关联这个职位的稳定 Object；学年仍由 Card Dimension 表达。",
      max: 1,
    },
  },
  {
    key: "ActivityCard",
    label: "活动",
    description: "对理解社团有长期意义的活动、品牌赛事或持续活动。",
    dimensions: [richText("description", "简介"), { key: "period", label: "举办时期", type: "text" }],
    slots: [],
    relatedObjects: { description: "可关联稳定活动 Object。", max: 1 },
  },
  {
    key: "PlatformCard",
    label: "平台",
    description: "协会长期使用的平台、线上入口或公开信息渠道。",
    dimensions: [
      { key: "platform_type", label: "平台类型", type: "text" },
      { key: "access", label: "访问方式", type: "text" },
      richText("description", "简介"),
    ],
    slots: [],
    relatedObjects: { description: "可关联稳定平台 Object。", max: 1 },
  },
] as const satisfies readonly CardTypeDefinition[];

export const societyInformationViewModule: ViewModule = {
  manifest: {
    key: SOCIETY_INFORMATION_VIEW_KEY,
    label: "社团信息",
    specializedLabel: "社团概览",
    version: "1.0.0",
    schemaVersion: "1",
    description: "组织社团身份、基本信息、指导关系、学年职位、长期活动和平台入口。",
    retrievalDescription:
      "用于社团身份、基本信息、宗旨、星级、成立时间、指导老师、稳定人物关系、学年职位、长期活动、平台与公开入口等稳定社团信息。",
    aiSemanticInstructions:
      "Card 使用 View-local identity，并可通过 Related Objects 连接稳定认知 Object。业务关系只由本 View Slot 表达。",
    defaultSettings: { aiWritePolicy: "approval_required" },
  },
  schema: {
    viewKey: SOCIETY_INFORMATION_VIEW_KEY,
    schemaVersion: "1",
    cardTypes: societyInformationCardTypes,
  },
  commands: societyInformationCommands,
  invariants: [],
  events: societyInformationEvents,
  projections: [],
};
