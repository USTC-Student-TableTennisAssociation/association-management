# `@sydaris/activity-operations-plugin`

Sydaris 的活动运营 View Plugin，包含正式 Card Schema、Domain Commands、
Invariants、Events 和“方法与执行”React Presentation。

Presentation 只有两个核心工作模式：

- 组织方法：用 Playbook、泳道、判断分支和嵌套子流程表达活动怎么组织；
- 任务版图：把真实 Activity 的 Work Package、Task、负责人、期限和前置依赖放在同一张图中。

Playbook 是建议，不代表当前届已经执行。它采用一个受约束的流程子集：

- 泳道表示稳定责任域，不表示时间阶段；
- `ACTION` 对应可独立负责的 Work Package，并带有可验收的 Task Definition；
- `DECISION` 必须具有 `YES` / `NO` 两条路线；
- `REFERENCE` 复用资料或子方法，`END` 表示明确终局；
- `READY` 方法的节点必须从起点可达，所有路径最终结束于 `END`。

AI 新建方法时使用 `activity.create_playbook_from_blueprint`，只提交紧凑的
语义蓝图。Runtime 会确定性展开 Playbook、节点、工作包定义、任务定义和连接，
并在一个事务中校验和创建，避免超长工具参数及多份 Proposal 留下半成品。
完整低层字段仍可通过 `activity.create_playbook_graph` 显式提交。通过
`activity.apply_playbook` 套用后，行动节点才会幂等地生成正式 Work Package
与 Task。人与 AI 都通过相同 Domain Commands 改变正式状态。

Plugin 提供两个按阶段衔接的 Skill：

- `sydaris.activity-operations.design-playbook`：在尚无已确认方法时优先确定工作流；从 Shared Brain 与原始资料整理有来源的组织方法，提议模式原子提交完整方法图；
- `sydaris.activity-operations.plan-task-map`：只在已有方法依据、已有正式 Activity，或用户明确跳过方法层后规划执行版图；不允许改写 Playbook。

Presentation 通过 SDK 的结构化 `onInvokeAI` 直接发起 Skill，不在按钮中内嵌长提示词。

```bash
pnpm build
pnpm pack
```

生成的 tarball 自带编译后的服务端入口、专属 UI 和 CSS，可通过
Sydaris Plugin CLI 安装：

```bash
pnpm sydaris:plugin install ./sydaris-activity-operations-plugin-1.3.0.tgz
```
