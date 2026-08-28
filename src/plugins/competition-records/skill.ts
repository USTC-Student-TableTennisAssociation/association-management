import { z } from "zod";

import type { SkillExtension } from "@/contracts";
import { zodContractSchema } from "@/contracts";

export const competitionSeriesCuratorSkill: SkillExtension = {
  id: "echo.competition-records.curate-series",
  version: "0.1.0",
  label: "整理赛事系列",
  description:
    "从已记录的比赛届次、Shared Brain 与 Library 资料中识别长期赛事系列，归纳稳定简介和举办节奏，并提交届次归属 Proposal。",
  inputSchema: zodContractSchema(z.object({
    seriesHint: z.string().trim().min(1).max(300).optional(),
    editionHints: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
    focus: z.string().trim().min(1).max(500).optional(),
  })),
  instructions: [
    "目标是整理长期 CompetitionSeriesCard，而不是改写单届比赛历史。",
    "1. 先打开 competition_records Business Context，核对已有 CompetitionEditionCard、CompetitionSeriesCard 及 series Slot。",
    "2. 使用 synthesis 形状检索 Shared Brain；如需名单、届次沿革、稳定赛制或举办节奏，继续定位 Library 文件并回读高价值来源章节。",
    "3. 只有在资料或明确命名能够支持届次与系列归属时才关联；名称相似不足以单独证明。",
    "4. Series description 只写跨届稳定特征，cadence 只写有证据的通常节奏；日期、人数和单届结果保留在 Edition。",
    "5. 读取充分后打开 business_view Actions，只调用 competition.organize_series。一次提交证据支持的完整届次集合；证据不足的候选保持未关联。",
  ].join("\n"),
  viewAccess: [
    {
      viewKey: "competition_records",
      schemaVersion: "1",
      mode: "write",
      commands: ["competition.organize_series"],
    },
    { viewKey: "society_information", schemaVersion: "5", mode: "read" },
  ],
  knowledge: ["shared_brain", "library", "source_documents"],
  requiresCapabilities: [],
};
