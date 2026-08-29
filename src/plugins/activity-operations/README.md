# `echo-activity-operations-plugin`

Echo 的活动运营 View Plugin，包含正式 Card Schema、Domain Commands、
Invariants、Events 和“方法与执行”React Presentation。

Presentation 只有两个核心工作模式：

- 组织方法：用 Playbook、泳道、判断分支和嵌套子流程表达活动怎么组织；
- 任务版图：把真实 Activity 的 Work Package、Task、负责人、期限和前置依赖放在同一张图中。

Playbook 是建议，不代表当前届已经执行。通过 `activity.apply_playbook`
套用后，行动节点才会幂等地生成正式 Work Package 与 Task。人与 AI
都通过相同 Domain Commands 改变正式状态。

Plugin 提供两个职责分离的 Skill：

- `echo.activity-operations.design-playbook`：从 Shared Brain 与原始资料整理有来源的组织方法，只允许 Playbook Command；
- `echo.activity-operations.plan-task-map`：规划或检查真实 Activity 的执行版图，不允许改写 Playbook。

Presentation 通过 SDK 的结构化 `onInvokeAI` 直接发起 Skill，不在按钮中内嵌长提示词。

```bash
pnpm build
pnpm pack
```

生成的 tarball 自带编译后的服务端入口、专属 UI 和 CSS，可通过
Echo Plugin CLI 安装：

```bash
pnpm echo:plugin install ./echo-activity-operations-plugin-1.3.0.tgz
```
