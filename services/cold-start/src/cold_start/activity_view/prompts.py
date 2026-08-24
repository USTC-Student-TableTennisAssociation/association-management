"""对象卡选择与 Assertion 业务投影提示词。"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence

BOUNDARY_PLAN_SYSTEM_PROMPT = """
你为整份基础记忆描述 `activity_operations` 业务视角的全局语义边界。这一步不逐项
生成卡片，也无权重新定义活动运营视角。下面四条线路是固定准入合同；你只识别文档中
哪些语义板块可能为它们提供材料，以及哪些板块应明确留在基础记忆或其他业务视角。

活动运营视角的核心是：一项活动是什么、属于什么可复用类型、使用哪些工作流与
工作位置、受哪些规则/原则/实践/见解约束或支持、由谁负责或参与，以及执行
所必需的审批、资金、场地、系统、渠道、文档和物资。

固定的四条线路是：
1. `activity_flow`：具体 Activity、可复用 ActivityTrait、实际使用的 Workflow，以及
   Workflow 递归包含的子 Workflow 和 WorkStep；
2. `guidance`：会直接改变具体活动或工作位置判断的 Rule、Principle、Practice、Insight；
3. `staffing`：有来源依据的人物任职、角色职责、活动或工作参与安排；
4. `organization_context`：直接改变活动授权、资源、人员容量或执行能力的组织时期背景。

第二层不要求能够立刻执行。例如预算刚性、收支边界、信息发布准确性、舆论边界、宣传
渠道选择经验，只要它会改变活动预算、发布、风险控制或渠道选择，就属于活动运营知识。
不要因为它是概括性判断、规范或经验而排除；也不要把纯组织愿景和泛泛价值口号误当成
运营指导。

不要把“可能间接影响活动”当成进入理由。尚未实施的治理改革、宏观业务架构、知识
传承、组织问题、个人经历和价值叙事通常不属于活动运营视角；尤其不得因为改革方案
描写得具体，就把未来设想当作现行 Workflow、WorkStep 或人员安排。但其中直接描述某次
活动的执行、收尾、复盘、资源约束或人员安排的具体 Assertion 仍可进入。边界应按知识
的业务作用划分，不按章节整体排除。

输入是全文 Object 的紧凑索引。`representative_assertions` 只用于识别全局语义板块，
不是后续单个 Object 的全部事实依据；后续局部阶段会读取完整 Assertion。

输出严格 JSON：
{
  "perspective_definition_markdown": "...",
  "included_areas": [{"name": "...", "description_markdown": "..."}],
  "excluded_areas": [{"name": "...", "description_markdown": "..."}],
  "boundary_rules": ["..."]
}

`included_areas` 只是材料导航，不得扩张上述四条线路。边界规则要帮助后续模型区分
“具体活动的收尾与复盘”和“宏观传承机制”、“已有人员安排”和“组织治理改革设想”。
最终只输出 JSON。
""".strip()

OBJECT_ROLE_SYSTEM_PROMPT = """
你在 `activity_operations` 业务视角中对局部 Object 做第二次语义边界判断。你必须遵守
输入的全局边界规划，同时根据当前 Object 的全部相关 Assertion 纠正局部投影过宽的
结果。你不能修改 Object 或 Assertion。

每个 Object 必须选择一种存在方式：
- `view_card`：它是活动运营中值得独立检索、连接或用于判断的节点；
- `support_reference`：它可以作为已保留 Attribute 的主体或其他 Assertion 中的必要指代，
  但不应在本视角中成为独立检索或连接节点；
- `outside_view`：它属于基础记忆或其他业务视角，不进入活动运营视角。

Object 是否成卡与关于它的 Assertion 是否保留是两个独立判断。宽泛的“经费管理”可以是
`support_reference`，同时保留关于预算刚性和收支边界的 guidance Attribute；不要因为
保留重要 Assertion 就把其主体强行设为 `view_card`。只有该 Object 本身值得作为业务图中的
独立导航或关系端点时才选择 `view_card`。只有既不成卡、也不需要承载或解释任何保留
Assertion 时才选择 `outside_view`。

“对活动可能有间接影响”不足以成为 `view_card`。去中心化、梯队建设等治理方案，隐性知识
缺失、结构指引缺位等治理问题，行政/品牌/传承支柱等宏观业务架构，以及“传承”
等抽象领域，通常应为 `outside_view`，而不是被迫分类为 Workflow、WorkStep、Organization
或 ActivityTrait。只有它们本身被来源明确用作具体活动的执行位置、规则作用点
或资源约束时，才例外进入。

`view_card` 才选择一个主要角色。前八种表达活动运营主干和组织人员：
- `organization`：持续存在的组织；
- `activity`：可被反复指认的具名活动或活动模式；
- `activity_trait`：能够传播流程、规则或实践的可复用活动分类；
- `workflow`：具有业务目标的一组连续、并行或分支工作；它可以递归包含子 Workflow；
- `work_step`：当前视角下不再作为流程展开的工作位置；
- `person`：需要在组织记忆、运营或任职关系中识别的人；
- `role`：跨届可持续存在的组织角色；
- `period`：确实被来源作为一个整体讨论的时期。

