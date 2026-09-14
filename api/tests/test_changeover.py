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


def make_request(
    batches: list[dict],
    cleaned: list[bool] | None = None,
    cleared: list[list[str] | None] | None = None,
) -> dict:
    if cleaned is None:
        cleaned = [False] * (len(batches) - 1)
    boundaries: list[dict] = []
    for index, flag in enumerate(cleaned):
        boundary = {"cleaned": flag}
        if cleared is not None and index < len(cleared) and cleared[index] is not None:
            boundary["cleared_targets"] = cleared[index]
        boundaries.append(boundary)
    return {"batches": batches, "boundaries": boundaries}


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
    assert boundary == {
        "boundary_index": 0,
        "cleaned": True,
        "residue_cleared": True,
        "cleared_targets": ["milk", "peanut", "wheat", "barley", "rye"],
    }


def test_uncleaned_boundary_keeps_residue_and_is_reported_as_not_cleared() -> None:
    payload = make_request(
        [make_batch("A", contains_milk=True), make_batch("B")], cleaned=[False]
    )
    response = post_changeover(payload)
    boundary = response.json()["boundaries"][0]
    assert boundary == {
        "boundary_index": 0,
        "cleaned": False,
        "residue_cleared": False,
        "cleared_targets": [],
    }
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


# ---------------------------------------------------------------------------
# 局部清洁：仅移除指定已清除目标，保留项继续携带最近来源
# ---------------------------------------------------------------------------


def test_partial_cleaning_removes_peanut_but_keeps_milk_carrying_its_source() -> None:
    # A 同时留下牛奶与花生；A/B 之间仅验证清除花生：
    # B 的进入残留只有牛奶，花生不得继续带入；牛奶来源仍指向 A
    payload = make_request(
        [
            make_batch("A", contains_milk=True, contains_peanut=True),
            make_batch("B"),
            make_batch("C"),
        ],
        cleaned=[False, False],
        cleared=[["peanut"], None],
    )
    response = post_changeover(payload)
    assert response.status_code == 200
    batches = response.json()["batches"]
    boundary = response.json()["boundaries"][0]

    assert batches[1]["incoming_residue"] == [item("milk", 0, "A")]
    assert batches[1]["carried_over"] == [item("milk", 0, "A")]
    assert batches[1]["outgoing_residue"] == [item("milk", 0, "A")]
    # 局部清洁不是全部清洁：cleaned_before 仍为 false
    assert batches[1]["cleaned_before"] is False
    # 牛奶保留最近来源继续携带到第三批
    assert batches[2]["incoming_residue"] == [item("milk", 0, "A")]

    assert boundary == {
        "boundary_index": 0,
        "cleaned": False,
        "residue_cleared": False,
        "cleared_targets": ["peanut"],
    }
    # 未指定清除目标的边界保持空清除列表
    assert response.json()["boundaries"][1]["cleared_targets"] == []


def test_partial_cleaning_keeps_other_targets_union_with_direct_ingredients() -> None:
    # A 留下花生/小麦；边界仅清除花生；B 直接含牛奶：
    # B 离开残留 = 保留的小麦 ∪ 本批牛奶，各自保留最近来源
    payload = make_request(
        [
            make_batch("A", contains_peanut=True, contains_wheat=True),
            make_batch("B", contains_milk=True),
        ],
        cleaned=[False],
        cleared=[["peanut"]],
    )
    response = post_changeover(payload)
    batches = response.json()["batches"]
    assert batches[1]["incoming_residue"] == [item("wheat", 0, "A")]
    assert batches[1]["carried_over"] == [item("wheat", 0, "A")]
    assert batches[1]["outgoing_residue"] == [
        item("milk", 1, "B"),
        item("wheat", 0, "A"),
    ]


def test_partial_cleaning_multiple_targets_reported_in_fixed_order() -> None:
    # 指定顺序乱序不影响响应的固定目标顺序
    payload = make_request(
        [
            make_batch("A", contains_milk=True, contains_peanut=True, contains_wheat=True),
            make_batch("B"),
        ],
        cleaned=[False],
        cleared=[["wheat", "milk"]],
    )
    response = post_changeover(payload)
    boundary = response.json()["boundaries"][0]
    assert boundary["cleared_targets"] == ["milk", "wheat"]
    assert boundary["residue_cleared"] is False
    # 仅花生继续带入
    assert response.json()["batches"][1]["incoming_residue"] == [item("peanut", 0, "A")]


def test_partial_cleaning_target_absent_from_residue_still_confirmed_in_boundary() -> None:
    # 指定清除的目标若不在上一批离开残留中，边界结果仍确认该清除项（清洁验证已执行）
    payload = make_request(
        [make_batch("A", contains_milk=True), make_batch("B")],
        cleaned=[False],
        cleared=[["peanut", "milk"]],
    )
    response = post_changeover(payload)
    assert response.status_code == 200
    assert response.json()["boundaries"][0]["cleared_targets"] == ["milk", "peanut"]
    assert response.json()["batches"][1]["incoming_residue"] == []


