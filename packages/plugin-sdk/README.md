# `@sydaris/plugin-sdk`

Echo Plugin 的公开 TypeScript 合同、描述文件 Schema 和 React hooks。

> 当前是 `0.1.0-alpha.5` 预发布版，API 可能在后续 alpha 版调整。

## 安装

```bash
npm install @sydaris/plugin-sdk@next react zod
```

Plugin 应将 SDK、React 和 Zod 声明为 peer dependencies，避免将宿主运行时重复打包。

## Plugin 服务端入口

```ts
import { defineEchoPlugin, defineView } from "@sydaris/plugin-sdk";

const notesView = defineView({
  manifest: {
    key: "notes",
    label: "Notes",
    schemaVersion: "1",
    description: "A minimal notes View",
    defaultSettings: { aiWritePolicy: "approval_required" },
  },
  schema: { viewKey: "notes", schemaVersion: "1", cardTypes: [] },
  commands: [],
  invariants: [],
  events: [],
  projections: [],
});

export const notesPlugin = defineEchoPlugin({
  id: "echo.notes",
  version: "0.1.0",
  contributes: { views: [notesView] },
});
```

## Skill 执行契约

Skill 是由 Chat Runtime 激活的专用 AI 工作流，不是可以直接修改数据的回调。
它声明语义输入、执行指令、知识来源、可读 View 与精确到 Command 的写入范围。
Runtime 负责校验依赖、注入指令、限制 Command，并把 `skillId` 记入 Proposal / Execution 审计链。

```ts
const dailyPlanner: SkillExtension = {
  id: "echo.notes.daily-planner",
  version: "1.0.0",
  label: "每日计划",
  description: "结合日历整理当日计划。",
  inputSchema: zodContractSchema(z.object({ focus: z.string().optional() })),
  instructions: "读取日历，核对当前 Notes View，再提交一则计划笔记。",
  viewAccess: [{
    viewKey: "notes",
    schemaVersion: "1",
    mode: "write",
    commands: ["notes.create"],
  }],
  knowledge: [],
  requiresCapabilities: [{ key: "calendar.read", versions: "^1.0.0" }],
};
```

`mode: "write"` 同时允许读取目标 View，但只能执行 `commands` 中显式列出的
Domain Command。跨 Plugin 读取 View 时，提供 Skill 的 Plugin 还应通过
`EchoPluginManifest.requires` 声明对应 Plugin 版本依赖。

## Tool 调用方边界

Plugin 可以通过 `contributes.toolCapabilities` 持有 Capability Contract，
并由 `contributes.tools` 中的 Provider 实现。每个 Contract 必须显式声明
`allowedCallers`；只读并不等于可以暴露给 AI。

```ts
const internalSourceRead: ToolCapabilityContract = {
  key: "competition.source.read",
  version: "1.0.0",
  description: "读取比赛源数据。",
  semanticContract: "只返回比赛级数据，不返回个人身份。",
  inputSchema,
  outputSchema,
  sideEffect: "none",
  allowedCallers: ["view", "automation"],
  requiredPermissions: ["tool.competition.source.read"],
};
```

Runtime 会在执行时校验 `ToolContext.caller`。只有同时声明
`allowedCallers: ["agent"]` 且无副作用的 Capability 才会进入 AI 对话 Toolset。

View Command 同样必须声明 `allowedInitiators`。例如由 View 内部同步服务
使用的 Command 应设为 `allowedInitiators: ["system"]`；Runtime 不会将它放入
AI Actions，普通人工 Command API 也无法执行。

## View 修改语义与 AI 反应

Dimension、Slot、Related Objects 和 Card Type 可以声明 `changePolicy`。Plugin 只声明
业务语义和反应策略；Echo Runtime 负责事务前后差异记录、上下文脱敏、模型调用和
Higher Memory 对账。

```ts
{
  key: "status",
  label: "状态",
  description: "当前正式业务状态。",
  type: "enum",
  changePolicy: {
    attention: "evaluate", // never | evaluate | always
    knowledge: "reconcile", // none | reconcile
    guidance: "区分措辞修改与真实状态变化。",
  },
}
```

`evaluate` 默认静默评估，只在存在冲突、重要联动或需要用户判断时主动回应；
`always` 要求产生可见核对结果；`never` 不调用后台 Observer。是否对账 Higher Memory
与是否打扰用户是两个独立决策。

Presentation 可以通过无头 Hook 读取持久化 Reaction：

```tsx
const { reactions, markSeen } = useEchoViewReactions(viewKey);
```

Hook 只返回变更目标、`attention` / `knowledge` 状态、消息与时间戳，
不规定标签、颜色、弹窗或布局。Specialized Presentation 可以自由设计呈现；
Echo 的 Generic View 只提供一个可替换的默认呈现。

## `echo.plugin.json`

发布的 Plugin 包需要携带一份描述文件，并在 `package.json#echoPlugin`
中指向它。`engines.echo` 是宿主安装时使用的 SemVer 兼容范围。

```json
{
  "schemaVersion": 1,
  "id": "echo.notes",
  "version": "0.1.0",
  "engines": { "echo": ">=0.1.0-alpha.1 <0.2.0-0" },
  "server": { "entry": "./dist/server.js", "export": "notesPlugin" },
  "contributes": {
    "views": ["notes"],
    "presentations": [],
    "skills": [],
    "toolCapabilities": [],
    "tools": []
  }
}
```

SDK 导出 `parseEchoPluginPackageDescriptor`、
`echoPluginPackageDescriptorContract` 和 `isEchoVersionCompatible`，Echo CLI 与第三方工具
使用同一份规范。

## 专属 UI

```ts
import { useEchoCommand, useEchoView } from "@sydaris/plugin-sdk/react";
```

UI 只通过 Echo 的 View API 读取状态和执行 Domain Command。

## 开发

```bash
pnpm build
pnpm pack
```

## 许可证

Apache-2.0
