# `echo-activity-operations-plugin`

Echo 的活动运营 View Plugin，包含正式 Card Schema、Domain Commands、
Invariants、Events 和“方法与执行”React Presentation。

Presentation 只有两个核心工作模式：

- 组织方法：用 Playbook、泳道、判断分支和嵌套子流程表达活动怎么组织；
- 任务版图：把真实 Activity 的 Work Package、Task、负责人、期限和前置依赖放在同一张图中。

Playbook 是建议，不代表当前届已经执行。通过 `activity.apply_playbook`
套用后，行动节点才会幂等地生成正式 Work Package 与 Task。人与 AI
都通过相同 Domain Commands 改变正式状态。

```bash
pnpm build
pnpm pack
```

生成的 tarball 自带编译后的服务端入口、专属 UI 和 CSS，可通过
Echo Plugin CLI 安装：

```bash
pnpm echo:plugin install ./echo-activity-operations-plugin-1.2.0.tgz
```