def test_full_cleaning_without_new_field_still_zeros_everything() -> None:
    # 全部清洁：五类清除项全部确认，下一批进入残留归零
    payload = make_request(
        [
            make_batch("A", contains_milk=True, contains_peanut=True, contains_wheat=True),
            make_batch("B"),
        ],
        cleaned=[True],
    )
    response = post_changeover(payload)
    body = response.json()
    assert body["batches"][1]["incoming_residue"] == []
    assert body["batches"][1]["outgoing_residue"] == []
    assert body["boundaries"][0] == {
        "boundary_index": 0,
        "cleaned": True,
        "residue_cleared": True,
        "cleared_targets": ["milk", "peanut", "wheat", "barley", "rye"],
    }


def test_legacy_request_with_only_cleaned_flag_keeps_all_or_nothing_semantics() -> None:
    # 旧客户端只发 cleaned 布尔：true=全清，false=不清，响应正常（兼容）
    for flag, expect_incoming in ((True, []), (False, [item("peanut", 0, "A")])):
        legacy_payload = {
            "batches": [make_batch("A", contains_peanut=True), make_batch("B")],
            "boundaries": [{"cleaned": flag}],
        }
        response = post_changeover(legacy_payload)
        assert response.status_code == 200
        assert response.json()["batches"][1]["incoming_residue"] == expect_incoming
        assert "cleared_targets" in response.json()["boundaries"][0]


def test_explicit_null_cleared_targets_field_means_no_partial_cleaning() -> None:
    # 显式传 null 与缺省等价：未清洁语义
    payload = {
        "batches": [make_batch("A", contains_peanut=True), make_batch("B")],
        "boundaries": [{"cleaned": False, "cleared_targets": None}],
    }
    response = post_changeover(payload)
    assert response.status_code == 200
    assert response.json()["batches"][1]["incoming_residue"] == [item("peanut", 0, "A")]
    assert response.json()["boundaries"][0]["cleared_targets"] == []


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
        "cleared_targets",
    }
    # 未清洁边界不确认任何清除项
    assert body["boundaries"][0]["cleared_targets"] == []
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
        make_request(
            [make_batch("同一名称"), make_batch(" 同一名称 "), make_batch("同一名称")]
        )
    )
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    # 三个同名批次都参与重复：首个出现者与后两个一样各自定位到自身 name
    assert ("body", "batches", 0, "name") in locations
    assert ("body", "batches", 1, "name") in locations
    assert ("body", "batches", 2, "name") in locations
    assert set(response.json().keys()) == {"detail"}  # 不产生结果


def test_two_duplicate_batch_names_both_located() -> None:
    response = post_changeover(
        make_request([make_batch("同名"), make_batch("同名")])
    )
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "batches", 0, "name") in locations
    assert ("body", "batches", 1, "name") in locations


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


def test_empty_cleared_targets_returns_field_error_located_to_boundary() -> None:
    payload = make_request(
        [make_batch("A"), make_batch("B")],
        cleaned=[False],
        cleared=[[]],
    )
    response = post_changeover(payload)
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "boundaries", 0, "cleared_targets") in locations
    assert set(response.json().keys()) == {"detail"}  # 不产生结果


def test_duplicate_cleared_targets_returns_field_error_located_to_boundary() -> None:
    payload = make_request(
        [make_batch("A"), make_batch("B")],
        cleaned=[False],
        cleared=[["peanut", "peanut"]],
    )
    response = post_changeover(payload)
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "boundaries", 0, "cleared_targets") in locations
    assert "重复" in response.json()["detail"][0]["msg"]


def test_cleared_target_outside_five_allergens_returns_field_error() -> None:
    # 枚举白名单由 Pydantic 拦截，loc 精确定位到越界项所在边界字段
    payload = make_request(
        [make_batch("A"), make_batch("B")],
        cleaned=[False],
        cleared=[["soy"]],
    )
    response = post_changeover(payload)
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "boundaries", 0, "cleared_targets", 0) in locations


def test_non_string_cleared_target_returns_field_error_located_to_boundary() -> None:
    payload = make_request(
        [make_batch("A"), make_batch("B")],
        cleaned=[False],
        cleared=[[1]],
    )
    response = post_changeover(payload)
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "boundaries", 0, "cleared_targets", 0) in locations


def test_cleared_targets_conflicting_with_full_cleaning_returns_field_error() -> None:
    payload = make_request(
        [make_batch("A"), make_batch("B")],
        cleaned=[True],
        cleared=[["peanut"]],
    )
    response = post_changeover(payload)
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "boundaries", 0, "cleared_targets") in locations
    assert "冲突" in response.json()["detail"][0]["msg"]
    assert set(response.json().keys()) == {"detail"}


def test_partial_cleaning_errors_are_located_independently_per_boundary() -> None:
    # 三条边界各自非法时分别定位，不产生结果
    payload = {
        "batches": [make_batch("A"), make_batch("B"), make_batch("C"), make_batch("D")],
        "boundaries": [
            {"cleaned": False, "cleared_targets": []},
            {"cleaned": False, "cleared_targets": ["wheat", "wheat"]},
            {"cleaned": True, "cleared_targets": ["milk"]},
        ],
    }
    response = post_changeover(payload)
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "boundaries", 0, "cleared_targets") in locations
    assert ("body", "boundaries", 1, "cleared_targets") in locations
    assert ("body", "boundaries", 2, "cleared_targets") in locations
    assert set(response.json().keys()) == {"detail"}


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