以下支撑角色允许有价值的运营知识自然进入，而不必伪装成主干节点：
- `system`：统一身份平台、Notion 等被持续操作或依赖的制度化系统；
- `funding_scheme`：项目预算、专项补贴等经费来源或安排；
- `communication_channel`：QQ群、公众号、B站账号等传播或协作渠道；
- `standard`：预算规范、报销要点、新闻稿规范等可持续引用的规范载体；
- `document`：审批单、模板、记录、清单等具名文档或档案对象；
- `venue`：场馆、教室、前台区、竞赛区等空间；
- `resource`：球台、球、奖品等物资或设备。

活动的时间、规模、对象和运行方式通常作为关于 Activity 的 Assertion，不要制造“秋季活动”或
“90人活动”等角色。`activity_trait` 只用于可复用活动类别；包含阶段、步骤或并行模块的
“项目制培养”等应优先判断为 `workflow`。渠道、场地、系统、规范和物资必须使用对应支撑
角色，不能为了接近活动主干而硬塞成 activity_trait 或 work_step。

不要用“它处于更大流程内部”作为选择 `work_step` 的理由。报销、访问权限申请、行政审批
等对象如果自身具有独立目标、多个步骤或分支，应作为可嵌套的 `workflow`；其中不可再展开
的提交、核对、审批动作才是 `work_step`。

四条业务线路是后续关系结构和检索入口：
- `activity_flow`：Activity → ActivityTrait → Workflow，Workflow 再递归包含子 Workflow
  或 WorkStep；
- `guidance`：Rule / Principle / Practice / Insight 作用于哪些运营位置和适用范围；
- `staffing`：Person、Role 与活动或工作的任职、负责和参与；
- `organization_context`：直接影响活动授权、执行能力或资源约束的 Organization、Period
  与时期背景；不是通用的组织历史、治理与价值叙事收容箱。

Object 角色描述对象本身，不负责保护前一阶段的临时投影。已有 Relation 与正确角色冲突时，
程序会在后续按照固定类型签名单独重投影关系；你不得为了保住 Relation 改变 Object 角色，
也不需要在本阶段重新校验已有 Relation。始终保持对象真实角色，不能把 Organization 改成
Workflow，或把 Venue 改成 WorkStep 来迁就关系。形成第一套完整决定后直接提交，不要反复
计算某项决定会使哪些临时投影失效；Attribute 和 Relation 的保留、删除与修复由程序在
下一阶段处理。

你不负责填写线路标签。Object 的线路由最终被接受的 Attribute 归属和 Relation 端点由
程序反推，不能根据 Object 名称自由猜测。输出严格 JSON：
{
  "decisions": [{"object_id", "status", "role", "reason"}]
}

输入中的每个 object_id 必须且只能出现一次。`view_card` 必须提供 role；其他两种状态的
role 必须为 null。最终只输出 JSON。
""".strip()

ASSERTION_PROJECTION_SYSTEM_PROMPT = """
你从基础 Object—Assertion 图出发，把 Assertion 投影到 `activity_operations` 业务视角。
当前没有预先筛选的对象卡。一条 Assertion 被保留为 Attribute 后，Attribute 的主体 Object
进入后续三态分类；它可以成为 `view_card`，也可以只是 `support_reference`，两种情况都不
影响 Attribute 保留。Assertion 明确引用的其他 Object 会作为必要指代保留，但不自动成卡。
Relation 的参与 Object 才必须在后续成为 `view_card`。不要为了“保留”次要 Object 而把
Attribute 强行改成 Relation，也不要为了让 Object 成卡而改变 Assertion 的主要语义。
你不能修改 Object 或改写 Assertion。
Relation 必须保留并引用原始 Assertion，而不是重新生成一条替代它的知识。

逐条独立判断输入 Assertion；程序负责最终的完整覆盖与去重校验，你不需要在思考中反复盘点
其他 Assertion 是否已经出现。每条 Assertion 只选择一种结果：
1. `attributes`：非联系性 Assertion，主要描述一个主体 Object；主体稍后可以成为对象卡，
   也可以只作为 support_reference 承载这条视角 Attribute；
2. `relations`：联系性 Assertion，原 Assertion 连接两个或多个对象卡；
3. `reference_review_requests`：业务投影需要一个 Assertion 当前没有引用的已有 Object；
4. `omitted_assertion_ids`：确实不能帮助活动运营检索、判断、执行、复盘、人员安排或理解
   运营条件。

这一步是局部高召回投影，后续还会进行父节点跨孩子关系恢复和四条线路各自的全局审查。
四条线路是硬准入合同，不是可随意贴上的主题标签。只有明确属于排除区域、且不具有任何
直接活动运营作用的 Assertion 才省略；
语义交叉或暂时无法确定边界时，应先保留为候选，不在本阶段过早删除。

省略判断以 Assertion 的业务作用和输入的全局边界规划为准，而不是以 Object 看起来是否
像活动主干为准。预算与
报销规范、审批制度、渠道运营、场地和物资保障、培训与传承做法都可以是重要运营知识；不得
仅因主体是规范、系统、渠道、文档、场地或资源就省略。反之，无关 Object 不会因为在基础层
存在就自动进入；被保留投影实际使用也只意味着进入三态判断，不意味着必然形成卡片。

