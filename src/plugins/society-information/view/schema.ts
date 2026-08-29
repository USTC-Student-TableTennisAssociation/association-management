import type {
  CardTypeDefinition,
  DimensionDefinition,
  ViewChangePolicy,
  ViewModule,
} from "@sydaris/plugin-sdk";

import { societyInformationCommands } from "./commands.js";
import { societyInformationEvents } from "./events.js";
import { societyInformationInvariants } from "./invariants.js";

export const SOCIETY_INFORMATION_VIEW_KEY = "society_information";

const evaluateKnowledgeChange = {
  attention: "evaluate",
  knowledge: "reconcile",
  guidance:
    "区分纯措辞润色与组织事实变化。措辞润色保持安静；只有存在真实冲突、重要联动或需要用户判断的歧义时才主动回应。",
} as const satisfies ViewChangePolicy;

const evaluateRelationshipChange = {
  attention: "evaluate",
  knowledge: "reconcile",
  guidance:
    "这是正式业务关系的变化。先自动对账相关 Object Higher Memory；只有当前关系仍有冲突或后续动作需要用户决定时才请求确认。",
} as const satisfies ViewChangePolicy;

const ignorePresentationOrder = {
  attention: "never",
  knowledge: "none",
} as const satisfies ViewChangePolicy;

const reviewIdentityLinkChange = {
  attention: "always",
  knowledge: "reconcile",
  guidance:
    "Card 与稳定认知 Object 的身份关联发生变化，必须给出可见审查结果；存在身份歧义时请求用户确认。",
} as const satisfies ViewChangePolicy;

const richText = (
  key: string,
  label: string,
  description: string,
): DimensionDefinition => ({
  key,
  label,
  description,
  type: "rich_text",
  presentation: { multiline: true },
  changePolicy: evaluateKnowledgeChange,
});

