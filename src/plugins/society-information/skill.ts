import { z } from "zod";

import {
  zodContractSchema,
  type SkillExtension,
} from "@sydaris/plugin-sdk";

export const societyOverviewMaintainerSkill: SkillExtension = {
  id: "echo.society-information.maintain-overview",
  version: "1.0.0",
  label: "维护社团概览",
  description:
    "从 Society Information View、Shared Brain 和原始资料中建立、补充或检查社团概览，包括简介、指导老师、干事队伍、长期活动和平台入口。用户要完善或维护社团概览时使用。",
  inputSchema: zodContractSchema(z.object({
    operation: z.enum(["complete", "fill-topic", "refine-card"]).default("complete"),
    phase: z.enum(["discuss", "propose"]).default("propose"),
    topic: z.string().trim().min(1).max(300).optional(),
    cardId: z.string().uuid().optional(),
  })),
  instructions: [
    "1. 先打开 society_information Business Context，核对当前概览、目标 Card 和缺失字段。",
    "2. 使用 synthesis 检索 Shared Brain，并对人员名单、长期活动、平台入口或完整社团信息回读高价值原文。文件索引和 Reference Assertion 不能代替原文。",
    "3. 仅使用唯一确认的 Object 表达社团、老师和成员身份；可选细节不确定时留空或标记推断，不得猜测身份。",
    "4. phase=discuss 时只输出缺口、证据和草案，不调用 View Command。phase=propose 时在证据充分后打开 business_view Actions，使用最少的 Society Command 提交完整待审批变更。",
    "5. 只有 Object 身份歧义、当前状态冲突或 Command 必填信息无法确定时才询问用户。",
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