组织历史、个人经历、宏观业务支柱、去中心化、梯队建设、组织知识传承缺陷和治理改革设想，
不能仅因为“可能间接影响活动”就进入。但某条 Assertion 若直接描述一次活动的执行、
收尾、复盘、资源约束或人员安排，则应按具体业务作用保留，不得因所在章节而整体排除。
尚未实施的方案即使写出了岗位、模块或流程，也仍是 insight，不得伪装成现行 Workflow、
WorkStep、职责或依赖关系；除非它本身对当前活动决策具有直接参考价值，否则应省略。

活动运营知识不等于“立即可执行的步骤”。只要一条 Rule、Principle、Practice 或 Insight
会稳定改变活动的预算、审批、场地、物资、人员、传播、风险控制、收尾或复盘判断，就应
作为运营指导保留。诸如信息必须准确、公开交流不得越过舆论红线、某类宣传渠道仍有独特
曝光价值等，都可能直接影响运营决策。仅表达组织愿景、历史评价或治理哲学，且不能指出
任何具体运营判断影响的内容，才应省略。

正常情况下直接使用基础 Assertion 引用。只有待投影 Assertion 的
`possible_missing_object_references` 明确列出候选，并且缺少该 Object 会使你无法形成有依据的
Attribute 或 Relation 时，才请求引用复查。不能自行填写候选之外的 Object，也不能因为名称
相似、同章出现或想建立更多连接而请求。请求复查不是确认引用，程序会另行核对 Evidence。

Attribute 不选择固定字段槽位。它只确定原始 Assertion 的主体 Object、服务哪些线路以及
叙述性质。主体 Object 后续可以是 `view_card` 或 `support_reference`；该 Assertion 明确引用
的其他 Object 作为必要指代保留，不需要成为 Relation 参与者，也不需要分别再生成
Attribute。不要把一个完整 Assertion 拆写成新字段，也不要补写原文没有的内容。

Assertion 的 `semantic_kind` 表示叙述性质：
- `fact`：来源记录的身份、状态、事件或结果；
- `rule`：制度要求、禁止事项或行为边界；
- `principle`：不形成硬门槛但稳定影响判断的原则；
- `practice`：过去在特定情境中实际采用的做法，不自动等于建议；
- `insight`：个人或组织的解释、评价、反思或方案。

基础 Assertion 的 `mode=record/viewpoint` 只描述来源采用事实记录还是观点表达，不是这里的
业务语义分类，也不约束 `semantic_kind`。不要比较两者或为了服从 mode 改变分类：例如
“某环节最容易出错”属于 `insight`，即使基础 mode 是 `record`；正式的必须、禁止和资格
边界属于 `rule`，不能因为来源把它作为记录写下就归为 `fact`。

Relation 的 `relation_pattern` 必须由四条业务线路推导，并使用相应参与者角色：

一、`activity_flow` 活动运营主线
- `classification`：活动或工作对象归入可复用分类；参与者用 `subject`、`category`；
- `workflow_use`：活动或活动特征使用 Workflow；用 `workflow_user`、`workflow`；
- `composition`：Workflow 包含子 Workflow 或 WorkStep；用 `whole`、`part`；
- `sequence`：工作位置有明确先后；用 `previous`、`next`；
- `dependency`：工作位置有明确依赖；用 `dependent`、`dependency`。

二、`guidance` 指导支线
- `guidance_application`：Rule、Principle、Practice 或 Insight 作用于某运营位置，并可带适用
  范围；参与者用 `anchor` 表示 Workflow/WorkStep 等作用位置，用 `scope` 表示组织、活动
  特征或具体活动。只有一个作用对象、没有需要表达的范围关系时，应作为该对象的 Attribute。

三、`staffing` 人员安排主线
- `role_holding`：人物担任角色；用 `person`、`role`；
- `responsibility`：人物或角色负责活动、Workflow 或 WorkStep；用 `responsible_party`、
  `responsibility_target`；
- `participation`：人物或角色参与活动或工作；用 `participant`、`participation_target`。

四、`organization_context` 组织背景线
- `contextualization`：Organization 或 Period 为活动、工作或状态提供有来源支持的背景；用
  `context`、`contextualized_object`。单纯的组织状态应作为 Organization/Period 的 Attribute，
  不要为了形成连接而把所有背景强行连向活动。

每种 relation_pattern 必须包含对应的主线路标签；若原 Assertion 确实同时服务其他线路，
可以增加其他 lane_tags。Attribute 所属 Object 和关系参与者必须由该 Assertion 明确引用。
`direct_source` 表示来源直接陈述关系；`perspective_interpretation` 只允许
把同一条 Assertion 已经表达的关系无损规范化为上述线路结构。它不允许连接两条分别成立
的 Assertion，也不允许根据共同数据、互相帮助、同章出现、名称相近或常识形成新关系。
四条线路只规定合法关系空间，不是建立关系的证据。Relation 的确切谓词和全部参与者必须
由当前这一条 Assertion 直接支持；否则保留为 Attribute 或省略，不能为了图更连通而推测。

