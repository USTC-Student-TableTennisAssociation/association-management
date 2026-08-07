"""父节点完成语义对齐后，独立发现并复查基础层缺失 Object。"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

from cold_start.compilation.leaf import MAX_PROTOCOL_REPAIRS
from cold_start.compilation.models import (
    MemoryPackage,
    MissingObjectDiscoveryOutput,
    MissingObjectRecoveryArtifact,
    MissingObjectReviewOutput,
)
from cold_start.compilation.operations import apply_missing_object_reviews
from cold_start.llm.base import ChatModel, ModelTurn
from cold_start.progress import NullProgressReporter, ProgressReporter

OutputModel = TypeVar("OutputModel", bound=BaseModel)

MISSING_OBJECT_DISCOVERY_SYSTEM_PROMPT = """
你在基础 Object—Assertion—Evidence 编译中执行独立的“缺失 Object 发现”。父节点已经完成
已有 Object 的合并和 Assertion 修订；本阶段不重做这些工作。

Object 是来源中可以被持续指认，并值得让多条 Assertion 共同引用的对象。它不限于活动、
人物或流程，也可以是明确命名的表单、清单、档案、文件、系统、场地、资源、组织角色、
工作事项或概念。是否进入某个业务视角不是本阶段的判断标准。

只报告同时满足以下条件的候选：
1. 原文和现有 Assertion 已明确出现该对象的名称；不能从业务常识推导；
2. 它目前仍以字面文本出现在 Assertion 中，没有对应的已有 Object 引用；
3. 它是可重复指认的端点，而不是动作、属性值、普通修饰语、章节概括或临时代理；
4. 把该字面名称改为 Object 引用不会增加、删除或改写原命题；
5. 输入中的已有 Object 及其 aliases 不能表达它。

不要创建 Assertion、Relation、业务卡片或分类，不要用更大的代理 Object 代替真实端点。
`bindings` 精确列出要替换的 Assertion ID 与字面值；第一版要求 `literal_surface` 与
`proposed_label` 完全相同。`proof_evidence_ids` 必须来自这些 Assertion 自己的 Evidence。

输出唯一 JSON 对象：
{
  "candidates": [
    {
      "candidate_id": "candidate-1",
      "proposed_label": "签领表",
      "proposed_aliases": [],
      "supporting_assertion_ids": ["region-0001/assert-1"],
      "proof_evidence_ids": ["region-0001/evidence-1"],
      "bindings": [
        {"assertion_id": "region-0001/assert-1", "literal_surface": "签领表"}
      ],
      "reason": "原文把签领表作为可反复指认的文件，现有 Assertion 仍使用字面名称。"
    }
  ]
}
没有可靠候选时输出 {"candidates": []}。不得增加其他字段或 Markdown 围栏。
""".strip()

MISSING_OBJECT_REVIEW_SYSTEM_PROMPT = """
你是独立 Evidence 复查者。发现阶段提出了基础层缺失 Object 候选，你必须逐项作出
`accept`、`reject` 或 `defer`，不能因为候选看起来有业务价值就接受。

accept 必须同时确认：
- Evidence 原文明确出现候选名称，并把它当作可持续指认的对象；
- 它不同于全部已有 Object，而不是同义词、属性值、动作或章节概括；
- 每个绑定位置确实指向该对象；
- 绑定只把完全相同的字面名称换成引用，不改变 Assertion 可见正文和命题；
- confirmed_evidence_ids 来自候选的 proof_evidence_ids。

证据不足但确有可能时 defer；明确不成立时 reject。不要新建叙述、补关系、替换真实端点或
扩大适用范围。reject/defer 的全部 confirmed_* 内容必须为空或 null。

