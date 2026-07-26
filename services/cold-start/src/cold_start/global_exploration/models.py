"""全局勘探第一版的受控中间产物。"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictOutputModel(BaseModel):
    """拒绝模型擅自扩展结构化输出字段。"""

    model_config = ConfigDict(extra="forbid")


class MacroSection(StrictOutputModel):
    """后续深入阅读使用的一个连续宏观分区。"""

    label: str = Field(min_length=1, max_length=80)
    start_page: int = Field(ge=1)
    end_page: int = Field(ge=1)

    @model_validator(mode="after")
    def validate_range(self) -> MacroSection:
        if self.end_page < self.start_page:
            raise ValueError("宏观分区结束页不能早于开始页")
        return self


class MacroSectionPlan(StrictOutputModel):
    """宏观切分线路返回的最小可执行阅读计划。"""

    sections: list[MacroSection] = Field(min_length=1, max_length=40)


class RouteStatistics(StrictOutputModel):
    """记录两条线路实际处理的单元数量。"""

    context_units: int
    macro_section_calls: int


class SourceMetadata(StrictOutputModel):
    """输入 PDF 的稳定来源信息。"""

    path: str
    title: str
    sha256: str
    parser: str
    page_count: int


class GlobalExplorationSnapshot(StrictOutputModel):
    """两条并行线路汇合后的低权威全局勘探结果。"""

    model_config = ConfigDict(frozen=True)

    schema_version: Literal["global-exploration.v4"] = "global-exploration.v4"
    authority: Literal["preliminary-low-authority"] = "preliminary-low-authority"
    created_at: datetime
    source: SourceMetadata
    document_context_markdown: str
    macro_sections: list[MacroSection]
    route_statistics: RouteStatistics