输出严格 JSON：
{
  "attributes": [{
    "assertion_id", "object_id", "semantic_kind", "lane_tags", "reason"
  }],
  "relations": [{
    "assertion_id", "relation_pattern",
    "participants": [{"object_id", "role"}],
    "semantic_kind", "lane_tags", "derivation_kind", "reason"
  }],
  "reference_review_requests": [{
    "assertion_id", "candidate_object_ids", "intended_projection", "reason"
  }],
  "omitted_assertion_ids": ["..."]
}

按输入顺序逐条决定即可；不要检查次要 Object 是否成卡，也不要为了保留 Object 制造关系。
输入中的每个 assertion_id 必须且只能出现一次。最终只输出 JSON。
""".strip()

REFERENCE_REVIEW_SYSTEM_PROMPT = """
你独立复查业务视角提出的 Assertion Object 引用补全请求。引用完整性属于基础记忆；业务
需求只解释为什么发现问题，不能成为确认依据。唯一事实依据是输入中的原始 Assertion、已有
Object、候选 Object 和该 Assertion 的 Evidence 原文。

逐个候选选择一种结果：
- `confirmed_object_ids`：Evidence 中该名称确实指向这个已有 Object，并且它是命题参与者；
- `rejected_object_ids`：只是普通词、名称相似、同章共现，或不是该命题参与者；
- `ambiguous_object_ids`：可能指向候选，但同名或上下文不足，不能可靠消歧。

三个数组必须完整覆盖全部候选，不能遗漏或越界。若存在 confirmed，提交完整修订后的
`revised_statement_template_markdown`：只把原模板中指向确认 Object 的字面名称替换为
`{{object:对象ID}}`，原有对象引用必须保留，其他文字、条件、否定和语气不得改变。若没有
confirmed，该字段必须为 null。不要创建 Object、修改 mode/时间/观点持有者/Evidence，
也不要建立业务 Relation。

输出严格 JSON：
{
  "assertion_id": "...",
  "confirmed_object_ids": ["..."],
  "rejected_object_ids": ["..."],
  "ambiguous_object_ids": ["..."],
  "revised_statement_template_markdown": "...或null",
  "reason": "..."
}

最终只输出 JSON。
""".strip()

PARENT_SYNTHESIS_SYSTEM_PROMPT = """
你不是知识合成器，而是活动运营视角中的“父节点跨区域关系恢复器”。局部孩子已经完成
Object、Attribute 和 Relation 投影；你只恢复因为连续原文切分而没有在单个孩子中显现、
但来源已经表达的关系。不得发现新联系、补充业务常识或把合理联想固化为长期记忆。

四条线路只定义关系可以存在的语义空间，不构成关系证据。每项候选必须同时满足：
1. 确切关系属于一条固定业务线路；
2. 参与 Object 的业务角色符合该关系；
3. `proof_evidence_ids` 对关系谓词本身提供桥接证明，而不只是分别证明两个端点存在。

只允许三种 `proof_kind`：
- `direct_statement`：Evidence 原文直接陈述全部参与者之间的确切关系；
- `structural_recovery`：原始标题、编号或连续层级明确表达组成、分类或工作流使用关系；
- `necessary_normalization`：原文虽未使用关系名，但“必须先”“否则无法”“只有……才能”
  等条件逻辑必然推出该关系。

`structural_recovery` 只允许 classification、workflow_use、composition，不能用文档并列或
父节点 introduction 单独证明 dependency、sequence、guidance、staffing 或组织影响。
dependency 必须由明确必要条件支持；共同使用数据、可能提供帮助、同属一个父节点或按
常识需要协作，都不构成依赖。sequence 必须有明确先后标记，不能使用文档顺序代替。

`supporting_assertion_ids` 保留端点和局部知识来源；`proof_evidence_ids` 必须来自这些
Assertion，并直接支持桥接谓词；`supporting_child_node_ids` 必须至少覆盖两个直接孩子。
关系还必须提交 `temporal_scope` 和 `temporal_basis_markdown`：只能综合支撑 Assertion 已有
时间；来源时间不一致时使用 `unknown` 并说明，不能任选一条冒充整体时间。

仍然只允许四条固定业务线路及其关系类型：
- activity_flow：classification、workflow_use、composition、sequence、dependency；
- guidance：guidance_application；
- staffing：role_holding、responsibility、participation；
- organization_context：contextualization。

每种关系的参与者槽位和 Object 角色是固定协议，不得发明 `platform`、`required_system`
等新槽位，也不得仅凭关系名称猜测用法：
- `classification`：`subject`=activity，`category`=activity_trait；
- `workflow_use`：`workflow_user`=activity/activity_trait，`workflow`=workflow。它只表达
  “活动或活动特征使用工作流”，不能表达 Workflow 使用 System；
- `composition`：`whole`=workflow，`part`=workflow/work_step，可有多个 `part`；
- `sequence`：`previous`、`next` 都只能是 workflow/work_step；
- `dependency`：`dependent`=workflow/work_step，`dependency` 可为 workflow、work_step、
  system、document、venue、resource、funding_scheme；Workflow 必须使用某个 System 时用它；
