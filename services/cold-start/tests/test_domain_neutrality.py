from cold_start.compilation.source_semantics import (
    CLAIM_EXTRACTION_SYSTEM_PROMPT,
    CONSERVATIVE_ATOMIC_FALLBACK_SYSTEM_PROMPT,
    MISSING_CLAIMS_SYSTEM_PROMPT,
    OBJECT_FRAGMENT_SYSTEM_PROMPT,
)
from cold_start.global_exploration.prompts import DOCUMENT_CONTEXT_SYSTEM_PROMPT
from cold_start.global_resolution.prompts import GLOBAL_IDENTITY_SYSTEM_PROMPT


def test_generic_compiler_prompts_do_not_assume_the_ping_pong_association_domain() -> None:
    generic_prompts = (
        DOCUMENT_CONTEXT_SYSTEM_PROMPT,
        CLAIM_EXTRACTION_SYSTEM_PROMPT,
        CONSERVATIVE_ATOMIC_FALLBACK_SYSTEM_PROMPT,
        MISSING_CLAIMS_SYSTEM_PROMPT,
        OBJECT_FRAGMENT_SYSTEM_PROMPT,
        GLOBAL_IDENTITY_SYSTEM_PROMPT,
    )
    forbidden_domain_assumptions = (
        "协会",
        "社团",
        "乒协",
        "乒乓球协会",
        "中国科学技术大学",
        "USTC TTA",
        "协会内部文档",
        "协会现实",
        "二课系统",
        "管指委",
        "指导老师",
        "干事",
    )

    for prompt in generic_prompts:
        for assumption in forbidden_domain_assumptions:
            assert assumption not in prompt
