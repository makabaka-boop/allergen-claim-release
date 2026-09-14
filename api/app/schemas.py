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
    """相邻批次之间的清洁边界（边界 i 位于批次 i 与批次 i+1 之间）。

    三种清洁选择：

    - ``cleaned=true``（且不给 ``cleared_targets``）：完成经验证的**全部清洁**，
      下一批开始前清空全部残留；
    - ``cleaned=false`` 且 ``cleared_targets`` 为非空的合法目标列表：
      **局部清洁**，进入下一批前仅移除指定目标，其余残留继续携带；
    - ``cleaned=false`` 且不提供 ``cleared_targets``：未清洁，残留原样带入。

    旧请求仅含 ``cleaned`` 布尔时保持原有全清/不清语义。
    ``cleared_targets`` 为空列表、含重复项、含五类以外取值，或与
    ``cleaned=true`` 同时出现，均为边界字段级错误（见 changeover.validate_sequence）。
    """

    model_config = {"extra": "forbid"}

    cleaned: bool = Field(..., strict=True, description="true=已完成全部经验证清洁，下一批从零开始")
    cleared_targets: list[Target] | None = Field(
        default=None,
        description="局部清洁：进入下一批前仅移除这些已验证清除的目标；"
        "缺省表示不指定清除目标（沿用 cleaned 的全清/不清语义）",
    )


