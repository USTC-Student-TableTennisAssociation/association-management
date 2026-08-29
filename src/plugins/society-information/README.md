# `echo-society-information-plugin`

Echo 的社团信息 View Plugin，包含正式 Card Schema、Domain Commands、Events、
Invariants 和沉浸式 React 专属 UI。

`echo.society-information.maintain-overview` Skill 统一承担社团概览的证据检索、
缺口整理和待审批变更。Presentation 只通过 `onInvokeAI` 发送简短用户意图和
结构化 Skill 输入，不再内嵌工作流提示词。

当前使用无 scope 的开发包名，正式发布前需要确认 npm 名称是否可用，或改为组织 scope。

```bash
pnpm build
pnpm pack
```

生成的 tarball 自带编译后的服务端入口、专属 UI、CSS、徽章、字标和背景图，可以通过
Echo Plugin CLI 安装：

```bash
pnpm echo:plugin install ./echo-society-information-plugin-1.11.0.tgz
```
