import type {
  CardTypeDefinition,
  DimensionDefinition,
  ViewModule,
} from "@/contracts";
import { societyInformationCommands } from "@/plugins/society-information/view/commands";
import { societyInformationEvents } from "@/plugins/society-information/view/events";
import { societyInformationInvariants } from "@/plugins/society-information/view/invariants";

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
        key: "team",
        label: "干事队伍",
        description: "当前干事队伍中的人员 Card。",
        allowedTargetCardTypes: ["PersonCard"],
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
    dimensions: [
      { key: "department", label: "部门", type: "text" },
      { key: "position", label: "职位", type: "text" },
      richText("description", "简介"),
    ],
    slots: [],
    relatedObjects: {
      description: "关联该人物的稳定 Object。",
      min: 1,
      max: 1,
      uniqueCardPerObject: true,
    },
  },
  {
    key: "ActivityCard",
    label: "活动",
    description: "对理解社团有长期意义的活动、品牌赛事或持续活动。",
    dimensions: [
      richText("description", "简介"),
      {
        key: "frequency",
        label: "举办频率",
        type: "enum",
        constraints: {
          enumOptions: [
            { key: "ANNUAL", label: "每年" },
            { key: "PER_SEMESTER", label: "每学期" },
            { key: "IRREGULAR", label: "不定期" },
          ],
        },
      },
      { key: "usual_period", label: "通常举办时期", type: "text" },
      {
        key: "status",
        label: "状态",
        type: "enum",
        required: true,
        defaultValue: "ACTIVE",
        constraints: {
          enumOptions: [
            { key: "ACTIVE", label: "持续举办" },
            { key: "PAUSED", label: "暂停" },
            { key: "RETIRED", label: "已停止" },
          ],
        },
      },
    ],
    slots: [],
    relatedObjects: {
      description: "关联这项长期活动的稳定 Object；同一 Object 在社团概览中只对应一张 Card。",
      min: 1,
      max: 1,
      uniqueCardPerObject: true,
    },
  },
  {
    key: "PlatformCard",
    label: "平台",
    description: "协会长期使用的平台、线上入口或公开信息渠道。",
    dimensions: [
      { key: "platform_type", label: "平台类型", type: "text", required: true },
      { key: "url", label: "公开链接", type: "text" },
      richText("access_instructions", "访问说明"),
      richText("description", "简介"),
      {
        key: "status",
        label: "状态",
        type: "enum",
        required: true,
        defaultValue: "ACTIVE",
        constraints: {
          enumOptions: [
            { key: "ACTIVE", label: "正常使用" },
            { key: "PAUSED", label: "暂停" },
            { key: "RETIRED", label: "已停用" },
          ],
        },
      },
    ],
    slots: [],
    relatedObjects: {
      description: "关联稳定平台 Object；同一 Object 在社团概览中只对应一张 Card。",
      min: 1,
      max: 1,
      uniqueCardPerObject: true,
    },
  },
] as const satisfies readonly CardTypeDefinition[];

export const societyInformationViewModule: ViewModule = {
  manifest: {
    key: SOCIETY_INFORMATION_VIEW_KEY,
    label: "社团信息",
    specializedLabel: "社团概览",
    version: "1.2.0",
    schemaVersion: "3",
    description: "组织社团身份、基本信息、当前指导关系、干事队伍、长期活动和平台入口。",
    retrievalDescription:
      "用于社团身份、基本信息、宗旨、星级、成立时间、当前指导老师、当前干事队伍、长期活动、平台与公开入口。干事人员需记录部门与职位。",
    aiSemanticInstructions:
      "Card 使用 View-local identity，并可通过 Related Objects 连接稳定认知 Object。业务关系只由本 View Slot 表达。",
    defaultSettings: { aiWritePolicy: "approval_required" },
  },
  schema: {
    viewKey: SOCIETY_INFORMATION_VIEW_KEY,
    schemaVersion: "3",
    cardTypes: societyInformationCardTypes,
  },
  commands: societyInformationCommands,
  invariants: societyInformationInvariants,
  events: societyInformationEvents,
  projections: [],
};
