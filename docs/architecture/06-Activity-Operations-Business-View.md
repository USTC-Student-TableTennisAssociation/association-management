# Activity Operations Business View

> 状态：Activity Portfolio + 建议型 Activity Playbook / working draft  
> 更新日期：2026-08-14

本文记录第一个专属 UI 已经验证的语义，不是最终 Card、Dimension、Slot 或数据库规范。

## 状态与身份

Activity Operations 的正式 Business State 仍然是：

```text
SemanticCard + ContentDimension + SlotBinding
```

- Activity Portfolio 与 Activity Playbook 都没有独立业务表或前端状态模型；它们是对上述正式状态的投影与编辑器。
- 知识投影 Card 可继续通过 `compilationId + sourceObjectId` 锚定 Shared Brain Object。
- Activity、WorkPackage、Assignment 等新产生的 Runtime Card 可以是原生 Card identity；它们的两个 source identity 列同时为空。数据库 check constraint 禁止只为其中一列赋值。
- 不使用通用 Relation、Edge ontology 或第二份 Work Graph。
- 人工 UI 和 AI Proposal 的 `CREATE_CARD / SET_CONTENT_DIMENSION / SET_SLOT` 最终操作同一组语义表。

## Activity Portfolio 已使用的合同

### ActivityCard

ContentDimensions：

```text
名称
简介
状态          PLANNING | RUNNING | WRAP_UP | COMPLETED | CANCELLED
进度          自然语言
活动时间
活动形式
活动规模
参与人数      有确定依据时才记录
```

Slots：

```text
work_packages   -> WorkPackageCard (many)
assignments     -> AssignmentCard (many)
```

`completed / total` 由 `work_packages` 指向的 Card 状态派生，不另存百分比。没有 `expectedParticipants`。

### WorkPackageCard

ContentDimensions：

```text
名称
简介
状态          NOT_STARTED | IN_PROGRESS | COMPLETED | CANCELLED
进度          自然语言
截止时间
```

Slots：

```text
definition      -> WorkPackageDefinitionCard (one, optional)
assignments     -> AssignmentCard (many)
tasks           -> TaskCard (many)
```

Activity Portfolio 只计数 Task 及其 `COMPLETED` 状态，不展开 Task UI。

### AssignmentCard

```text
Activity / WorkPackage.assignments -> AssignmentCard
AssignmentCard.assignee            -> society_information.PersonCard (one)
```

`assignee` 是目前唯一允许跨 Business View 的 Slot 合同。应用层和数据库 trigger 同时限定其 source Card Type、slot key、target View 和 target Card Type，不复制 Person Card。

## 已实现 UI 行为

- Activity 一级表显示名称、时间、负责人、状态、自然语言进度和派生的工作完成数。
- 展开 Activity 只显示二级 Work Package：名称、负责人、状态、自然语言进度、截止时间。
- Activity 和 Work Package 在轻量右侧抽屉编辑；创建/更新和负责人变更在同一数据库事务中提交。
- Work Package 可取消。只有没有 Task 的 Work Package 可直接删除；已有 Task 时要求改为取消，避免静默丢失工作状态。
- GET 和每次 mutation 后的返回都从 Semantic View 状态重建 Portfolio；页面不缓存可替代持久化的业务模型。

## 建议型 Activity Playbook

操作手册使用两个正式 Card Type：

```text
ActivityPlaybookCard
  nodes       -> GuideNodeCard (many)
  start_nodes -> GuideNodeCard (many)

GuideNodeCard
  next        -> GuideNodeCard (many)
  when_yes    -> GuideNodeCard (one)
  when_no     -> GuideNodeCard (one)
  definition  -> WorkPackageDefinitionCard (one)
  resources   -> ArtifactCard (many)
```

`ActivityPlaybookCard` 保存名称、简介、适用场景、整体说明、注意事项和泳道顺序。`GuideNodeCard` 保存节点类型、泳道、纵向位置，以及操作指南、适用条件、所需信息、预期结果、AI 协助说明和资源入口。

节点类型只有 `ACTION / DECISION / REFERENCE / END`。`next / when_yes / when_no` 只表达阅读导航与常见控制关系，供泳道图和 AI 理解上下文；不表达真实 Activity 已经执行到哪里。

因此 Playbook 明确不保存：

- 当前节点、已完成节点或完成百分比；
- 节点锁定、强制前置条件或必须打卡；
- 从指南节点自动产生的 Task 或 Runtime 状态。

UI 提供泳道地图、节点详情抽屉、节点与建议路径编辑器。用户可从任意节点阅读；“带着此节点询问 AI”只预填问题，由用户决定是否发送。AI 仍须读取 Activity Operations 的真实正式状态来判断指南是否适用，不得从地图路径推断用户当前进度。

## 本轮刻意不做

- Task Context Space、Task 知识库、Task 详情页或三级展开；
- 财务、采购、报销、材料、审批、报名、参与、结果和复盘 UI；
- 执行型 Workflow Engine、Work Graph Synthesis、Planner、BPMN 或复杂状态机；
- 通用 Dimension Type System、Renderer Registry、表格引擎或 Context Space 类型；
- 预估参与人数、自动 Progress 后台任务或完成百分比存储。

## Open Questions

1. UI 现在将负责人当作单选，而 `assignments` 合同是 many；后续真实协作场景会决定是否展示多个负责人。
2. `参与人数` 当前使用 ContentDimension 的 Markdown 载荷保存整数文本；是否需要 typed number payload 留给后续统计 UI 验证。
3. Work Package 暂无手工排序 Dimension，当前按 SlotBinding / Card 创建顺序展示；真实重排需求出现后再决定表达方式。
4. 删除已有 Task 的 Work Package 目前被阻止；未来若需要归档、迁移 Task 或保留历史，应由 Task UI 的真实操作流程决定。
5. 当前用泳道与纵向位置完成轻量布局；真实拖拽、自动布线或大型地图需求出现后，再决定是否引入专门图编辑器。
6. `GuideNodeCard.definition` 与 `resources` 已预留正式 Slot，但首版 UI 只编辑自然语言资源入口；待模板与 Artifact 管理有真实需求时再开放关联选择。
