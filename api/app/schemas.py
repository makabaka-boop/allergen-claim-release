"""Pydantic 请求/响应模型与字段级校验。

数据约定见仓库 README。任何字段级非法输入（未知枚举、空配方、缺失标记）
都会由 FastAPI 转成 422 字段级错误，且不会产生任何判定。
"""
from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints, field_validator

from .rules import Claim, CompareStatus, Target

# 原料名非空纯字符串（去空白后至少 1 个字符）
NonEmptyName = Annotated[str, StringConstraints(min_length=1, strip_whitespace=True)]

_BOOL = Field(..., strict=True)


class IngredientInput(BaseModel):
    """配方表一行：直接成分勾选 + 同组共线接触标记。

    所有标记均为必填布尔值，缺失或为 null 一律按字段级错误拒绝。
    """

    model_config = {"extra": "forbid"}

    name: NonEmptyName = Field(..., description="原料名称")
    contains_milk: bool = _BOOL
    contains_peanut: bool = _BOOL
    contains_wheat: bool = _BOOL
    contains_barley: bool = _BOOL
    contains_rye: bool = _BOOL
    contact_milk: bool = _BOOL
    contact_peanut: bool = _BOOL
    contact_wheat: bool = _BOOL
    contact_barley: bool = _BOOL
    contact_rye: bool = _BOOL


class ReleaseRequest(BaseModel):
    """放行裁决请求：至少一条原料、至少一条声明。"""

    ingredients: list[IngredientInput] = Field(
        ..., min_length=1, description="配方原料行，空配方（含空数组）一律拒绝"
    )
    claims: list[Claim] = Field(
        ..., min_length=1, description="拟印刷的声明，仅允许 milk_free / peanut_free / gluten_free"
    )

    @field_validator("claims", mode="before")
    @classmethod
    def _validate_claim_values(cls, value: object) -> object:
        """Pydantic 默认会把任意字符串强转为 StrEnum 成员（非法值变“未知成员”），
        这里显式按值比对，未知枚举直接产生 claims 字段级错误。"""
        if not isinstance(value, list):
            return value
        allowed = {claim.value for claim in Claim}
        for item in value:
            if not isinstance(item, str) or item not in allowed:
                raise ValueError(
                    f"非法声明枚举: {item!r}；仅允许 milk_free / peanut_free / gluten_free"
                )
        return value


class Evidence(BaseModel):
    """单条命中证据：第几行、直接成分还是共线接触、命中哪个目标。"""

    row_index: int = Field(..., ge=0, description="从 0 开始的原料行号")
    ingredient_name: str
    target: Target
    source: str = Field(..., description="direct（直接成分）或 contact（同组共线接触）")


class RowReport(BaseModel):
    """逐行返回的直接成分与共线证据。"""

    row_index: int
    name: str
    direct_hits: list[Target]
    contact_hits: list[Target]


class ClaimVerdict(BaseModel):
    """单条声明的放行结论。

    放行条件固定：相关目标项在所有原料的直接成分与共线标记中均未命中。
    """

    claim: Claim
    allowed: bool
    blocked_by: list[Evidence] = Field(default_factory=list)


class ReleaseResponse(BaseModel):
    printable: bool = Field(..., description="所有请求声明均放行时为 true")
    rows: list[RowReport]
    verdicts: list[ClaimVerdict]


class CompareRequest(BaseModel):
    """前后方案影响比较请求：对照方案与现方案各自独立校验。

    任一侧字段非法时，422 的 loc 会带上 baseline/current 前缀，
    按对照或现方案路径精确定位，且不产生任何比较结果。
    """

    baseline: ReleaseRequest = Field(..., description="对照方案（已保存的快照）")
    current: ReleaseRequest = Field(..., description="现方案（当前编辑内容）")


class ClaimComparison(BaseModel):
    """单条声明的前后对比：三态之一 + 只存在于一侧的阻断证据。"""

    claim: Claim
    status: CompareStatus
    baseline_allowed: bool = Field(..., description="对照方案中该声明是否放行")
    current_allowed: bool = Field(..., description="现方案中该声明是否放行")
    new_blockers: list[Evidence] = Field(
        default_factory=list, description="仅现方案存在的阻断证据"
    )
    resolved_blockers: list[Evidence] = Field(
        default_factory=list, description="仅对照方案存在的阻断证据"
    )


class CompareResponse(BaseModel):
    baseline: ReleaseResponse = Field(..., description="对照方案的完整裁决结果")
    current: ReleaseResponse = Field(..., description="现方案的完整裁决结果")
    comparisons: list[ClaimComparison]
