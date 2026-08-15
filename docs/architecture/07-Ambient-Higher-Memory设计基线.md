# Ambient Higher Memory 设计基线

> 状态：第一版实现基线
> 记录日期：2026-08-15
> 范围：Echo 每轮对话无需先搜索即可读取的高层环境认知，以及它与 Object Higher Memory、Business View 和成员记忆的边界。

## 1. 核心判断

Echo 是一个在真实互动与实践中逐步形成理解的智能体。基础系统提示不预设当前环境是高校社团、企业、实验室或任何其他固定类型。

开发者不再通过 `organization.md` 预写“这个环境是什么”。Echo 在真实对话中使用用户陈述、实际读取过的 Business View、Object Higher Memory 与检索结果，形成自己的高层环境认知。

Ambient Higher Memory 的目标是“快速进入状态”，不是取代精确业务状态。

## 2. Higher Memory Scope

```text
Higher Memory
├── workspace
│   └── 当前环境是什么、长期在做什么、Echo 在其中做什么
├── recent
│   └── 近期共同工作、阶段焦点、风险与未结方向
└── object
    └── 具体 GlobalObject 的高层认知，包括 Person Object
```

`workspace` 和 `recent` 不绑定 GlobalObject，也不绑定 cold-start Compilation。来源重编译不应使 Echo 丧失已经从真实互动中形成的环境理解。

## 3. 成员边界

某个成员的经历、角色、偏好、性格、忙碌程度或个人工作摘要，应进入该 Person GlobalObject 的 Object Higher Memory，不进入 `workspace` 或 `recent`。

第一版没有成员登录与当前账号映射，因此 Ambient Higher Memory 不推断正在对话的用户是某个成员。未来登录系统可以将当前账号映射到 Person Object，再按明确身份自动加载对应 Object Higher Memory。

## 4. 第一版触发机制

第一版仅使用聊天触发，与已有 Object Higher Memory 统一。主回答模型在每轮对话中至多调用一次 `queueHigherMemoryMaintenance`，一次可以选择多个 scope：

```json
{
  "targets": [
    { "scope": "workspace" },
    { "scope": "recent" },
    { "scope": "object", "globalObjectId": "..." }
  ],
  "reason": "本轮形成了值得延续的高层理解"
}
```

固定后台顺序为：

```text
主对话完成
→ Chat → Assertion 完整结束
→ Object / Ambient Higher Memory 按 scope 维护
→ 下一轮自动加载 workspace + recent
```

当前轮无需等待新 Higher Memory，因为新信息已经存在当前对话上下文中。后台维护供下一轮及以后的对话使用。

## 5. 维护合同

Object Higher Memory 仍然基于 grounded Assertion 重建，并可以主动下钻搜索。

Ambient Higher Memory 优先效率和高层连续性：

- 直接综合用户的真实陈述；
- 使用主对话实际读取过的 Business View、Object Higher Memory 和检索结果；
- 不为了逐句确定性而重复搜索；
- 允许保留“似乎”“近期主要”“尚需确认”等不确定性；
- 不持久化逐句 Assertion 索引或来源列表；
- 如果本轮不足以生成更有用的版本，保留旧记忆。

## 6. 与 Business View 的关系

Ambient Higher Memory 用于高效定向；Business View 用于可靠的精确当前状态和实际动作。

每轮自动加载的 Ambient Higher Memory 必须附带 `maintainedAt`。当用户询问精确当前状态、要求来源或准备执行动作时，主对话应读取 Business View 或按需检索，不应将 Ambient Higher Memory 当作权威状态。

## 7. 第一版明确限制

- 首次冷启动没有 Ambient Higher Memory，Echo 需要在首次实质性对话中搜索、阅读 Business View 或根据用户陈述形成第一版理解。
- 直接在 UI 修改 Business View 不会触发 Ambient Higher Memory 维护；直到后续聊天涉及该变化前，高层记忆可能滞后。
- 未来可以将 Business View 修改事件接入同一维护队列；这是新触发来源，不是第二套记忆机制。
