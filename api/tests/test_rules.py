"""裁决核心规则测试：直接成分、共线接触、麸质集合边界。"""
from __future__ import annotations

import pytest

from app.evaluate import evaluate
from app.rules import CLAIM_TARGETS, Claim, Target
from app.schemas import IngredientInput, ReleaseRequest


def make_row(name: str, **flags: bool) -> IngredientInput:
    defaults = {f: False for f in (
        "contains_milk", "contains_peanut", "contains_wheat",
        "contains_barley", "contains_rye",
        "contact_milk", "contact_peanut", "contact_wheat",
        "contact_barley", "contact_rye",
    )}
    defaults.update(flags)
    return IngredientInput(name=name, **defaults)


def request_with(*rows: IngredientInput, claims: list[Claim]) -> ReleaseRequest:
    return ReleaseRequest(ingredients=list(rows), claims=claims)


def test_gluten_hit_set_is_strictly_wheat_barley_rye() -> None:
    assert CLAIM_TARGETS[Claim.GLUTEN_FREE] == frozenset(
        {Target.WHEAT, Target.BARLEY, Target.RYE}
    )
    assert Target.MILK not in CLAIM_TARGETS[Claim.GLUTEN_FREE]
    assert Target.PEANUT not in CLAIM_TARGETS[Claim.GLUTEN_FREE]


@pytest.mark.parametrize("field", ["contains_wheat", "contains_barley", "contains_rye"])
def test_each_gluten_direct_ingredient_blocks_only_gluten_claim(field: str) -> None:
    result = evaluate(request_with(make_row("谷物", **{field: True}),
                                   claims=[Claim.MILK_FREE, Claim.PEANUT_FREE, Claim.GLUTEN_FREE]))
    verdict_by_claim = {v.claim: v for v in result.verdicts}
    assert verdict_by_claim[Claim.MILK_FREE].allowed is True
    assert verdict_by_claim[Claim.PEANUT_FREE].allowed is True
    gluten = verdict_by_claim[Claim.GLUTEN_FREE]
    assert gluten.allowed is False
    assert len(gluten.blocked_by) == 1
    evidence = gluten.blocked_by[0]
    assert evidence.source == "direct"
    assert evidence.row_index == 0
    assert result.printable is False


@pytest.mark.parametrize("field", ["contact_wheat", "contact_barley", "contact_rye"])
def test_each_gluten_contact_flag_blocks_gluten_claim(field: str) -> None:
    # 共线接触即使直接成分完全干净，也必须阻断对应声明
    result = evaluate(request_with(make_row("燕麦", **{field: True}),
                                   claims=[Claim.GLUTEN_FREE]))
    verdict = result.verdicts[0]
    assert verdict.allowed is False
    assert verdict.blocked_by[0].source == "contact"
    assert result.rows[0].direct_hits == []
    assert result.rows[0].contact_hits != []
    assert result.printable is False


def test_milk_and_peanut_direct_and_contact_block_their_claims() -> None:
    rows = [
        make_row("奶粉", contains_milk=True),
        make_row("调味粉", contact_peanut=True),
    ]
    result = evaluate(request_with(*rows, claims=[
        Claim.MILK_FREE, Claim.PEANUT_FREE, Claim.GLUTEN_FREE,
    ]))
    by_claim = {v.claim: v for v in result.verdicts}
    assert by_claim[Claim.MILK_FREE].blocked_by[0].source == "direct"
    assert by_claim[Claim.MILK_FREE].blocked_by[0].target is Target.MILK
    assert by_claim[Claim.PEANUT_FREE].blocked_by[0].source == "contact"
    assert by_claim[Claim.PEANUT_FREE].blocked_by[0].target is Target.PEANUT
    # 牛奶/花生命中不得误伤麸质声明
    assert by_claim[Claim.GLUTEN_FREE].allowed is True
    assert result.printable is False


def test_clean_recipe_with_all_claims_is_printable() -> None:
    rows = [
        make_row("白砂糖"),
        make_row("食用盐"),
    ]
    result = evaluate(request_with(*rows, claims=[
        Claim.MILK_FREE, Claim.PEANUT_FREE, Claim.GLUTEN_FREE,
    ]))
    assert result.printable is True
    assert all(v.allowed for v in result.verdicts)
    assert all(row.direct_hits == [] and row.contact_hits == [] for row in result.rows)


def test_partial_block_keeps_other_claim_printable_decision() -> None:
    result = evaluate(
        request_with(make_row("小麦粉", contains_wheat=True),
                     claims=[Claim.MILK_FREE, Claim.GLUTEN_FREE])
    )
    by_claim = {v.claim: v for v in result.verdicts}
    assert by_claim[Claim.MILK_FREE].allowed is True
    assert by_claim[Claim.GLUTEN_FREE].allowed is False
    assert result.printable is False


def test_evidence_reports_every_row_and_hit_in_order() -> None:
    rows = [
        make_row("干净原料"),
        make_row("混合原料", contains_milk=True, contact_wheat=True, contains_rye=True),
        make_row("花生酱", contact_peanut=True),
    ]
    result = evaluate(request_with(*rows, claims=[
        Claim.MILK_FREE, Claim.PEANUT_FREE, Claim.GLUTEN_FREE,
    ]))
    assert [row.name for row in result.rows] == ["干净原料", "混合原料", "花生酱"]
    middle = result.rows[1]
    assert middle.direct_hits == [Target.MILK, Target.RYE]
    assert middle.contact_hits == [Target.WHEAT]

    gluten_blocked = {
        (e.row_index, e.target, e.source)
        for e in result.verdicts[2].blocked_by
    }
    assert gluten_blocked == {(1, Target.RYE, "direct"), (1, Target.WHEAT, "contact")}


def test_duplicate_claims_yield_single_verdict() -> None:
    result = evaluate(request_with(make_row("奶", contains_milk=True),
                                   claims=[Claim.MILK_FREE, Claim.MILK_FREE]))
    assert len(result.verdicts) == 1
    assert result.verdicts[0].allowed is False


def test_same_row_direct_and_contact_both_evidenced() -> None:
    row = make_row("可疑粉", contains_barley=True, contact_barley=True)
    result = evaluate(request_with(row, claims=[Claim.GLUTEN_FREE]))
    sources = {e.source for e in result.verdicts[0].blocked_by}
    assert sources == {"direct", "contact"}
    assert len(result.verdicts[0].blocked_by) == 2
