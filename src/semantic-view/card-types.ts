import {
  SOCIETY_INFORMATION_VIEW,
  type BusinessViewKey,
} from "@/semantic-view/types";

export type SlotDefinition = {
  key: string;
  label: string;
  meaning: string;
  allowedTargetCardTypes: readonly string[];
  cardinality: "one" | "many";
};

export type CardTypeDefinition = {
  key: string;
  viewKey: BusinessViewKey;
  label: string;
  meaning: string;
  seedContentDimensions: readonly string[];
  slots: Readonly<Record<string, SlotDefinition>>;
};

export type BusinessViewDefinition = {
  key: BusinessViewKey;
  label: string;
  specializedLabel?: string;
  meaning: string;
  retrievalDescription: string;
  aiSemanticInstructions: string;
  cardTypes: Readonly<Record<string, CardTypeDefinition>>;
};

export const societyInformationCardTypes = {
  SocietyCard: {
    key: "SocietyCard",
    viewKey: SOCIETY_INFORMATION_VIEW,
    label: "社团",
    meaning: "描述社团自身的基本身份与长期信息。",
    seedContentDimensions: ["社团星级", "成立时间", "宗旨", "简介"],
    slots: {
      advisor: {
        key: "advisor",
        label: "指导老师",
        meaning: "为该社团提供正式指导的人员 Card。",
        allowedTargetCardTypes: ["PersonCard"],
        cardinality: "many",
      },
      positions: {
        key: "positions",
        label: "职位",
        meaning: "该社团在具体学年中的职位实例 Card。",
        allowedTargetCardTypes: ["PositionCard"],
        cardinality: "many",
      },
      activities: {
        key: "activities",
        label: "活动",
        meaning: "对理解社团有长期意义的活动或品牌赛事 Card。",
        allowedTargetCardTypes: ["ActivityCard"],
        cardinality: "many",
      },
      platforms: {
        key: "platforms",
        label: "平台",
        meaning: "社团长期使用的平台、线上入口或公开信息渠道 Card。",
        allowedTargetCardTypes: ["PlatformCard"],
        cardinality: "many",
      },
    },
  },
  PersonCard: {
    key: "PersonCard",
    viewKey: SOCIETY_INFORMATION_VIEW,
    label: "人物",
    meaning: "在社团信息中被稳定指认和连接的人物。",
    seedContentDimensions: ["简介"],
    slots: {},
  },
  PositionCard: {
    key: "PositionCard",
    viewKey: SOCIETY_INFORMATION_VIEW,
    label: "职位",
    meaning: "职位 Object 在某个学年中的具体业务实例及其任职人员；同一职位可按不同学年形成多张 Card。",
    seedContentDimensions: ["职位名称", "学年", "简介 / 职责"],
    slots: {
      holders: {
        key: "holders",
        label: "任职人员",
        meaning: "在该学年担任这个具体职位的人员 Card。",
        allowedTargetCardTypes: ["PersonCard"],
        cardinality: "many",
      },
    },
  },
  ActivityCard: {
    key: "ActivityCard",
    viewKey: SOCIETY_INFORMATION_VIEW,
    label: "活动",
    meaning: "对理解社团有长期意义的活动、品牌赛事或持续活动。",
    seedContentDimensions: ["简介", "举办时期"],
    slots: {},
  },
  PlatformCard: {
    key: "PlatformCard",
    viewKey: SOCIETY_INFORMATION_VIEW,
    label: "平台",
    meaning: "协会长期使用的平台、线上入口或公开信息渠道。",
    seedContentDimensions: ["平台类型", "访问方式", "简介"],
    slots: {},
  },
} as const satisfies Record<string, CardTypeDefinition>;

export const societyInformationViewDefinition = {
  key: SOCIETY_INFORMATION_VIEW,
  label: "社团信息",
  specializedLabel: "社团概览",
  meaning: "组织社团身份、基本信息、指导关系、学年职位、长期活动和平台入口。",
  retrievalDescription:
    "用于社团身份、基本信息、宗旨、星级、成立时间、指导老师、稳定人物关系、" +
    "学年职位、长期活动、平台与公开入口等稳定社团信息。",
  aiSemanticInstructions:
    "Card identity 必须来自 Shared Brain Object。ContentDimension 是开放结构；" +
    "Slot schema 只允许使用本 View 定义的 advisor、positions、activities、platforms 和 holders。" +
    "职位 Object 可以跨学年复用；PositionCard 必须设置学年，同一职位 Object 与同一学年只能有一张 Card；" +
    "PositionCard.holders 是任职关系的 canonical direction。",
  cardTypes: societyInformationCardTypes,
} as const satisfies BusinessViewDefinition;

export const businessViewDefinitions = {
  [SOCIETY_INFORMATION_VIEW]: societyInformationViewDefinition,
} as const satisfies Record<BusinessViewKey, BusinessViewDefinition>;

export function businessViewDefinition(
  viewKey: string,
): BusinessViewDefinition | undefined {
  return businessViewDefinitions[viewKey as BusinessViewKey];
}

export function cardTypeDefinition(
  viewKey: string,
  cardTypeKey: string,
): CardTypeDefinition | undefined {
  return businessViewDefinition(viewKey)?.cardTypes[cardTypeKey];
}

export function cardTypePromptContract(viewKey: BusinessViewKey): string {
  const view = businessViewDefinitions[viewKey];
  return [
    `${view.key}（${view.label}）：${view.meaning}`,
    view.aiSemanticInstructions,
    ...Object.values(view.cardTypes).map((cardType) => {
      const slots = Object.values(cardType.slots);
      return [
        `${cardType.key}（${cardType.label}）：${cardType.meaning}`,
        `  seed ContentDimensions：${cardType.seedContentDimensions.join("、") || "无；ContentDimension 仍是开放结构"}`,
        `  slots：${slots.length ? slots.map((slot) => `${slot.key}（${slot.label}，${slot.cardinality}，target=${slot.allowedTargetCardTypes.join("|")}）`).join("；") : "无"}`,
      ].join("\n");
    }),
  ].join("\n");
}

export function businessViewRetrievalDescriptions(): string {
  return Object.values(businessViewDefinitions)
    .map((view) => `${view.key}（${view.label}）：${view.retrievalDescription}`)
    .join("\n");
}
