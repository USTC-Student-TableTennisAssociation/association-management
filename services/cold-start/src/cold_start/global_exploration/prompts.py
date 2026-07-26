"""全局勘探各阶段的提示词。"""

from __future__ import annotations

import json

from cold_start.global_exploration.models import (
    DocumentMemoryLandscape,
    ExplorationBoundaryReview,
    LandscapeObservationBatch,
)
from cold_start.global_exploration.units import ReadingUnit

BASE_SYSTEM_PROMPT = """
最终目标是帮助 Echo 从乒协材料中逐步形成组织记忆。组织记忆不只包含活动指导，
也可能维持组织身份与历史连续性、支持行动和判断、保存经验教训，或提示重要知识
与证据存在于何处。

你当前只处于“全局勘探”阶段。这个阶段负责建立文档级阅读地图，回答：
- 这是一份什么文档；
- 内容大致位于哪里；
- 后续可以在哪些区域寻找哪方面的组织记忆；
- 哪些名称或主题在全文层面值得后续阅读持续留意。

本阶段不是记忆提取或记忆编译。禁止：
- 写出具体记忆正文或最小充分记忆；
- 展开名单、步骤、额度、材料、规则细节、实践细节或个别证据内容；
- 判断最终节点类型、记忆粒度或后续处理深度；
- 推测复用关系、图连线、节点合并、重复风险或未来消费者；
- 提出需要后续回答的局部编译问题。

遇到局部细节时，上收为能帮助定位后续阅读的主题。例如，看到创始名单、BBS
截图和成立日期时，只记录“协会创办与发展历史”，不要复述其中的事实。

只根据提供的原文工作；引用位置时使用“〔第 N 页〕”。所有判断都是低权威的
文档级初步观察，不得替代后续局部阅读和记忆编译。
""".strip()


def profile_prompt(
    *,
    title: str,
    unit: ReadingUnit,
    current_draft: str,
    structure_markdown: str,
) -> str:
    return f"""
[ROUTE: profile]
你沿“文档全局画像”路径从开头依次浏览文档。当前单元是{unit.page_label}。

请维护一份供后续阅读使用的简短文档画像，只保留：
- 文档是什么、为何形成、主要面向谁；
- 文档大致覆盖哪些内容领域；
- 文档自身的来源、时间背景和整体权威边界；
- 全文混合了哪些不同性质的材料，例如历史叙述、工作说明、作者经验、外部政策
  或未来设想。

不要逐章总结，不枚举具体事实、活动步骤、人员名单或候选记忆，不判断哪些内容
应该进入记忆层。将旧稿修订成可独立阅读的完整 Markdown，不要追加流水笔记。
全文尽量控制在 1200 个中文字符以内；关键判断可标注页码。

文档标题：{title}

已经形成的章节导航仅用于帮助定位，不要照抄：
{structure_markdown}

当前画像旧稿：
{current_draft or "（尚无旧稿，这是第一次浏览）"}

本次原文：
{unit.content}
""".strip()


def structure_prompt(*, title: str, unit: ReadingUnit) -> str:
    return f"""
[ROUTE: structure]
你正在快速浏览一份文档，以建立后续阅读所需的章节导航。
提供的材料汇集了全文各页检测到的标题和页面开头短预览。

请简要说明：
- 文档包含哪些主要部分和章节；
- 每个部分大致覆盖哪些页码；
- 每个部分大致讨论什么；
- 原文明示了哪些章节承接、包含或交叉引用关系。

目录和正文标题明显不一致、并且会影响后续导航时，简要指出即可。
这一步只建立粗略结构，不分析章节内部如何展开，不提取具体事实、经验、规则或
指导，不判断记忆节点和图关系。

输出自然、简洁的 Markdown，尽量控制在 1500 个中文字符以内。
只根据提供的标题和短预览判断；无法确定时保留不确定性。

文档标题：{title}

目录、标题与逐页短预览：
{unit.content}
""".strip()


def landscape_observation_prompt(
    *,
    title: str,
    unit: ReadingUnit,
    structure_markdown: str,
) -> str:
    schema = json.dumps(
        LandscapeObservationBatch.model_json_schema(),
        ensure_ascii=False,
    )
    return f"""
[ROUTE: landscape_observation]
你正在对{unit.page_label}做一次局部地形浏览。只记录本单元新出现的文档级线索，
不要总结整份文档，也不要生成记忆内容。

字段用途：
- memory_areas：这几页大致涉及哪些组织记忆方向。使用上位主题，例如“协会创办
  与发展历史”“活动体系”“行政工作”“宣传工作”“交接与传承”；coverage 只描述
  主题覆盖范围，不复述原文事实。
- global_signals：只记录标题级、反复出现、被原文明示为重要、或存在明确跨章节
  引用的名称和主题。它们只是后续阅读注意信号，不是候选节点或记忆准入判断。
- explicit_relations：只记录原文明示的章节承接、包含或交叉引用。禁止根据内容
  相似性推测复用、依赖、归属或图连线。

粒度示例：
- 原文包含 BBS 创始帖子、筹委会名单和成立日期，只输出“协会创办与发展历史”；
- 原文包含二课申请的步骤和材料，只输出“活动申报与行政工作”，可以将“二课申请”
  作为明确名称信号，但不要概括步骤或判断它是否是共享工作流；
- 原文列出某项比赛的具体做法，只输出相应活动或赛事运营主题，不提取做法。

不要为了填满数组而输出弱信号。没有明确的全局信号或明示关系时使用空数组。
保持极简。unit_pages 必须准确填写本单元页码：{list(unit.page_numbers)}。
只输出符合 Schema 的完整 JSON，不要代码围栏。

文档标题：{title}

全文章节导航，仅用于判断当前单元在文档中的位置：
{structure_markdown}

本单元原文：
{unit.content}

JSON Schema：
{schema}
""".strip()