class ChangeoverRequest(BaseModel):
    """换线残留推演请求：以生产批次序列为核心对象。

    batches 至少两个批次；boundaries 为相邻批次间的清洁标记，
    合法长度固定为 len(batches) - 1。名称去空白后不得重复。
    批次数量不足/名称空白或重复/边界缺失或长度不符/成分标记非布尔，
    均返回定位到具体批次或边界的字段级错误，且不产生推演结果。

    边界支持局部清洁：boundaries[i].cleared_targets 可选，列出进入下一批前
    已验证清除的目标；与 cleaned=true 冲突、为空、重复或超出五类范围均拒绝。
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
    cleaned: bool = Field(..., description="用户标记：是否完成全部经验证清洁")
    residue_cleared: bool = Field(
        ..., description="true 表示该边界经验证全部清洁，离开残留未继续带入下一批"
    )
    cleared_targets: list[Target] = Field(
        ...,
        description="该边界实际执行的清除目标：全部清洁为五类全列；"
        "局部清洁为指定的已清除目标；未清洁为空列表",
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
    # 本批开始前的清洁边界（第 0 批之前没有边界，为 null）。
    # 局部清洁不是全部清洁，此处仍为 false；实际清除项见 boundaries[i].cleared_targets。
    cleaned_before: bool | None = Field(
        ..., description="上一条边界是否经验证全部清洁；第 0 批为 null，局部清洁为 false"
    )


class ChangeoverResponse(BaseModel):
    batches: list[BatchResidueReport]
    boundaries: list[CleaningBoundaryReport] = Field(
        ..., description="逐边界回显清洁是否使残留归零，与输入边界一一对应"
    )


# ---------------------------------------------------------------------------
# 批次用料追溯（独立模块，与放行裁决/方案比较/换线推演互不影响）
# ---------------------------------------------------------------------------

# 批次类型固定枚举：原料 / 中间料 / 成品（录入时选择，结果中原样回显）
BATCH_TYPES = ("raw_material", "intermediate", "finished_good")


class TraceBatchInput(BaseModel):
    """物料批次台账中的一个批次：批次编号 + 物料名称 + 批次类型。

    批次编号、物料名称去空白后均不得为空；编号在整份台账内不得重复
    （后者为跨字段约束，见 traceability.validate_graph）。
    """

    model_config = {"extra": "forbid"}

    code: NonEmptyName = Field(..., description="批次编号（去空白后非空、台账内唯一）")
    material_name: NonEmptyName = Field(..., description="物料名称（去空白后非空）")
    batch_type: str = Field(
        ...,
        description="批次类型：raw_material 原料 / intermediate 中间料 / finished_good 成品",
    )

    @field_validator("batch_type", mode="before")
    @classmethod
    def _validate_batch_type(cls, value: object) -> object:
        """类型字段以普通字符串承载并显式白名单校验，未知取值精确定位到 batch_type。"""
        if not isinstance(value, str) or value.strip() not in BATCH_TYPES:
            raise ValueError(
                "非法批次类型：仅允许 raw_material（原料）/ "
                "intermediate（中间料）/ finished_good（成品）"
            )
        return value.strip()


class TraceRelationInput(BaseModel):
    """一条投料关系：来源批次（from_code）被投入目标批次（to_code）。

    方向固定为“来源 → 目标”：原料批次投入中间料、中间料投入成品。
    两端必须都能在批次台账中找到、不得自引用；这些是跨记录约束，
    见 traceability.validate_graph。
    """

    model_config = {"extra": "forbid"}

    from_code: NonEmptyName = Field(..., description="来源批次编号（被投入的物料批次）")
    to_code: NonEmptyName = Field(..., description="目标批次编号（投料去向批次）")


class TraceabilityRequest(BaseModel):
    """批次用料追溯请求：完整关系图（批次台账 + 投料关系）+ 污染源批次编号。

    后端接收完整关系图与污染源后统一校验引用、自引用与成环，再以录入
    顺序稳定遍历，只返回可从污染源沿投料方向到达的批次。批次编号空白/
    重复、关系端点不存在、自引用或关系成环均返回定位到具体批次或关系
    的字段级错误，且不产生追溯结果。
    """

    model_config = {"extra": "forbid"}

    batches: list[TraceBatchInput] = Field(
        ..., min_length=1, description="物料批次台账，至少一个批次（空数组拒绝）"
    )
    relations: list[TraceRelationInput] = Field(
        ..., description="投料关系列表（按录入顺序作为稳定遍历与选路的关系序号）"
    )
    source_code: NonEmptyName = Field(..., description="发起追溯的污染源批次编号")


class TracePathStep(BaseModel):
    """最短投料路径上的一跳：第 relation_index 条关系把来源批次投入目标批次。"""

    relation_index: int = Field(
        ..., ge=0, description="该跳所用投料关系的录入序号（从 0 开始）"
    )
    from_code: str = Field(..., description="该跳的来源批次编号")
    to_code: str = Field(..., description="该跳的目标批次编号")


class TracedBatch(BaseModel):
    """一个可从污染源到达的受影响批次及其最短投料路径。"""

    code: str = Field(..., description="受影响批次编号")
    material_name: str = Field(..., description="该批次的物料名称（原样回显）")
    batch_type: str = Field(..., description="该批次的批次类型（原样回显）")
    level: int = Field(
        ..., ge=1, description="传播层级：距污染源的最短投料跳数（污染源本身层级为 0，不出现在此列表）"
    )
    path_codes: list[str] = Field(
        ..., description="最短投料路径经过的批次编号：[污染源, …, 该批次]"
    )
    path_relation_indices: list[int] = Field(
        ...,
        description="最短投料路径各跳所用关系的录入序号；"
        "同一批次经多条路径到达时，取层级最少且该序号序列字典序最小的路径",
    )
    path_steps: list[TracePathStep] = Field(
        ..., description="最短投料路径的逐跳解释（关系序号 + 来源/目标批次编号）"
    )


class TraceLevelGroup(BaseModel):
    """同一传播层级的受影响批次分组（组内按首次到达顺序稳定排列）。"""

    level: int = Field(..., ge=1)
    batches: list[TracedBatch]


class TraceabilityResponse(BaseModel):
    source_code: str = Field(..., description="污染源批次编号（回显）")
    source_material_name: str = Field(..., description="污染源批次的物料名称")
    source_batch_type: str = Field(..., description="污染源批次的批次类型")
    affected_count: int = Field(..., description="可从污染源到达的下游批次总数（不含污染源本身）")
    levels: list[TraceLevelGroup] = Field(
        ..., description="按传播层级组织的受影响批次（层级自 1 开始，无空层级）"
    )
    affected_batches: list[TracedBatch] = Field(
        ..., description="与 levels 内容一致的扁平列表，按层级、层级内首次到达顺序稳定排列"
    )