export const societyInformationCardTypes = [
  {
    key: "SocietyCard",
    label: "社团",
    description: "描述社团自身的基本身份与长期信息。",
    dimensions: [
      {
        key: "rating",
        label: "社团星级",
        description:
          "社团在当前评价体系中正式获评的等级，属于会随评审变化的当前事实，不是纯展示文字；实质变化可能需要检查知识层中的旧记录。",
        type: "text",
        changePolicy: evaluateKnowledgeChange,
      },
      {
        key: "founded_on",
        label: "成立时间",
        description: "社团正式成立的日期或年份，是稳定历史事实；修改时需要与已有组织认知对账。",
        type: "date",
        changePolicy: evaluateKnowledgeChange,
      },
      richText("purpose", "宗旨", "社团长期坚持的使命、价值取向与成立目的，不等同于近期活动宣传语。"),
      richText("description", "简介", "面向读者概括社团身份、特色与长期定位的正文；文字润色通常不改变组织事实。"),
    ],
    slots: [
      {
        key: "advisor",
        label: "指导老师",
        description: "为该社团提供正式指导的人员 Card。",
        allowedTargetCardTypes: ["PersonCard"],
        cardinality: "many",
        changePolicy: evaluateRelationshipChange,
      },
      {
        key: "team",
        label: "干事队伍",
        description:
          "当前任期干事队伍中可唯一指认、且有证据证明当前在任的真实个人 Card；身份可识别不等于当前在任。历任名单中的过往成员不属于此 Slot。",
        allowedTargetCardTypes: ["PersonCard"],
        cardinality: "many",
        changePolicy: evaluateRelationshipChange,
      },
      {
        key: "activities",
        label: "活动",
        description: "对理解社团有长期意义的活动或品牌赛事 Card。",
        allowedTargetCardTypes: ["ActivityCard"],
        cardinality: "many",
        changePolicy: ignorePresentationOrder,
      },
      {
        key: "platforms",
        label: "平台",
        description: "社团长期使用的平台、线上入口或公开信息渠道 Card。",
        allowedTargetCardTypes: ["PlatformCard"],
        cardinality: "many",
        changePolicy: ignorePresentationOrder,
      },
    ],
    relatedObjects: {
      description: "关联被稳定识别的社团 Object。",
      min: 1,
      max: 1,
      uniqueCardPerObject: true,
      changePolicy: reviewIdentityLinkChange,
    },
    changePolicy: evaluateKnowledgeChange,
  },
  {
    key: "PersonCard",
    label: "人物",
    description: "在社团信息中被稳定指认和连接的一位真实个人。",
    dimensions: [
      {
        key: "department",
        label: "部门",
        description: "该人物在当前社团中的正式部门；没有可靠资料时留空，不推造组织单元。",
        type: "text",
        changePolicy: evaluateKnowledgeChange,
      },
      {
        key: "position",
        label: "职位",
        description: "该人物在当前社团中的职位；没有可靠资料时留空。",
        type: "text",
        changePolicy: evaluateKnowledgeChange,
      },
      richText("description", "简介", "该人物与社团有关的公开简介，只写入有依据且适合展示的信息。"),
    ],
    slots: [],
    relatedObjects: {
      description: "关联该人物的稳定 Object。",
      min: 1,
      max: 1,
      uniqueCardPerObject: true,
      changePolicy: reviewIdentityLinkChange,
    },
    changePolicy: evaluateKnowledgeChange,
  },
  {
    key: "ActivityCard",
    label: "活动",
    description: "对理解社团有长期意义的活动、品牌赛事或持续活动。",
    dimensions: [
      richText("description", "简介", "该长期活动的内容、定位和稳定特征，不用于记录单届活动流水。"),
      {
        key: "frequency",
        label: "举办频率",
        description: "该长期活动通常重复举办的节奏；资料不足以确定时应留空。",
        type: "enum",
        changePolicy: evaluateKnowledgeChange,
        constraints: {
          enumOptions: [
            { key: "WEEKLY", label: "每周" },
            { key: "ANNUAL", label: "每年" },
            { key: "PER_SEMESTER", label: "每学期" },
            { key: "IRREGULAR", label: "不定期" },
          ],
        },
      },
      {
        key: "usual_period",
        label: "通常举办时期",
        description: "长期活动通常发生的时间范围或周期，不代表某一届活动的确定日期。",
        type: "text",
        changePolicy: evaluateKnowledgeChange,
      },
      {
        key: "status",
        label: "状态",
        description: "该长期活动目前是否持续举办；停止或暂停属于需要与既有认知对账的事实变化。",
        type: "enum",
        required: true,
        defaultValue: "ACTIVE",
        changePolicy: evaluateKnowledgeChange,
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
      changePolicy: reviewIdentityLinkChange,
    },
    changePolicy: evaluateKnowledgeChange,
  },
  {
    key: "PlatformCard",
    label: "平台",
    description: "社团使用或曾被资料明确提及的平台、线上入口或公开信息渠道。",
    dimensions: [
      {
        key: "platform_type",
        label: "平台类型",
        description: "平台或渠道的类别，例如 QQ 群、公众号、视频平台或网站。",
        type: "text",
        required: true,
        changePolicy: evaluateKnowledgeChange,
      },
      {
        key: "url",
        label: "公开链接",
        description: "可以直接公开访问的 URL；没有可靠链接时留空。",
        type: "text",
        changePolicy: evaluateKnowledgeChange,
      },
      {
        ...richText("access_instructions", "访问说明", "用户找到、进入、关注、联系或经由该平台加入社团的具体方法。"),
        description:
          "用户如何找到、进入、关注、联系或通过该平台加入社团，例如群号、账号搜索方式或入群申请方式。‘账号/链接待确认’不是访问说明，未知时留空。",
      },
      {
        ...richText("description", "简介", "该平台在社团中的长期用途、内容定位和面向人群。"),
        description: "该平台在社团中的用途或内容定位，不填写访问步骤。",
      },
      {
        key: "status",
        label: "状态",
        description:
          "平台当前是否仍在使用。资料只证明平台存在、但不能证明当前可用时选择 UNKNOWN，不默认推断为正常使用。",
        type: "enum",
        required: true,
        defaultValue: "UNKNOWN",
        changePolicy: evaluateKnowledgeChange,
        constraints: {
          enumOptions: [
            { key: "ACTIVE", label: "正常使用" },
            { key: "UNKNOWN", label: "待确认" },
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
      changePolicy: reviewIdentityLinkChange,
    },
    changePolicy: evaluateKnowledgeChange,
  },
] as const satisfies readonly CardTypeDefinition[];

export const societyInformationViewModule: ViewModule = {
  manifest: {
    key: SOCIETY_INFORMATION_VIEW_KEY,
    label: "社团信息",
    specializedLabel: "社团概览",
    schemaVersion: "5",
    description: "组织社团身份、基本信息、当前指导关系、干事队伍、长期活动和平台入口。",
    retrievalDescription:
      "用于社团身份、基本信息、宗旨、星级、成立时间、当前指导老师、当前干事队伍、长期活动、平台与公开入口。",
    aiSemanticInstructions:
      "Card 使用 View-local identity，并通过 Related Objects 连接稳定认知 Object；业务关系只由本 View Slot 表达。" +
      "SocietyCard.advisor 只表示当前正式指导老师；致谢、曾经提供指导、历史交流或笼统的‘指导老师’提法，不能单独证明当前任职。" +
      "society.set_advisors 会自动创建或复用人物 Card，不要用 society.save_team_member 预建指导老师。SocietyCard.team 只收录当前任期中能够唯一对应到稳定人物 Object、且来源明确支持当前在任的实际个人；调用 society.save_team_member 就表示把该人物加入当前 team Slot。Object 身份唯一只解决‘是谁’，不证明‘当前在任’；历任名单是历史记录，不是当前队伍，只有有效期覆盖当前时点的条目才可作为候选。职位或角色概念、未具名群体、指导老师、校友、历届成员，以及只凭作者身份推断而未被具名确认的人，都不能代替当前干事成员 Card。" +
      "团队规模和组织结构属于社团知识，不要伪造成一个成员。PersonCard 的部门、职位和简介只填写有证据的内容，可选信息不确定时留空。" +
      "SocietyCard.activities 只收录可以唯一指认的具体品牌赛事或持续活动；‘大型赛事’、‘常规活动’、‘双轮驱动’等类别和运行模式不是具体 ActivityCard。" +
      "SocietyCard.description 里的摘要不能代替 Slot Card；当用户要求完善某个 Slot 且证据支持多个具体条目时，应为每个条目分别调用对应保存 Command。" +
      "PlatformCard.access_instructions 只描述用户如何找到、进入、关注、联系或经由该平台加入社团；平台承担的内容与用途写入 description。" +
      "资料只提到平台名称时可以建立 PlatformCard，但不得把‘账号/链接待确认’写成访问说明，也不得默认平台仍正常使用；此时留空入口字段并使用 UNKNOWN。招新活动及其举办时期属于 ActivityCard，不属于平台访问说明。" +
      "待审批只改变 Command 的生效流程，不改变 Card 或 Slot 的含义；不符合 Slot 语义的对象应省略并说明，不能先作为候选 Proposal 提交后再让用户删除。",
    defaultSettings: { aiWritePolicy: "approval_required" },
  },
  schema: {
    viewKey: SOCIETY_INFORMATION_VIEW_KEY,
    schemaVersion: "5",
    cardTypes: societyInformationCardTypes,
  },
  commands: societyInformationCommands,
  invariants: societyInformationInvariants,
  events: societyInformationEvents,
};
