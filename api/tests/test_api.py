"""HTTP 层测试：真实 FastAPI 应用、422 字段级错误、不产生判定。"""
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


def make_row_payload(name: str = "原料", **flags: bool) -> dict:
    payload = {"name": name, **ALL_FLAGS}
    payload.update(flags)
    return payload


def make_request(rows: list[dict] | None = None, claims: list[str] | None = None) -> dict:
    return {
        "ingredients": rows if rows is not None else [make_row_payload()],
        "claims": claims if claims is not None else ["gluten_free"],
    }


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_clean_recipe_is_printable_full_contract() -> None:
    payload = make_request(
        rows=[make_row_payload("白砂糖"), make_row_payload("食用盐")],
        claims=["milk_free", "peanut_free", "gluten_free"],
    )
    response = client.post("/api/evaluate", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body["printable"] is True
    assert len(body["rows"]) == 2
    assert body["rows"][0] == {
        "row_index": 0, "name": "白砂糖",
        "direct_hits": [], "contact_hits": [],
    }
    for verdict in body["verdicts"]:
        assert verdict["allowed"] is True
        assert verdict["blocked_by"] == []


def test_direct_milk_hit_blocks_milk_free_claim() -> None:
    payload = make_request(
        rows=[make_row_payload("全脂奶粉", contains_milk=True)],
        claims=["milk_free", "gluten_free"],
    )
    response = client.post("/api/evaluate", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body["printable"] is False
    by_claim = {v["claim"]: v for v in body["verdicts"]}
    assert by_claim["milk_free"]["allowed"] is False
    evidence = by_claim["milk_free"]["blocked_by"][0]
    assert evidence == {
        "row_index": 0, "ingredient_name": "全脂奶粉",
        "target": "milk", "source": "direct",
    }
    assert by_claim["gluten_free"]["allowed"] is True


def test_contact_wheat_hit_blocks_gluten_without_direct_ingredient() -> None:
    # 这正是“配方原料与共线信息分开核对”容易漏掉的情形：
    # 直接成分里没有任何谷物，仅共线接触小麦，麸质声明仍须阻断
    payload = make_request(
        rows=[make_row_payload("燕麦粉", contact_wheat=True)],
        claims=["gluten_free"],
    )
    response = client.post("/api/evaluate", json=payload)
    body = response.json()
    assert body["printable"] is False
    verdict = body["verdicts"][0]
    assert verdict["allowed"] is False
    assert verdict["blocked_by"][0]["source"] == "contact"
    assert verdict["blocked_by"][0]["target"] == "wheat"
    assert body["rows"][0]["direct_hits"] == []
    assert body["rows"][0]["contact_hits"] == ["wheat"]


def test_invalid_claim_enum_returns_field_error_and_no_verdict() -> None:
    payload = make_request(claims=["gluten_fre"])  # 非法枚举
    response = client.post("/api/evaluate", json=payload)
    assert response.status_code == 422
    body = response.json()
    assert body["detail"]
    locations = {tuple(err["loc"]) for err in body["detail"]}
    assert any(loc[-1] == "claims" for loc in locations)
    for err in body["detail"]:
        assert err["type"] != "model_type"


def test_empty_ingredients_returns_field_error_and_no_verdict() -> None:
    payload = make_request(rows=[])
    response = client.post("/api/evaluate", json=payload)
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "ingredients") in locations


def test_empty_claims_returns_field_error() -> None:
    payload = make_request(claims=[])
    response = client.post("/api/evaluate", json=payload)
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "claims") in locations


def test_missing_contact_flag_returns_field_error_and_no_verdict() -> None:
    row = make_row_payload("大麦茶")
    del row["contact_barley"]  # 缺失共线标记
    response = client.post("/api/evaluate", json=make_request(rows=[row]))
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "ingredients", 0, "contact_barley") in locations


def test_missing_direct_flag_returns_field_error() -> None:
    row = make_row_payload("饼干")
    del row["contains_peanut"]
    response = client.post("/api/evaluate", json=make_request(rows=[row]))
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "ingredients", 0, "contains_peanut") in locations


def test_null_flag_returns_field_error() -> None:
    row = make_row_payload("未知粉", contact_milk=None)
    response = client.post("/api/evaluate", json=make_request(rows=[row]))
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "ingredients", 0, "contact_milk") in locations


def test_non_boolean_flag_returns_field_error() -> None:
    row = make_row_payload("奇怪原料", contains_wheat="yes")
    response = client.post("/api/evaluate", json=make_request(rows=[row]))
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "ingredients", 0, "contains_wheat") in locations


def test_blank_ingredient_name_returns_field_error() -> None:
    row = make_row_payload("   ")
    response = client.post("/api/evaluate", json=make_request(rows=[row]))
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "ingredients", 0, "name") in locations


def test_missing_ingredients_field_returns_field_error() -> None:
    response = client.post("/api/evaluate", json={"claims": ["milk_free"]})
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "ingredients") in locations


def test_unknown_target_boolean_does_not_exist() -> None:
    # 目标集合固定且穷尽：额外/别名标记不被接受
    row = {**make_row_payload("原料"), "contains_gluten": True}
    response = client.post("/api/evaluate", json=make_request(rows=[row]))
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert any(loc[-1] == "contains_gluten" for loc in locations)


def test_top_level_extra_field_returns_field_error() -> None:
    # 请求层同样 extra=forbid：方案级/请求级未定义字段不被静默接受
    payload = make_request()
    payload["snapshot_id"] = "abc"
    response = client.post("/api/evaluate", json=payload)
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "snapshot_id") in locations
