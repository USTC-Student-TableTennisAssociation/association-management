# `@sydaris/plugin-sdk`

Echo Plugin 的公开 TypeScript 合同、描述文件 Schema 和 React hooks。

> 当前是 `0.1.0-alpha.1` 预发布版，API 可能在后续 alpha 版调整。

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