- `guidance_application`：`anchor`=workflow/work_step，
  `scope`=organization/activity/activity_trait；
- `role_holding`：`person`=person，`role`=role；
- `responsibility`：`responsible_party`=person/role，
  `responsibility_target`=activity/workflow/work_step；
- `participation`：一个或多个 `participant`=person/role，
  `participation_target`=activity/workflow/work_step；
- `contextualization`：`context`=organization/period，
  `contextualized_object`=activity/workflow/work_step。

证明约束也必须显式区分：
- `direct_statement` 必须至少有一条 supporting Assertion 同时引用全部关系端点；
- `necessary_normalization` 允许多个原子 Assertion 联合覆盖端点，因为父节点的职责正是
  恢复被切分隐藏的联系；但 proof Evidence 必须明确出现“必须”“否则无法”“只有……才”
  等足以推出该关系的条件逻辑，不能只把分别介绍两个 Object 的材料拼在一起；
- `structural_recovery` 继续只允许 classification、workflow_use、composition。

如果来源表达了有价值的联系，但固定协议没有可用的关系类型或证据仍不足，应输出 issue，
不得改造 Object 角色、发明参与者槽位或勉强套入相近关系。

输入中的 `source_issues` 是已经发现的原文或解析异常。候选证明触及相关 block 时，不能
自行消解；应写入 `source_conflict`。父节点介绍与 Evidence 不一致、来源数量或模块数量
矛盾、缺少中间 Workflow Object、看起来相关但桥接证据不足时，写入 issues。不要输出同一
孩子内部已有关系，不要把章节并列误当业务依赖，也不要把改革设想恢复成现行流程。

输出严格 JSON：
{
  "relations": [{
    "relation_pattern": "...",
    "participants": [{"object_id": "...", "role": "..."}],
    "semantic_kind": "fact|rule|principle|practice|insight",
    "lane_tags": ["..."],
    "proof_kind": "direct_statement|structural_recovery|necessary_normalization",
    "supporting_assertion_ids": ["..."],
    "proof_evidence_ids": ["..."],
    "supporting_child_node_ids": ["..."],
    "temporal_scope": {
      "kind": "point|range|open_range|general|unknown",
      "display": "...", "start": null, "end": null,
      "precision": "day|month|semester|academic_year|year|unspecified"
    },
    "temporal_basis_markdown": "...",
    "reason": "..."
  }],
  "issues": [{
    "issue_key": "稳定简短标识",
    "kind": "insufficient_support",
    "affected_object_ids": ["..."],
    "affected_assertion_ids": ["..."],
    "reason": "..."
  }]
}
最终只输出 JSON。
""".strip()

GLOBAL_LANE_REVIEW_SYSTEM_PROMPTS = {
    "activity_flow": """
你是活动运营视角的 activity_flow 全局审查器。你看到程序为本线路筛出的候选 Object—Assertion
子图、
当前投影和父节点恢复关系。只按这条硬合同审查：具名 Activity 通过 classification 连接可
复用 ActivityTrait，再通过 workflow_use 连接实际使用的 Workflow；Workflow 通过
composition、sequence、dependency 组织 WorkStep 或子 Workflow。

检查活动、特征、工作流和步骤是否被错误孤立，现行结构是否被误删，以及抽象治理概念、
改革设想、宏观支柱是否被伪装成活动主干。只有来源或父级结构证据足够时才提出变更。
审查父级候选时，composition 的整体必须是 Workflow；dependency 必须有明确前置、必要条件
或“否则无法”的桥接 Evidence。共同数据、可能帮助和同章共现一律 reject。
""",
    "guidance": """
你是活动运营视角的 guidance 全局审查器。只保留会直接改变具体活动、Workflow 或 WorkStep
判断的 Rule、Principle、Practice、Insight，包括审批、预算、报销、场地、物资、传播、
风险、收尾和复盘。它可以是以 view_card/support_reference 为主体的 Attribute，也可以通过
guidance_application 表达作用位置和范围。

检查重要操作规范是否被省略、指导是否挂错作用点；排除只有组织愿景、宏观治理或未来改革
价值判断而没有具体运营作用点的内容。不要因为一句话听起来有启发就纳入。
父级候选只有在 Evidence 明确给出指导作用位置与适用范围时才能 accept；不得跨活动类别
自行传播经验。
""",
    "staffing": """
你是活动运营视角的 staffing 全局审查器。只审查有来源依据的历史或实际任职、职责、负责与
参与安排，对应 role_holding、responsibility、participation。人员容量只有直接影响活动执行
能力时才作为组织背景被其他线路处理。

检查人物、角色和工作对象是否连错；排除未来改革中拟议的岗位开放、赋权、梯队或泛泛人才
培养设想，不得把“建议谁来做”当作已经存在的安排。
父级候选必须由 Evidence 直接说明任职、负责或参与；熟悉、协助、撰写相关内容都不能推成
职责。
""",
    "organization_context": """
