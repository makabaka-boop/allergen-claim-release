# 放行裁决核心（纯函数，不依赖 Web 框架）
# 目标项固定为：牛奶、花生、小麦、大麦、黑麦；
# 麸质命中集合严格等于 {小麦, 大麦, 黑麦}，牛奶/花生不属于麸质。
from __future__ import annotations

from enum import StrEnum
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .schemas import IngredientInput


class Target(StrEnum):
    MILK = "milk"
    PEANUT = "peanut"
    WHEAT = "wheat"
    BARLEY = "barley"
    RYE = "rye"


class Claim(StrEnum):
    MILK_FREE = "milk_free"
    PEANUT_FREE = "peanut_free"
    GLUTEN_FREE = "gluten_free"


# 原料行布尔字段 -> 目标项
DIRECT_FIELD_TARGETS: dict[str, Target] = {
    "contains_milk": Target.MILK,
    "contains_peanut": Target.PEANUT,
    "contains_wheat": Target.WHEAT,
    "contains_barley": Target.BARLEY,
    "contains_rye": Target.RYE,
}

# 共线接触布尔字段 -> 目标项
CONTACT_FIELD_TARGETS: dict[str, Target] = {
    "contact_milk": Target.MILK,
    "contact_peanut": Target.PEANUT,
    "contact_wheat": Target.WHEAT,
    "contact_barley": Target.BARLEY,
    "contact_rye": Target.RYE,
}

# 声明 -> 需要“全部未命中”的目标集合（固定且穷尽）
CLAIM_TARGETS: dict[Claim, frozenset[Target]] = {
    Claim.MILK_FREE: frozenset({Target.MILK}),
    Claim.PEANUT_FREE: frozenset({Target.PEANUT}),
    # 麸质命中集合严格等于小麦、大麦、黑麦
    Claim.GLUTEN_FREE: frozenset({Target.WHEAT, Target.BARLEY, Target.RYE}),
}


def direct_targets(row: IngredientInput) -> set[Target]:
    """该行直接成分命中的目标项。"""
    return {target for field, target in DIRECT_FIELD_TARGETS.items() if getattr(row, field)}


def contact_targets(row: IngredientInput) -> set[Target]:
    """该行同组共线接触命中的目标项。"""
    return {target for field, target in CONTACT_FIELD_TARGETS.items() if getattr(row, field)}
