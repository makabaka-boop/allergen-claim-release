"""换线残留推演：连续带入、经验证清洁归零、直接成分不误报、422 字段级定位。"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

DIRECT_FLAGS = (
    "contains_milk",
    "contains_peanut",
    "contains_wheat",
    "contains_barley",
    "contains_rye",
)


def make_batch(name: str = "批次", **flags: bool) -> dict:
    payload = {"name": name, **{flag: False for flag in DIRECT_FLAGS}}
    payload.update(flags)
    return payload


def make_request(batches: list[dict], cleaned: list[bool] | None = None) -> dict:
    if cleaned is None:
        cleaned = [False] * (len(batches) - 1)
    return {"batches": batches, "boundaries": [{"cleaned": flag} for flag in cleaned]}


def post_changeover(payload: dict):
    return client.post("/api/changeover", json=payload)


def item(target: str, index: int, name: str) -> dict:
    return {"target": target, "source_batch_index": index, "source_batch_name": name}


# ---------------------------------------------------------------------------
# 推演规则
# ---------------------------------------------------------------------------


def test_first_batch_starts_with_no_incoming_residue() -> None:
    response = post_changeover(make_request([make_batch("A", contains_peanut=True), make_batch("B")]))
    assert response.status_code == 200
    first = response.json()["batches"][0]
    assert first["incoming_residue"] == []
    assert first["carried_over"] == []
    assert first["outgoing_residue"] == [item("peanut", 0, "A")]
    assert first["cleaned_before"] is None


def test_residue_carries_continuously_across_uncleaned_boundaries() -> None:
    # A 含花生 -> B 干净 -> C 干净：花生残留连续带入，来源始终指向 A
    payload = make_request(
        [
            make_batch("A-花生酱", contains_peanut=True),
            make_batch("B-中转"),
            make_batch("C-燕麦粉"),
        ]
    )
    response = post_changeover(payload)
    assert response.status_code == 200
    batches = response.json()["batches"]

    assert batches[1]["incoming_residue"] == [item("peanut", 0, "A-花生酱")]
    assert batches[1]["carried_over"] == [item("peanut", 0, "A-花生酱")]
    assert batches[1]["outgoing_residue"] == [item("peanut", 0, "A-花生酱")]
    assert batches[1]["cleaned_before"] is False

    # 连续带入到第三批：仍是上一批残留，来源批次依旧是 A
    assert batches[2]["incoming_residue"] == [item("peanut", 0, "A-花生酱")]
    assert batches[2]["carried_over"] == [item("peanut", 0, "A-花生酱")]
    assert batches[2]["outgoing_residue"] == [item("peanut", 0, "A-花生酱")]


def test_outgoing_residue_is_union_of_incoming_and_direct_ingredients() -> None:
    # A 留下花生；B 直接含小麦且未清洁：离开残留为两者并集
    payload = make_request(
        [
            make_batch("A", contains_peanut=True),
            make_batch("B", contains_wheat=True),
            make_batch("C"),
        ]
    )
    response = post_changeover(payload)
    batches = response.json()["batches"]
    assert batches[1]["outgoing_residue"] == [
        item("peanut", 0, "A"),
        item("wheat", 1, "B"),
    ]
    # C 同时看到两项带入，各自保留不同的来源批次
    assert batches[2]["incoming_residue"] == [
        item("peanut", 0, "A"),
        item("wheat", 1, "B"),
    ]
    assert batches[2]["carried_over"] == batches[2]["incoming_residue"]


def test_direct_ingredient_is_not_reported_as_carried_over_but_refreshes_source() -> None:
    # A 含花生 -> B 也直接含花生：花生在 B 是直接成分，不算“前序带入”；
    # 但离开残留中花生的最近来源刷新为 B，后续批次看到的来源是 B
    payload = make_request(
        [
            make_batch("A", contains_peanut=True),
            make_batch("B", contains_peanut=True),
            make_batch("C"),
        ]
    )
    response = post_changeover(payload)
    batches = response.json()["batches"]

    assert batches[1]["direct_ingredients"] == ["peanut"]
    assert batches[1]["incoming_residue"] == [item("peanut", 0, "A")]
    # 直接成分不得误报为带入物
    assert batches[1]["carried_over"] == []
    # 最近来源批次刷新为 B
    assert batches[1]["outgoing_residue"] == [item("peanut", 1, "B")]
    assert batches[2]["incoming_residue"] == [item("peanut", 1, "B")]
    assert batches[2]["carried_over"] == [item("peanut", 1, "B")]


def test_validated_cleaning_clears_residue_before_next_batch_starts() -> None:
    # A 留下花生与小麦；A/B 之间经验证清洁：B 从零开始
    payload = make_request(
        [
            make_batch("A", contains_peanut=True, contains_wheat=True),
            make_batch("B"),
        ],
        cleaned=[True],
    )
    response = post_changeover(payload)
    batches = response.json()["batches"]
    boundary = response.json()["boundaries"][0]

    assert batches[1]["cleaned_before"] is True
    assert batches[1]["incoming_residue"] == []
    assert batches[1]["carried_over"] == []
    assert batches[1]["outgoing_residue"] == []
    assert boundary == {"boundary_index": 0, "cleaned": True, "residue_cleared": True}


def test_uncleaned_boundary_keeps_residue_and_is_reported_as_not_cleared() -> None:
    payload = make_request(
        [make_batch("A", contains_milk=True), make_batch("B")], cleaned=[False]
    )
    response = post_changeover(payload)
    boundary = response.json()["boundaries"][0]
    assert boundary == {"boundary_index": 0, "cleaned": False, "residue_cleared": False}
    assert response.json()["batches"][1]["incoming_residue"] == [item("milk", 0, "A")]


def test_cleaning_only_clears_residue_at_that_boundary_later_introduction_remains() -> None:
    # A 花生（未清洁带入 B）-> B/C 间经验证清洁 -> C 含牛奶 -> D 干净
    # C 看不到 A 的花生，但 D 必须看到 C 新引入的牛奶
    payload = make_request(
        [
            make_batch("A", contains_peanut=True),
            make_batch("B"),
            make_batch("C", contains_milk=True),
            make_batch("D"),
        ],
        cleaned=[False, True, False],
    )
    response = post_changeover(payload)
    batches = response.json()["batches"]

    assert batches[2]["incoming_residue"] == []  # 清洁归零
    assert batches[2]["outgoing_residue"] == [item("milk", 2, "C")]
    assert batches[3]["incoming_residue"] == [item("milk", 2, "C")]
    assert batches[3]["carried_over"] == [item("milk", 2, "C")]


def test_response_contract_keys_are_stable() -> None:
    response = post_changeover(
        make_request([make_batch("A", contains_barley=True), make_batch("B")])
    )
    assert response.status_code == 200
    body = response.json()
    assert set(body.keys()) == {"batches", "boundaries"}
    assert set(body["batches"][0].keys()) == {
        "batch_index",
        "name",
        "direct_ingredients",
        "incoming_residue",
        "carried_over",
        "outgoing_residue",
        "cleaned_before",
    }
    assert body["batches"][0]["incoming_residue"] == []  # 首批无进入残留
    assert set(body["boundaries"][0].keys()) == {
        "boundary_index",
        "cleaned",
        "residue_cleared",
    }
    assert set(body["batches"][1]["incoming_residue"][0].keys()) == {
        "target",
        "source_batch_index",
        "source_batch_name",
    }


# ---------------------------------------------------------------------------
# 422 字段级错误：定位到具体批次或边界，且不产生结果
# ---------------------------------------------------------------------------


def assert_field_error(payload: dict, expected_loc: tuple[str | int, ...]) -> None:
    response = post_changeover(payload)
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert expected_loc in locations
    assert set(response.json().keys()) == {"detail"}  # 错误响应不携带推演结果


def test_fewer_than_two_batches_returns_field_error_and_no_result() -> None:
    assert_field_error(make_request([make_batch("A")], cleaned=[]), ("body", "batches"))


def test_missing_batches_field_returns_field_error() -> None:
    response = post_changeover({"boundaries": []})
    assert response.status_code == 422
    assert ("body", "batches") in [tuple(err["loc"]) for err in response.json()["detail"]]


def test_blank_batch_name_returns_field_error_located_to_batch() -> None:
    assert_field_error(
        make_request([make_batch("   "), make_batch("B")]),
        ("body", "batches", 0, "name"),
    )


def test_duplicate_batch_names_return_field_error_located_to_each_duplicate() -> None:
    response = post_changeover(
        make_request([make_batch("同一名称"), make_batch("B"), make_batch(" 同一名称 ")])
    )
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    # 第二个重复批次定位到自身 name；首个出现的批次不报错
    assert ("body", "batches", 2, "name") in locations
    assert ("body", "batches", 0, "name") not in locations


def test_missing_cleaning_boundaries_returns_field_error() -> None:
    response = post_changeover({"batches": [make_batch("A"), make_batch("B")]})
    assert response.status_code == 422
    assert ("body", "boundaries") in [tuple(err["loc"]) for err in response.json()["detail"]]


def test_boundary_count_mismatch_returns_field_error_located_to_boundaries() -> None:
    # 3 个批次需要 2 条边界，只给 1 条
    payload = make_request(
        [make_batch("A"), make_batch("B"), make_batch("C")], cleaned=[False]
    )
    response = post_changeover(payload)
    assert response.status_code == 422
    assert ("body", "boundaries") in [tuple(err["loc"]) for err in response.json()["detail"]]


def test_missing_cleaned_flag_returns_field_error_located_to_boundary() -> None:
    payload = {"batches": [make_batch("A"), make_batch("B")], "boundaries": [{}]}
    response = post_changeover(payload)
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "boundaries", 0, "cleaned") in locations


def test_non_boolean_cleaned_flag_returns_field_error() -> None:
    response = post_changeover(
        make_request([make_batch("A"), make_batch("B")], cleaned=["true"])  # type: ignore[list-item]
    )
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "boundaries", 0, "cleaned") in locations


def test_null_cleaned_flag_returns_field_error() -> None:
    payload = {"batches": [make_batch("A"), make_batch("B")], "boundaries": [{"cleaned": None}]}
    response = post_changeover(payload)
    assert response.status_code == 422
    assert ("body", "boundaries", 0, "cleaned") in [
        tuple(err["loc"]) for err in response.json()["detail"]
    ]


def test_non_boolean_direct_ingredient_flag_returns_field_error_located_to_batch() -> None:
    payload = make_request(
        [make_batch("A"), make_batch("B", contains_rye=1)]  # type: ignore[arg-type]
    )
    response = post_changeover(payload)
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "batches", 1, "contains_rye") in locations


def test_missing_direct_ingredient_flag_returns_field_error_located_to_batch() -> None:
    batch = make_batch("B")
    del batch["contains_barley"]
    response = post_changeover(make_request([make_batch("A"), batch]))
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "batches", 1, "contains_barley") in locations


def test_unknown_extra_field_on_batch_returns_field_error() -> None:
    batch = make_batch("B")
    batch["contains_gluten"] = True
    response = post_changeover(make_request([make_batch("A"), batch]))
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "batches", 1, "contains_gluten") in locations


def test_top_level_extra_field_returns_field_error() -> None:
    payload = make_request([make_batch("A"), make_batch("B")])
    payload["snapshot_id"] = "x"
    response = post_changeover(payload)
    assert response.status_code == 422
    assert ("body", "snapshot_id") in [tuple(err["loc"]) for err in response.json()["detail"]]


def test_structural_and_sequence_errors_each_located_without_result() -> None:
    # 结构非法（非布尔标记）由 Pydantic 在进入推演前拦截，精确定位到批次字段
    bad_flag = make_request(
        [make_batch("A", contains_milk="yes"), make_batch("B")]  # type: ignore[arg-type]
    )
    flag_response = post_changeover(bad_flag)
    assert flag_response.status_code == 422
    assert ("body", "batches", 0, "contains_milk") in [
        tuple(err["loc"]) for err in flag_response.json()["detail"]
    ]
    assert set(flag_response.json().keys()) == {"detail"}

    # 结构合法后，序列级错误（重名）才由服务校验并定位到批次名称
    duplicate = make_request([make_batch("同名"), make_batch("同名")])
    dup_response = post_changeover(duplicate)
    assert dup_response.status_code == 422
    assert ("body", "batches", 1, "name") in [
        tuple(err["loc"]) for err in dup_response.json()["detail"]
    ]
    assert all(
        set(err.keys()) == {"loc", "msg", "type"} for err in dup_response.json()["detail"]
    )
