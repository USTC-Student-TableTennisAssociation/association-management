# `@echo/plugin-sdk`

Echo 可发布 Plugin 的公共合同和 React hooks。

服务端入口使用 `defineEchoPlugin`、`defineView` 和 `zodContractSchema` 声明 View、Command、
Skill 与 Tool Provider；专属 UI 从 `@echo/plugin-sdk/react` 使用 `useEchoView` 和
`useEchoCommand`，只通过 Echo 的 View API 读取状态和执行 Domain Command。

```bash
pnpm build
pnpm pack
```

发布时请使用自己拥有的 npm scope，并让 Plugin 将 SDK 声明为 peer dependency。