你是活动运营视角的 organization_context 全局审查器。这条线只保留直接改变活动授权、经费
资源、人员容量或执行能力的 Organization、Period 和状态背景；关系使用 contextualization，
纯状态可作为相应对象卡属性。

检查必要的时期约束是否缺失；排除组织通史、荣誉、个人经历、一般治理问题、价值叙事和
改革愿景。不能用“可能间接影响活动”作为纳入理由。
父级候选必须由 Evidence 明确说明组织或时期状态改变了活动授权、资源、人员容量或执行
能力；两个对象处于相同时空不构成 contextualization。
""",
}

GLOBAL_LANE_REVIEW_PROTOCOL = """
父级恢复结果仍是候选，不会因为模型已经输出就自动进入正式图。对于当前线路负责准入的
每个候选，必须在 `parent_candidate_admissions` 中明确选择：
- `accept`：线路、参与者类型和桥接 Evidence 都支持确切关系；
- `reject`：只是相关性、帮助关系、同章共现、常识推测、错误类型迁就或与来源警告冲突；
- `unresolved`：来源确有歧义，当前不能安全接受。

只有 relation_pattern 的固定主线路负责该候选准入；其他线路不得重复判断。接受不是检查
JSON 是否完整，而是独立检查证据是否推出关系谓词。端点分别有来源，不等于端点之间有
关系。除了候选准入，你只输出相对当前直接投影的最小差异，不复述正确项目：
- add_lane：基础 Assertion 当前未进入本线路，但满足本线路硬合同；
- remove_lane：基础 Assertion 当前进入本线路，但违反硬合同；
- reproject：知识应留在线路中，但属性归属、关系类型或端点明显错误。

changes 只修复基础 Assertion，target_kind 固定为 assertion，target_id 必须是基础
assertion_id。父级候选只能通过 parent_candidate_admissions 准入，不得再放入 changes。
若缺少 Object、Evidence 或结构依据，不能直接修复，应放入 unresolved_issues。不要建议
创建新 Object，也不要扩张线路定义。

输出严格 JSON：
{
  "lane": "当前线路",
  "parent_candidate_admissions": [{
    "candidate_id": "parent-relation:...",
    "status": "accept|reject|unresolved",
    "reason": "..."
  }],
  "changes": [{
    "target_kind": "assertion|parent_relation",
    "target_id": "...",
    "action": "add_lane|remove_lane|reproject",
    "reason": "..."
  }],
  "unresolved_issues": [{
    "issue_key": "稳定简短标识",
    "affected_object_ids": ["..."],
    "affected_assertion_ids": ["..."],
    "reason": "..."
  }]
}
最终只输出 JSON。
""".strip()

TARGETED_REPAIR_SYSTEM_PROMPT = """
你只修复四条全局线路审查点名的基础 Assertion 投影。每条输入都有当前投影和具体变更要求；
不得顺手重做其他 Assertion，不得创建 Object 或改写基础 Assertion。

`add_lane` 要求修复后投影包含指定线路；`remove_lane` 要求不再包含指定线路，如果没有其他
线路用途可以省略整条 Assertion；`reproject` 要求保留满足硬合同的知识，但纠正属性主体、
关系类型或端点。Attribute 主体可以是 view_card 或 support_reference；Relation 端点必须
全部是 view_card。若固定
对象边界使请求无法有依据地完成，可以省略并让问题留到 unresolved，不得编造关系。

这里的 Attribute 只是“基础 Assertion 在视角中的归属决定”，不复制或改写正文。准确字段只有：
{
  "assertion_id": "基础 Assertion ID",
  "object_id": "该 Assertion 已明确引用的主体 Object ID",
  "semantic_kind": "fact|rule|principle|practice|insight",
  "lane_tags": ["activity_flow|guidance|staffing|organization_context"],
  "reason": "为什么这样重投影"
}
不得输出 `projection_kind`、`subject_object_id`、`attribute_type`、`content_markdown`、
`attribute_content_markdown` 或 `derivation_kind` 等 Attribute 字段。

Relation 的准确字段只有：
{
  "assertion_id": "基础 Assertion ID",
  "relation_pattern": "固定关系类型",
  "participants": [{"object_id": "...", "role": "固定参与者槽位"}],
  "semantic_kind": "fact|rule|principle|practice|insight",
  "lane_tags": ["..."],
  "derivation_kind": "direct_source|perspective_interpretation",
  "reason": "为什么这样重投影"
}
关系模式、参与者槽位和线路必须继续遵守初始 Assertion 投影协议。若一条原关系因 Object
角色不合法，但原命题仍是关于其中一个 Object 的完整运营知识，应优先改成上述 Attribute；
例如 Organization→Organization 的 contextualization 不得保留为关系，可将原 Assertion
作为其中一个已引用 Organization 的 fact Attribute，而不是发明新的关系或字段。

输出顶层严格为：
{
  "attributes": [],
  "relations": [],
  "reference_review_requests": [],
  "omitted_assertion_ids": []
}
输入中的每个 assertion_id 必须且只能在这四处出现一次。不得再次请求引用复查。
最终只输出 JSON。
""".strip()


def object_role_prompt(
    *,
    document_context: str,
    boundary_plan: Mapping[str, object],
    lineage: str,
    region_label: str,
    objects: Sequence[Mapping[str, object]],
    assertions: Sequence[Mapping[str, object]],
) -> str:
    return f"""
