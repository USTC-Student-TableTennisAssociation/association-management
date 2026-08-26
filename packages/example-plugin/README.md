# `@echo/example-plugin`

用于验证 Echo 可发布 Plugin 完整链路的示例包，包含 View、Command、Skill、专属 React UI
和一个全局只读 Tool Provider。

```bash
pnpm build
pnpm pack
```

生成的 `.tgz` 可以通过 Echo Plugin CLI 安装。发布到 npm 前需要将 `@echo` scope
替换或授权为实际可发布的组织 scope。
