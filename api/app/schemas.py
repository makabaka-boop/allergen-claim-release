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

    model_config = {"extra": "forbid"}

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

    model_config = {"extra": "forbid"}

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


# ---------------------------------------------------------------------------
# 换线残留推演（独立模块，与放行裁决/方案比较互不影响）
# ---------------------------------------------------------------------------


class BatchInput(BaseModel):
    """生产批次序列中的一个批次：名称 + 五类过敏原直接成分。

    五类标记均为必填布尔值，缺失或为 null/非布尔一律按批次字段级错误拒绝。
    """

    model_config = {"extra": "forbid"}

    name: NonEmptyName = Field(..., description="批次名称（去空白后非空、序列内不重复）")
    contains_milk: bool = _BOOL
    contains_peanut: bool = _BOOL
    contains_wheat: bool = _BOOL
    contains_barley: bool = _BOOL
    contains_rye: bool = _BOOL


class CleaningBoundary(BaseModel):
    """相邻批次之间的清洁边界：标记进入下一批前是否完成经验证清洁。

    经验证清洁会在下一批开始前清空全部残留；未清洁则残留继续带入。
    """

    model_config = {"extra": "forbid"}

    cleaned: bool = Field(..., strict=True, description="true=已完成经验证清洁，下一批从零开始")


class ChangeoverRequest(BaseModel):
    """换线残留推演请求：以生产批次序列为核心对象。

    batches 至少两个批次；boundaries 为相邻批次间的清洁标记，
    合法长度固定为 len(batches) - 1。名称去空白后不得重复。
    批次数量不足/名称空白或重复/边界缺失或长度不符/成分标记非布尔，
    均返回定位到具体批次或边界的字段级错误，且不产生推演结果。
    """

    model_config = {"extra": "forbid"}

    batches: list[BatchInput] = Field(..., description="按生产顺序排列的批次，至少两个")
    boundaries: list[CleaningBoundary] = Field(
        ..., description="相邻批次间的清洁标记，长度必须为批次数减一"
    )


class ResidueItem(BaseModel):
    """单个残留/带入目标项，并保留最近来源批次。"""

    target: Target
    source_batch_index: int = Field(..., ge=0, description="最近来源批次序号（从 0 开始）")
    source_batch_name: str = Field(..., description="最近来源批次名称")


class CleaningBoundaryReport(BaseModel):
    """相邻批次间清洁边界的推演结果（边界 i 位于批次 i 与批次 i+1 之间）。"""

    boundary_index: int = Field(..., ge=0)
    cleaned: bool = Field(..., description="用户标记：是否完成经验证清洁")
    residue_cleared: bool = Field(
        ..., description="true 表示该边界经验证清洁，离开残留未继续带入下一批"
    )


class BatchResidueReport(BaseModel):
    """单个批次的换线残留推演结果。"""

    batch_index: int = Field(..., ge=0)
    name: str
    direct_ingredients: list[Target] = Field(
        ..., description="本批直接含有的五类过敏原目标项（固定目标顺序）"
    )
    incoming_residue: list[ResidueItem] = Field(
        ..., description="进入残留：本批开始时产线上的上一批残留"
    )
    carried_over: list[ResidueItem] = Field(
        ...,
        description="前序批次带入物：进入残留中本批未直接含有的目标项"
        "（本批直接含有的同目标项不构成带入，避免直接成分误报）",
    )
    outgoing_residue: list[ResidueItem] = Field(
        ...,
        description="离开残留：未清洁时为进入残留与本批直接成分的并集"
        "（每项保留最近来源批次）；首项前若已清洁则为空",
    )
    # 本批开始前的清洁边界（第 0 批之前没有边界，为 null）
    cleaned_before: bool | None = Field(
        ..., description="上一条边界是否经验证清洁；第 0 批为 null"
    )


class ChangeoverResponse(BaseModel):
    batches: list[BatchResidueReport]
    boundaries: list[CleaningBoundaryReport] = Field(
        ..., description="逐边界回显清洁是否使残留归零，与输入边界一一对应"
    )