[STAGE: classify_projected_activity_operation_objects]

文档背景（只帮助理解来源）：
{document_context}

全局活动运营视角边界：
{json.dumps(dict(boundary_plan), ensure_ascii=False, indent=2)}

当前父级语义区域：
{lineage}

区域名称：{region_label}

局部高召回投影使用的候选 Object；每项 assertion_ids 指向下方紧凑但完整覆盖的相关
Assertion：
{json.dumps(list(objects), ensure_ascii=False, indent=2)}

本组 Object 涉及的全部 Assertion（每条只出现一次；本阶段只用来理解 Object，不重新判断
Assertion 的投影结果）：
{json.dumps(list(assertions), ensure_ascii=False, indent=2)}

对每个 Object 选择 view_card、support_reference 或 outside_view。这是对局部高召回结果的
第二次语义边界校正。你看不到也不需要保护前一阶段的临时 Attribute 或 Relation；
support_reference 可以继续承载有价值的 Attribute，因此不要因为担心 Assertion 丢失而
把宽泛 Object 强行变成卡。
""".strip()


def assertion_projection_prompt(
    *,
    document_context: str,
    boundary_plan: Mapping[str, object],
    lineage: str,
    region_label: str,
    referenced_objects: Sequence[Mapping[str, object]],
    assertions: Sequence[Mapping[str, object]],
) -> str:
    return f"""
[STAGE: project_activity_operation_assertions]

文档背景（只帮助理解来源）：
{document_context}

全局活动运营视角边界：
{json.dumps(dict(boundary_plan), ensure_ascii=False, indent=2)}

当前父级语义区域：
{lineage}

区域名称：{region_label}

本组 Assertion 图涉及的基础 Object（尚未做卡片筛选）：
{json.dumps(list(referenced_objects), ensure_ascii=False, indent=2)}

待投影 Assertion：
{json.dumps(list(assertions), ensure_ascii=False, indent=2)}

`graph_component_id` 来自共享 Object 的确定性连通分量：相同值表示这些 Assertion 经由 Object
处于同一个局部图；不同值只是为了并行效率被装入同一次调用，不表示彼此存在业务联系。

对每条 Assertion 只选择属性、关系、引用复查或省略。只要 Assertion 被保留为属性或关系，
它明确引用的全部 Object 都会自动进入后续对象卡分类；Attribute 的单个 `object_id` 只表示
主要归属，不表示其他引用 Object 被删除。关系是原始 Assertion 在线路中的结构化投影，
Rule、Principle、Practice、Insight 只是 semantic_kind。
""".strip()


def boundary_plan_prompt(
    *,
    document_context: str,
    object_inventory: Sequence[Mapping[str, object]],
) -> str:
    return f"""
[STAGE: plan_activity_operations_semantic_boundary]

文档背景：
{document_context}

全文 Object 紧凑索引：
{json.dumps(list(object_inventory), ensure_ascii=False, indent=2)}

请先从全局识别这份文档包含的语义板块，再定义活动运营视角的边界。不要逐项输出
Object 去留；后续局部阶段会根据此边界和完整 Assertion 作具体决定。
""".strip()


def reference_review_prompt(
    *,
    document_context: str,
    lineage: str,
    region_label: str,
    request: Mapping[str, object],
    assertion: Mapping[str, object],
    candidate_objects: Sequence[Mapping[str, object]],
    evidence_markdown: str,
) -> str:
    return f"""
[STAGE: review_assertion_object_reference]

文档背景（低权威，只用于简称消歧）：
{document_context}

当前语义区域：
{lineage}

区域名称：{region_label}

业务视角提出的请求（不是事实依据）：
{json.dumps(dict(request), ensure_ascii=False, indent=2)}

原始 Assertion：
{json.dumps(dict(assertion), ensure_ascii=False, indent=2)}

候选 Object：
{json.dumps(list(candidate_objects), ensure_ascii=False, indent=2)}

Assertion 的 Evidence 原文：
{evidence_markdown}

只判断基础引用是否漏标，并按系统协议输出完整 JSON。
""".strip()


def resolved_assertion_projection_prompt(
    *,
    document_context: str,
    boundary_plan: Mapping[str, object],
    lineage: str,
    region_label: str,
    referenced_objects: Sequence[Mapping[str, object]],
    assertion: Mapping[str, object],
    review: Mapping[str, object],
) -> str:
    return f"""
[STAGE: reproject_reviewed_assertion]

文档背景：
{document_context}

全局活动运营视角边界：
{json.dumps(dict(boundary_plan), ensure_ascii=False, indent=2)}

当前语义区域：
{lineage}

区域名称：{region_label}

引用复查后该 Assertion 涉及的基础 Object：
{json.dumps(list(referenced_objects), ensure_ascii=False, indent=2)}

引用复查后的 Assertion：
{json.dumps(dict(assertion), ensure_ascii=False, indent=2)}

引用复查结论：
{json.dumps(dict(review), ensure_ascii=False, indent=2)}

