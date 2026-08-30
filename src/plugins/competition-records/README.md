# `@sydaris/competition-records-plugin`

Sydaris 的比赛届次与长期赛事系列 Plugin。它提供 Competition View、正式
Domain Commands、赛事系列整理 Skill、USTCTTA 来源读取与届次映射 Tool
Providers，以及专用 React Presentation。

正式比赛状态只能通过 `competition.sync_editions` 和
`competition.organize_series` Commands 修改。Sydaris host 的同步入口负责依次
执行本 Plugin 提供的来源与映射 Tools，再把映射结果交给 System Command；Plugin
不会直接依赖宿主的 ToolRuntime、CommandBus 或数据库实现。

USTCTTA 来源 Provider 需要服务端环境变量 `USTCTTA_DATABASE_URL`，也可以使用
`USTCTTA_DATABASE_URL_UNPOOLED`。

```bash
pnpm build
pnpm pack
```

生成的 tarball 包含编译后的 server、Presentation、CSS、同步 contracts 与
`sydaris.plugin.json`。