输出唯一 JSON 对象：
{
  "decisions": [
    {
      "candidate_id": "candidate-1",
      "verdict": "accept",
      "confirmed_label": "签领表",
      "confirmed_aliases": [],
      "confirmed_bindings": [
        {"assertion_id": "region-0001/assert-1", "literal_surface": "签领表"}
      ],
      "confirmed_evidence_ids": ["region-0001/evidence-1"],
      "reason": "Evidence 明确支持该文件端点及全部绑定。"
    }
  ]
}
必须覆盖全部 candidate_id，不得增加其他字段或 Markdown 围栏。
""".strip()


@dataclass(frozen=True)
class MissingObjectRecoveryResult:
    package: MemoryPackage
    artifact: MissingObjectRecoveryArtifact


class MissingObjectRecoveryRunner:
    """把候选发现与 Evidence 复查隔离成两个模型判断。"""

    def __init__(
        self,
        *,
        model: ChatModel,
        progress: ProgressReporter | None = None,
    ) -> None:
        self.model = model
        self.progress = progress or NullProgressReporter()

    async def run(
        self,
        *,
        node_id: str,
        context_markdown: str,
        package: MemoryPackage,
        evidence_text_by_id: Mapping[str, str],
    ) -> MissingObjectRecoveryResult:
        discovery_prompt = _discovery_prompt(
            context_markdown,
            package,
            evidence_text_by_id,
        )
        discovery, discovery_calls = await self._complete_json(
            messages=[
                {"role": "system", "content": MISSING_OBJECT_DISCOVERY_SYSTEM_PROMPT},
                {"role": "user", "content": discovery_prompt},
            ],
            request_label=f"缺失对象发现·{node_id}",
            output_model=MissingObjectDiscoveryOutput,
            validator=lambda output: _validate_discovery(
                output,
                package,
                evidence_text_by_id,
            ),
        )
        if not discovery.candidates:
            artifact = MissingObjectRecoveryArtifact(
                node_id=node_id,
                discovery=discovery,
                review=MissingObjectReviewOutput(),
                created_object_ids=[],
                model_calls=discovery_calls,
            )
            return MissingObjectRecoveryResult(package=package, artifact=artifact)

        review_prompt = _review_prompt(
            context_markdown,
            package,
            discovery,
            evidence_text_by_id,
        )

        def validate_review(output: MissingObjectReviewOutput) -> None:
            apply_missing_object_reviews(
                package,
                discovery,
                output,
                node_id=node_id,
                evidence_text_by_id=evidence_text_by_id,
            )

        review, review_calls = await self._complete_json(
            messages=[
                {"role": "system", "content": MISSING_OBJECT_REVIEW_SYSTEM_PROMPT},
                {"role": "user", "content": review_prompt},
            ],
            request_label=f"缺失对象复查·{node_id}",
            output_model=MissingObjectReviewOutput,
            validator=validate_review,
        )
        recovered, created_object_ids = apply_missing_object_reviews(
            package,
            discovery,
            review,
            node_id=node_id,
            evidence_text_by_id=evidence_text_by_id,
        )
        artifact = MissingObjectRecoveryArtifact(
            node_id=node_id,
            discovery=discovery,
            review=review,
            created_object_ids=created_object_ids,
            model_calls=discovery_calls + review_calls,
        )
        return MissingObjectRecoveryResult(package=recovered, artifact=artifact)

    async def _complete_json(
        self,
        *,
        messages: list[Mapping[str, Any]],
        request_label: str,
        output_model: type[OutputModel],
        validator: Callable[[OutputModel], None],
    ) -> tuple[OutputModel, int]:
        conversation = messages
        turn = await self.model.complete_turn(
            messages=conversation,
            request_label=request_label,
            thinking="enabled",
        )
        calls = 1
        repairs = 0
        while True:
            try:
                if turn.tool_calls:
                    raise ValueError("缺失 Object 阶段必须返回正文 JSON，不能调用工具")
                output = output_model.model_validate_json(_json_object(turn.content))
                validator(output)
                return output, calls
            except (ValidationError, ValueError, json.JSONDecodeError) as error:
                if repairs >= MAX_PROTOCOL_REPAIRS:
                    raise
                repairs += 1
                self.progress.report(
                    request_label,
                    f"协议校验失败，进行第 {repairs}/{MAX_PROTOCOL_REPAIRS} 次定向修复：{error}",
                )
                conversation = _repair_messages(conversation, turn, error)
                turn = await self.model.complete_turn(
                    messages=conversation,
                    request_label=f"{request_label}·修复{repairs}",
                    thinking="enabled",
                )
                calls += 1


def _discovery_prompt(
    context_markdown: str,
    package: MemoryPackage,
    evidence_text_by_id: Mapping[str, str],
) -> str:
    payload = {
        "objects": [item.model_dump() for item in package.objects],
        "assertions": [item.model_dump() for item in package.assertions],
        "evidence_text_by_id": dict(evidence_text_by_id),
    }
    return f"""