现在只处理这一条 Assertion。必须将它投影为 attribute、relation 或 omitted；不得再次输出
reference_review_requests，也不得使用复查未确认的 Object。输出完整 Assertion 投影 JSON。
""".strip()


def parent_synthesis_prompt(
    *,
    document_context: str,
    lineage: str,
    parent: Mapping[str, object],
    child_branches: Sequence[Mapping[str, object]],
    existing_relations: Sequence[Mapping[str, object]],
    evidence_rows: Sequence[Mapping[str, object]],
    source_issues: Sequence[Mapping[str, object]],
    previous_feedback: Sequence[Mapping[str, object]],
) -> str:
    return f"""
[STAGE: recover_parent_activity_relations]

文档背景（只帮助理解来源）：
{document_context}

从根到当前父节点的结构上下文：
{lineage}

当前父节点及自有投影：
{json.dumps(dict(parent), ensure_ascii=False, indent=2)}

直接孩子分支；每个分支只给出该子树当前保留的卡片和投影摘要：
{json.dumps(list(child_branches), ensure_ascii=False, indent=2)}

当前已经存在的关系，禁止重复生成：
{json.dumps(list(existing_relations), ensure_ascii=False, indent=2)}

本次可引用的 Assertion Evidence 原文；proof_evidence_ids 只能从这里选择：
{json.dumps(list(evidence_rows), ensure_ascii=False, indent=2)}

与当前区域相关的来源解析或原文一致性警告：
{json.dumps(list(source_issues), ensure_ascii=False, indent=2)}

上一轮全局复核对本父节点关系的反馈：
{json.dumps(list(previous_feedback), ensure_ascii=False, indent=2)}

只输出来源已经表达、但被切分隐藏的跨孩子关系候选，或无法安全恢复的问题。
""".strip()


def global_lane_review_prompt(
    *,
    lane: str,
    document_context: str,
    boundary_plan: Mapping[str, object],
    objects: Sequence[Mapping[str, object]],
    assertions: Sequence[Mapping[str, object]],
    attributes: Sequence[Mapping[str, object]],
    relations: Sequence[Mapping[str, object]],
    parent_candidate_evidence: Sequence[Mapping[str, object]],
    parent_issues: Sequence[Mapping[str, object]],
    round_index: int,
) -> str:
    return f"""
[STAGE: review_activity_lane]

复核轮次：{round_index}
当前唯一审查线路：{lane}

文档背景：
{document_context}

材料导航边界（不能覆盖系统中的硬线路合同）：
{json.dumps(dict(boundary_plan), ensure_ascii=False, indent=2)}

当前对象卡（lane_tags 已由被接受投影反推）：
{json.dumps(list(objects), ensure_ascii=False, indent=2)}

本线路候选基础 Assertion 子图：
{json.dumps(list(assertions), ensure_ascii=False, indent=2)}

当前 Attribute 投影：
{json.dumps(list(attributes), ensure_ascii=False, indent=2)}

当前直接关系与父节点恢复关系：
{json.dumps(list(relations), ensure_ascii=False, indent=2)}

当前父级恢复候选的桥接 Evidence 原文与来源警告：
{json.dumps(list(parent_candidate_evidence), ensure_ascii=False, indent=2)}

父节点发现但尚不能安全修复的问题：
{json.dumps(list(parent_issues), ensure_ascii=False, indent=2)}

程序已经保留当前属于本线路的投影、父级候选及按角色和语言信号召回的潜在遗漏。
只审查输入中的候选，不要猜测候选之外还有什么，也不要因为这里只是子图而扩大判断范围。
只按 {lane} 的硬合同输出最小差异。没有变更时 changes 必须为空数组。
""".strip()


def targeted_repair_prompt(
    *,
    document_context: str,
    boundary_plan: Mapping[str, object],
    object_decisions: Sequence[Mapping[str, object]],
    assertions: Sequence[Mapping[str, object]],
    current_projections: Sequence[Mapping[str, object]],
    review_changes: Sequence[Mapping[str, object]],
) -> str:
    return f"""
[STAGE: repair_global_lane_issues]

文档背景：
{document_context}

全局材料导航边界：
{json.dumps(dict(boundary_plan), ensure_ascii=False, indent=2)}

相关 Object 的冻结三态和角色：
{json.dumps(list(object_decisions), ensure_ascii=False, indent=2)}

只允许修复的基础 Assertion：
{json.dumps(list(assertions), ensure_ascii=False, indent=2)}

这些 Assertion 当前的投影；缺失表示当前省略：
{json.dumps(list(current_projections), ensure_ascii=False, indent=2)}

四条线路审查合并后的定向要求：
{json.dumps(list(review_changes), ensure_ascii=False, indent=2)}

每条输入 Assertion 必须且只能输出为 Attribute、Relation 或 omitted。不得请求引用复查。
""".strip()


def repair_prompt(error: Exception, output_name: str) -> str:
    return f"""
上一份{output_name}没有通过上方已经公开的固定协议校验：
{error}

只修复校验指出的问题，保持有依据的业务判断。重新输出一份完整合法 JSON，不解释。
""".strip()
