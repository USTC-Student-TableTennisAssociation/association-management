import { z } from "zod";

import {
  zodContractSchema,
  type SkillExtension,
} from "@sydaris/plugin-sdk";

export const LIBRARY_TRIAGE_SKILL_ID = "sydaris.library.triage";

export const libraryTriageSkill: SkillExtension = {
  id: LIBRARY_TRIAGE_SKILL_ID,
  version: "1.0.0",
  label: "资料库分诊与编译规划",
  description:
    "在用户刚上传资料、询问下一步、需要理解三种处理档位，或希望制定基础编译优先级时，完整盘点 Library，给出可解释的 catalog/coarse/deep 建议，并按需生成待审批计划。",
  inputSchema: zodContractSchema(z.object({
    phase: z.enum(["assess", "recommend", "propose", "review"]).default("recommend"),
    folderId: z.string().uuid().optional(),
    jobId: z.string().uuid().optional(),
    focus: z.string().trim().min(1).max(500).optional(),
  })),
  instructions: [
    "目标是帮助用户把已上传文件转化为可控、可审批的基础编译计划，而不是泛泛让用户重新介绍文件夹。",
    "1. assess/recommend/propose 阶段先读取目标文件夹；input.folderId 存在时以它为范围，否则使用页面当前文件夹或资料库根目录。盘点文件时使用 listLibrary 的 recursive=true、kind=file、detail=compact、limit=1000，并在 truncated=true 时用 nextOffset 继续，不能用单页结果代表全部文件。",
    "2. 严格区分索引与正文：文件名和路径只能支持资料类型与主题线索，表述为‘从文件名/路径看’，不得说成‘从内容看’。不得从 catalog、idle 或标题推断正文事实。",
    "3. 向用户清楚解释三档是每份唯一内容的独立选择，不是依次升级：catalog 做低成本归档和轻量语义导航；coarse 提取可独立使用的重要事实；deep 保留完整来源结构并深入编译、归并 Global Object。profile、执行 status、发布状态必须分开说明。",
    "4. 初步建议以价值和未来问题形状为依据：需要完整结构、长期复用、名单/表格/规则语境或关键历史来源的候选优先 deep；只需主题导航和少量稳定事实的候选优先 coarse；低价值附件、重复项、无法仅凭索引判断的内容先保持 catalog。不要把所有文件一律设为 deep。",
    "5. 文件名与路径不足以判断的候选保持 catalog；只有其判断会实质改变计划时，才用 previewLibraryFiles 抽样读取，单轮最多 3 份，不得批量启动解析器。",
    "6. phase=assess 只报告完整库存、处理/发布边界和仍未知项。phase=recommend 给出分组后的第一版建议、理由和下一步，不打开 Actions。phase=propose 在完成盘点后打开 library Actions，并用 proposeLibraryPlan 提交 SET_PROFILE Proposal；每个操作最多 200 个真实 nodeId，批准前不得说已经应用或开始编译。",
    "7. phase=review 使用 readLibraryCompilation 检查真实阶段、失败项和 publishedAt；只有有发布回执的结果才进入 Shared Brain。",
    "8. 基础编译不会直接写 Business View。需要把已发布知识整理进社团信息、活动运营或赛事档案时，再组合相应 View Skill，经 Domain Command、Proposal 和用户审批完成。",
    "9. 用户刚说‘已上传一些文件’或‘接下来怎么办’时，系统能够自行盘点；直接说明观察结果、三档选择和可执行下一步，不要求用户逐个提供文件名或重新描述目录。",
  ].join("\n"),
  viewAccess: [],
  resourceAccess: [{
    resource: "library",
    operations: ["propose_plan"],
  }],
  requiresCapabilities: [],
};
