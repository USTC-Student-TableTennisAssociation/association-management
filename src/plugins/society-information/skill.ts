import { z } from "zod";

import {
  zodContractSchema,
  type SkillExtension,
} from "@sydaris/plugin-sdk";

export const societyOverviewMaintainerSkill: SkillExtension = {
  id: "sydaris.society-information.maintain-overview",
  version: "1.0.1",
  label: "维护社团概览",
  description:
    "从 Society Information View、Shared Brain 和原始资料中建立、补充或检查社团概览，包括简介、指导老师、干事队伍、长期活动和平台入口。用户要完善或维护社团概览时使用。",
  inputSchema: zodContractSchema(z.object({
    operation: z.enum(["complete", "fill-topic", "refine-card"]).default("complete"),
    phase: z.enum(["discuss", "propose"]).default("propose"),
    topic: z.string().trim().min(1).max(300).optional(),
    cardId: z.string().uuid().optional(),
  })),
  actionActivation: {
    inputField: "phase",
    allowedValues: ["propose"],
  },
  instructions: [
    "1. 先读取 society_information 当前状态，并以 Runtime 返回的 Schema 字段清单确定检索范围。完整任务要逐项记录为：已有值、证据支持的新值或暂无证据。",
    "2. 对未覆盖字段使用 synthesis 检索 Shared Brain；名单、平台入口和完整档案需回读高价值原文，索引与 Reference Assertion 不能代替正文。",
    "3. 身份只连接唯一确认的 Object；无证据的可选字段留空，不猜测。",
    "4. discuss 只给缺口与草案；propose 在核对完成后用最少的 Society Commands 提交待审批变更。只有身份歧义、状态冲突或必填项不明时询问用户。",
    "5. 长期活动等开放集合分批维护：先提交证据明确的候选，同时说明本轮来源范围和未确认候选；用户补充后定向检索并增量提交。",
  ].join("\n"),
  viewAccess: [{
    viewKey: "society_information",
    schemaVersion: "5",
    mode: "write",
    commands: [
      "society.initialize_overview",
      "society.update_profile",
      "society.set_advisors",
      "society.update_person",
      "society.save_team_member",
      "society.remove_team_member",
      "society.save_long_term_activity",
      "society.reorder_long_term_activities",
      "society.remove_long_term_activity",
      "society.save_platform",
      "society.remove_platform",
    ],
  }],
  requiresCapabilities: [],
};
