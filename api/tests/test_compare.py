"""前后方案影响比较：复用裁决、按声明三态对比、422 按方案路径定位。"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

ALL_FLAGS = {
    "contains_milk": False, "contains_peanut": False,
    "contains_wheat": False, "contains_barley": False, "contains_rye": False,
    "contact_milk": False, "contact_peanut": False,
    "contact_wheat": False, "contact_barley": False, "contact_rye": False,
}


def make_row(name: str = "原料", **flags: bool) -> dict:
    payload = {"name": name, **ALL_FLAGS}
    payload.update(flags)
    return payload


def make_plan(rows: list[dict], claims: list[str]) -> dict:
    return {"ingredients": rows, "claims": claims}


def post_compare(baseline: dict, current: dict):
    return client.post("/api/compare", json={"baseline": baseline, "current": current})


def test_new_wheat_contact_newly_blocks_gluten_free() -> None:
    # 对照：燕麦粉全部干净；现方案：新增小麦共线接触
    baseline = make_plan([make_row("燕麦粉")], ["gluten_free"])
    current = make_plan([make_row("燕麦粉", contact_wheat=True)], ["gluten_free"])
    response = post_compare(baseline, current)
    assert response.status_code == 200
    body = response.json()

    # 两侧各自复用同一裁决：对照可印刷，现方案禁止印刷
    assert body["baseline"]["printable"] is True
    assert body["current"]["printable"] is False
    assert body["current"]["rows"][0]["contact_hits"] == ["wheat"]

    assert len(body["comparisons"]) == 1
    comp = body["comparisons"][0]
    assert comp["claim"] == "gluten_free"
    assert comp["status"] == "newly_blocked"
    assert comp["baseline_allowed"] is True
    assert comp["current_allowed"] is False
    # 只存在于现方案的阻断证据被单独返回
    assert comp["new_blockers"] == [
        {
            "row_index": 0,
            "ingredient_name": "燕麦粉",
            "target": "wheat",
            "source": "contact",
        }
    ]
    assert comp["resolved_blockers"] == []


def test_removing_milk_hit_resolves_claim() -> None:
    # 对照：直接成分含牛奶被阻断；现方案：移除该命中
    baseline = make_plan([make_row("全脂奶粉", contains_milk=True)], ["milk_free"])
    current = make_plan([make_row("椰子粉")], ["milk_free"])
    response = post_compare(baseline, current)
    assert response.status_code == 200
    body = response.json()

    comp = body["comparisons"][0]
    assert comp["claim"] == "milk_free"
    assert comp["status"] == "resolved"
    assert comp["baseline_allowed"] is False
    assert comp["current_allowed"] is True
    assert comp["new_blockers"] == []
    assert comp["resolved_blockers"] == [
        {
            "row_index": 0,
            "ingredient_name": "全脂奶粉",
            "target": "milk",
            "source": "direct",
        }
    ]


def test_unrelated_peanut_change_keeps_gluten_conclusion() -> None:
    # 花生不属于麸质目标集合：共线新增花生不影响“不含麸质”
    baseline = make_plan([make_row("白砂糖")], ["gluten_free"])
    current = make_plan([make_row("白砂糖", contact_peanut=True)], ["gluten_free"])
    response = post_compare(baseline, current)
    assert response.status_code == 200
    body = response.json()

    comp = body["comparisons"][0]
    assert comp["claim"] == "gluten_free"
    assert comp["status"] == "unchanged"
    assert comp["baseline_allowed"] is True
    assert comp["current_allowed"] is True
    assert comp["new_blockers"] == []
    assert comp["resolved_blockers"] == []


def test_blocked_in_both_plans_with_same_evidence_is_unchanged() -> None:
    # 两侧都被同一证据阻断：结论未变化，证据差集为空
    baseline = make_plan([make_row("麦茶", contact_barley=True)], ["gluten_free"])
    current = make_plan([make_row("麦茶", contact_barley=True)], ["gluten_free"])
    response = post_compare(baseline, current)
    comp = response.json()["comparisons"][0]
    assert comp["status"] == "unchanged"
    assert comp["baseline_allowed"] is False
    assert comp["current_allowed"] is False
    assert comp["new_blockers"] == []
    assert comp["resolved_blockers"] == []


def test_invalid_current_returns_422_with_current_path_and_no_comparison() -> None:
    baseline = make_plan([make_row("白砂糖")], ["gluten_free"])
    bad_row = make_row("燕麦粉")
    del bad_row["contact_wheat"]  # 现方案缺失共线标记
    current = make_plan([bad_row], ["gluten_free"])
    response = post_compare(baseline, current)
    assert response.status_code == 422
    body = response.json()
    locations = [tuple(err["loc"]) for err in body["detail"]]
    assert ("body", "current", "ingredients", 0, "contact_wheat") in locations
    # 不产生任何比较结果
    assert "comparisons" not in body


def test_invalid_baseline_returns_422_with_baseline_path_and_no_comparison() -> None:
    baseline = make_plan([make_row("白砂糖")], ["gluten_fre"])  # 对照方案非法枚举
    current = make_plan([make_row("白砂糖")], ["gluten_free"])
    response = post_compare(baseline, current)
    assert response.status_code == 422
    body = response.json()
    locations = [tuple(err["loc"]) for err in body["detail"]]
    assert any(loc[:2] == ("body", "baseline") and loc[-1] == "claims" for loc in locations)
    assert "comparisons" not in body


def test_evaluate_endpoint_contract_unchanged() -> None:
    # 原有裁决入口与响应结构保持不变
    payload = make_plan([make_row("燕麦粉", contact_wheat=True)], ["gluten_free"])
    response = client.post("/api/evaluate", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert set(body.keys()) == {"printable", "rows", "verdicts"}
    assert body["printable"] is False