def landscape_merge_prompt(
    *,
    title: str,
    observations: tuple[LandscapeObservationBatch, ...],
    structure_markdown: str,
) -> str:
    schema = json.dumps(DocumentMemoryLandscape.model_json_schema(), ensure_ascii=False)
    observations_json = json.dumps(
        [observation.model_dump() for observation in observations],
        ensure_ascii=False,
        indent=2,
    )
    return f"""
[ROUTE: landscape_merge]
下面是各阅读单元产生的粗略地形观察。请合并为一份精简的“文档记忆地形”，供
后续流程定位阅读区域。它不是候选记忆表，也不是记忆编译地图。

合并规则：
- 按章节和上位主题合并重叠区域、同义标签与重复页码；
- memory_areas 保持“创办历史、活动体系、行政工作”等区域级粒度；
- global_signals 只保留标题级、反复出现、原文明示重要或明确跨章节出现的信号；
- explicit_relations 只保留原文明示的章节承接、包含或交叉引用；
- 删除名单、步骤、材料、数字、规则正文、实践细节和个别证据内容；
- 删除节点类型、复用、连接、编译深度、是否进入记忆层等判断；
- 不补充局部观察和章节导航没有支持的新结论。

scope_note 只说明这份地形可以帮助定位什么、不能替代什么，最多数句话。
只输出符合 Schema 的完整 JSON，不要代码围栏。

文档标题：{title}

章节导航：
{structure_markdown}

局部地形观察：
{observations_json}

JSON Schema：
{schema}
""".strip()


def reconciliation_prompt(
    *,
    title: str,
    profile_markdown: str,
    structure_markdown: str,
    memory_landscape: DocumentMemoryLandscape,
    source_evidence: str,
) -> str:
    schema = json.dumps(
        ExplorationBoundaryReview.model_json_schema(),
        ensure_ascii=False,
    )
    return f"""
[ROUTE: reconciliation]
现在检查三份产物能否作为低权威的全局阅读地图冻结。
这不是记忆提取质量评审，也不判断它们是否已经完成局部记忆编译准备。

重点检查：
- 文档画像是否准确说明文档身份、范围、来源和整体权威边界；
- 结构导航是否覆盖主要章节，页码是否有原文依据；
- 记忆地形是否覆盖主要内容区域和真正的全文级信号；
- 三份产物是否保持文档级、区域级粒度；
- 是否错误展开了名单、步骤、规则、数字、实践或个别证据；
- 是否提前判断了节点类型、记忆准入、记忆粒度、复用、连接或局部编译问题；
- 三份产物之间是否存在明显冲突。

只有章节遗漏、页码错误、重要区域遗漏、明显事实错误或越过全局勘探边界的问题，
才应阻止冻结。可留待后续局部阅读处理的内容放入 non_blocking_notes。
发现可修复问题时，acceptable_as_global_exploration=false，并给出明确回看页码和
修订指令。只输出符合 Schema 的完整 JSON。

文档标题：{title}

文档全局画像：
{profile_markdown}

文档结构导航：
{structure_markdown}

文档记忆地形：
{memory_landscape.model_dump_json(indent=2)}

带页码的原文证据：
{source_evidence}

JSON Schema：
{schema}
""".strip()


def revision_prompt(
    *,
    route: str,
    title: str,
    current_output: str,
    issue_instructions: str,
    source_excerpt: str,
    landscape_schema: str | None = None,
) -> str:
    output_rule = (
        "输出修订后的完整文档记忆地形 JSON，不要代码围栏。"
        if route == "landscape"
        else "输出修订后的完整 Markdown，不要解释修订过程。"
    )
    schema_part = f"\nJSON Schema：\n{landscape_schema}" if landscape_schema else ""
    return f"""
[ROUTE: revision:{route}]
全局勘探边界校验要求对“{route}”产物做定向回看。
只修复证据支持的问题，保持文档级和区域级粒度，不提取记忆正文，不设计节点、
复用或图连线。
{output_rule}

文档标题：{title}

校验问题与修订指令：
{issue_instructions}

当前完整输出：
{current_output}

定向回看的完整原文：
{source_excerpt}
{schema_part}
""".strip()
