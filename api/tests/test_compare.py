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


def test_inserting_unrelated_row_before_blocker_keeps_evidence() -> None:
    # 阻断原料（燕麦粉小麦共线）前面插入一条无关原料：行号整体平移，
    # 同一条证据不得同时出现在“新增”与“解除”中，结论仍为未变化
    baseline = make_plan([make_row("燕麦粉", contact_wheat=True)], ["gluten_free"])
    current = make_plan(
        [make_row("白砂糖"), make_row("燕麦粉", contact_wheat=True)],
        ["gluten_free"],
    )
    response = post_compare(baseline, current)
    assert response.status_code == 200
    comp = response.json()["comparisons"][0]
    assert comp["status"] == "unchanged"
    assert comp["new_blockers"] == []
    assert comp["resolved_blockers"] == []


def test_removing_leading_unrelated_row_keeps_evidence() -> None:
    # 反向操作：删除阻断原料前面的无关行，同样不产生证据伪差异
    baseline = make_plan(
        [make_row("白砂糖"), make_row("燕麦粉", contact_wheat=True)],
        ["gluten_free"],
    )
    current = make_plan([make_row("燕麦粉", contact_wheat=True)], ["gluten_free"])
    response = post_compare(baseline, current)
    comp = response.json()["comparisons"][0]
    assert comp["status"] == "unchanged"
    assert comp["new_blockers"] == []
    assert comp["resolved_blockers"] == []


def test_renaming_blocked_ingredient_without_other_change_is_unchanged() -> None:
    # 纯改名（行数、位置与命中都不变）：按位置对齐，不产生新增/解除伪差异
    baseline = make_plan([make_row("燕麦粉", contact_wheat=True)], ["gluten_free"])
    current = make_plan([make_row("燕麦米粉", contact_wheat=True)], ["gluten_free"])
    response = post_compare(baseline, current)
    comp = response.json()["comparisons"][0]
    assert comp["status"] == "unchanged"
    assert comp["new_blockers"] == []
    assert comp["resolved_blockers"] == []


def test_inserted_unrelated_row_with_multiple_blockers() -> None:
    # 多条阻断证据随插入行一起平移：全部仍应按同一证据对齐
    baseline = make_plan(
        [
            make_row("燕麦粉", contact_wheat=True),
            make_row("麦茶", contact_barley=True),
        ],
        ["gluten_free"],
    )
    current = make_plan(
        [
            make_row("白砂糖"),
            make_row("燕麦粉", contact_wheat=True),
            make_row("麦茶", contact_barley=True),
        ],
        ["gluten_free"],
    )
    response = post_compare(baseline, current)
    comp = response.json()["comparisons"][0]
    assert comp["status"] == "unchanged"
    assert comp["new_blockers"] == []
    assert comp["resolved_blockers"] == []


def test_appending_blocking_row_is_newly_blocked() -> None:
    # 对齐不能误吞真正的改动：末尾新增一条阻断行仍是“新受阻”
    baseline = make_plan([make_row("白砂糖")], ["gluten_free"])
    current = make_plan(
        [make_row("白砂糖"), make_row("燕麦粉", contact_wheat=True)],
        ["gluten_free"],
    )
    response = post_compare(baseline, current)
    body = response.json()
    comp = body["comparisons"][0]
    assert comp["status"] == "newly_blocked"
    assert [
        (item["row_index"], item["target"]) for item in comp["new_blockers"]
    ] == [(1, "wheat")]
    assert comp["resolved_blockers"] == []


def test_deselected_blocked_claim_is_not_reported_resolved() -> None:
    # 对照方案“不含牛奶”受阻；现方案取消该声明（改选不含麸质）：
    # 未选择不等于放行，不得把牛奶声明显示为“已解除”
    baseline = make_plan([make_row("全脂奶粉", contains_milk=True)], ["milk_free"])
    current = make_plan([make_row("全脂奶粉")], ["gluten_free"])
    response = post_compare(baseline, current)
    assert response.status_code == 200
    body = response.json()
    # 两侧没有共同选择的声明：无三态结论
    assert body["comparisons"] == []
    # 两侧完整裁决仍各自保留
    assert body["baseline"]["printable"] is False
    assert body["current"]["printable"] is True


def test_claim_only_selected_on_one_side_is_excluded_from_comparison() -> None:
    # 现方案新增选择一条声明：该单侧声明不参与对比，共同声明照常
    baseline = make_plan([make_row("燕麦粉", contact_wheat=True)], ["gluten_free"])
    current = make_plan(
        [make_row("燕麦粉", contact_wheat=True)],
        ["gluten_free", "milk_free"],
    )
    response = post_compare(baseline, current)
    comps = response.json()["comparisons"]
    assert [item["claim"] for item in comps] == ["gluten_free"]
    assert comps[0]["status"] == "unchanged"


def test_extra_field_in_baseline_plan_returns_422_on_baseline_path() -> None:
    # 对照方案附带未定义字段：按对照路径返回字段级错误，不产生比较结果
    baseline = make_plan([make_row("白砂糖")], ["gluten_free"])
    baseline["snapshot_id"] = "abc"
    current = make_plan([make_row("白砂糖")], ["gluten_free"])
    response = post_compare(baseline, current)
    assert response.status_code == 422
    body = response.json()
    locations = [tuple(err["loc"]) for err in body["detail"]]
    assert ("body", "baseline", "snapshot_id") in locations
    assert "comparisons" not in body


def test_extra_top_level_field_in_compare_request_returns_422() -> None:
    baseline = make_plan([make_row("白砂糖")], ["gluten_free"])
    current = make_plan([make_row("白砂糖")], ["gluten_free"])
    response = client.post(
        "/api/compare",
        json={"baseline": baseline, "current": current, "trace": True},
    )
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "trace") in locations


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