[STAGE: discover_missing_basic_objects]

父节点上下文（只用于指代消歧）：
{context_markdown}

父节点完成已有项合并和修订后的基础包：
{json.dumps(payload, ensure_ascii=False, indent=2)}

逐条检查 Assertion 中仍为字面的稳定对象名称，只输出候选；不要直接修改基础包。
""".strip()


def _review_prompt(
    context_markdown: str,
    package: MemoryPackage,
    discovery: MissingObjectDiscoveryOutput,
    evidence_text_by_id: Mapping[str, str],
) -> str:
    assertion_ids = {
        assertion_id
        for candidate in discovery.candidates
        for assertion_id in candidate.supporting_assertion_ids
    }
    evidence_ids = {
        evidence_id
        for candidate in discovery.candidates
        for evidence_id in candidate.proof_evidence_ids
    }
    payload = {
        "existing_objects": [item.model_dump() for item in package.objects],
        "candidates": [item.model_dump() for item in discovery.candidates],
        "supporting_assertions": [
            item.model_dump() for item in package.assertions if item.assertion_id in assertion_ids
        ],
        "proof_evidence_text_by_id": {
            evidence_id: evidence_text_by_id[evidence_id] for evidence_id in sorted(evidence_ids)
        },
    }
    return f"""
[STAGE: review_missing_basic_objects]

父节点上下文（只用于指代消歧）：
{context_markdown}

待独立复查的数据：
{json.dumps(payload, ensure_ascii=False, indent=2)}

逐项复查并覆盖全部 candidate_id。不要重新发现候选。
""".strip()


def _validate_discovery(
    discovery: MissingObjectDiscoveryOutput,
    package: MemoryPackage,
    evidence_text_by_id: Mapping[str, str],
) -> None:
    assertions = {item.assertion_id: item for item in package.assertions}
    known_evidence_ids = {item.evidence_id for item in package.evidence}
    known_names = {
        value.casefold() for item in package.objects for value in [item.label, *item.aliases]
    }
    for candidate in discovery.candidates:
        if candidate.proposed_label.casefold() in known_names:
            raise ValueError(f"候选 Object 已存在：{candidate.proposed_label}")
        missing_assertions = set(candidate.supporting_assertion_ids) - set(assertions)
        if missing_assertions:
            raise ValueError(
                "候选引用了不存在的 Assertion：" + ", ".join(sorted(missing_assertions))
            )
        missing_evidence = set(candidate.proof_evidence_ids) - known_evidence_ids
        if missing_evidence:
            raise ValueError("候选引用了不存在的 Evidence：" + ", ".join(sorted(missing_evidence)))
        assertion_evidence = {
            evidence_id
            for assertion_id in candidate.supporting_assertion_ids
            for evidence_id in assertions[assertion_id].evidence_ids
        }
        if not set(candidate.proof_evidence_ids) <= assertion_evidence:
            raise ValueError("候选 proof_evidence_ids 必须来自 supporting Assertion")
        for binding in candidate.bindings:
            assertion = assertions[binding.assertion_id]
            if binding.literal_surface != candidate.proposed_label:
                raise ValueError("第一版 binding 字面值必须等于 proposed_label")
            if binding.literal_surface not in assertion.statement_template_markdown:
                raise ValueError(f"候选字面值未出现在 {binding.assertion_id} 的模板中")
        compact_label = _compact_text(candidate.proposed_label)
        if not any(
            compact_label in _compact_text(evidence_text_by_id[evidence_id])
            for evidence_id in candidate.proof_evidence_ids
        ):
            raise ValueError("候选 proposed_label 未出现在 proof Evidence 原文中")


def _repair_messages(
    original: Sequence[Mapping[str, Any]],
    turn: ModelTurn,
    error: Exception,
) -> list[Mapping[str, Any]]:
    return [
        *original,
        turn.as_assistant_message(),
        {
            "role": "user",
            "content": (
                "上一次 JSON 未通过程序校验。这是协议修复，不是重新分析；保留可靠判断，"
                "只修正错误字段，并按系统消息重新输出完整 JSON。程序错误："
                f"{error}"
            ),
        },
    ]


def _json_object(raw: str) -> str:
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end < start:
        raise ValueError("模型正文中不存在 JSON 对象")
    return raw[start : end + 1]


def _compact_text(value: str) -> str:
    return "".join(value.split()).casefold()
