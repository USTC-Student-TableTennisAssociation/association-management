import { tool } from "ai";
import { z } from "zod";

export const runtimeSkillKeys = ["business-view-graph-authoring"] as const;
export type RuntimeSkillKey = typeof runtimeSkillKeys[number];

type RuntimeSkill = {
  key: RuntimeSkillKey;
  title: string;
  description: string;
  instructions: string;
};

const businessViewGraphAuthoring: RuntimeSkill = {
  key: "business-view-graph-authoring",
  title: "Business View 子图构建",
  description:
    "创建或修复目录、建议型流程地图、操作指南等包含容器、成员、起点或路径的 Business View Card/Slot 子图时使用；简单问答或单字段修改不使用。",
  instructions: `
【Skill：Business View 子图构建】

目标：使用当前 Business View 的通用 Card、ContentDimension 与 Slot 合同，生成可批准、可渲染的完整子图。不要引入平行协议或专用写入工具。

唯一结构真相：
- 以本轮 readSemanticView/openBusinessContext 返回的实时 cardTypes 为准。
- 深入读取 requiredContentDimensions、container、conditionalSlotRequirements、contentDimensionConstraints，以及每个 Slot 的 target type、cardinality、minimumTargetCount、subsetOfSlotKey、sameContainer 和 reachability。
- 本 Skill 只规定如何消费 schema，不覆盖、猜测或复制具体业务 schema。

工作流程：
1. 先读取正式 View，识别现有 Card、可复用 Card 和用户所指对象；修复任务优先复用现有 Card。
2. 根据 Card Type 的 label、meaning 和约束识别容器 Card、成员 Card、起点 Slot 与路径 Slots，不凭字段名称猜结构。
3. 在调用 proposeViewChange 前先形成内部子图清单：所有新旧 Card selector、每张 Card 的必填 ContentDimensions、容器成员关系、起点和全部路径。
4. 将用户给出的现实业务事实与组织性建议分开。结构必须完整；尚未核实的现实规则、人员、入口、日期和审批结果应省略或明确写为待核实，不能补猜。
5. 用一个 Proposal 原子提交完整子图。ContentDimension 只能表达内容，不能代替本应由 Card/Slot 表达的成员、顺序、分支或归属关系。
6. 提交前按实时合同自检：必填维度齐全；目标类型与数量合法；容器归属完整；子集成立；条件 Slot 已设置；所有受覆盖成员都能从起点沿允许路径到达。
7. 如果当前信息不足以选择 Card Type 或形成最小合法结构，先向用户说明真正缺失的选择；不要创建看似成功的空壳 Card。

流程地图质量规则：
- 泳道表示角色、责任主体或系统，不表示步骤顺序；每个泳道条目独立表达。
- 一个节点只承担一个主要意图：操作、判断、资料入口或结果。
- 先后、并行和分支使用实时 schema 提供的路径 Slot 表达，不压缩进描述文字。
- 判断节点的每个合同要求分支都必须有明确目标。
- 地图是建议型程序知识，不代表用户已经执行到某一步，也不保存 Runtime 完成状态。

失败恢复：
- 把服务端校验错误理解为当前子图计划缺失的约束，修复原计划后重新提交。
- 不得通过删除节点、删除路径、清空依据或退化为容器空壳来绕过错误。
- 如果错误揭示实时 schema 与原计划不兼容，重新读取合同并重建映射，不发明新的 Slot key。
`.trim(),
};

const runtimeSkills: Readonly<Record<RuntimeSkillKey, RuntimeSkill>> = {
  [businessViewGraphAuthoring.key]: businessViewGraphAuthoring,
};

export function runtimeSkillCatalog() {
  return runtimeSkillKeys.map((key) => {
    const skill = runtimeSkills[key];
    return { key: skill.key, title: skill.title, description: skill.description };
  });
}

export function createRuntimeSkillToolset() {
  const loadedSkillKeys = new Set<RuntimeSkillKey>();
  const tools = {
    loadSkill: tool({
      description: [
        "按需加载一份本轮任务的程序性 Skill。Skill 只指导如何使用实时工具/schema，不授予权限，也不替代服务端校验。",
        "可用 Skills：",
        ...runtimeSkillCatalog().map((skill) =>
          `${skill.key}（${skill.title}）：${skill.description}`
        ),
      ].join("\n"),
      inputSchema: z.object({
        skillKey: z.enum(runtimeSkillKeys),
        reason: z.string().trim().min(1).max(300),
      }),
      execute: async ({ skillKey, reason }) => {
        const alreadyLoaded = loadedSkillKeys.has(skillKey);
        loadedSkillKeys.add(skillKey);
        const skill = runtimeSkills[skillKey];
        return {
          loaded: true,
          alreadyLoaded,
          skillKey,
          title: skill.title,
          reason,
          instructions: skill.instructions,
        };
      },
    }),
  };

  return {
    tools,
    instructions: () => runtimeSkillKeys
      .filter((key) => loadedSkillKeys.has(key))
      .map((key) => runtimeSkills[key].instructions)
      .join("\n\n"),
    loadedSkillKeys: () => runtimeSkillKeys.filter((key) => loadedSkillKeys.has(key)),
  };
}
