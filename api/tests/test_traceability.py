"""批次用料追溯：多层汇聚、稳定选路（最短层级 + 关系序号字典序）、
非法环路/引用/自引用/重复编号的字段级定位（且不产生结果）。"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def batch(code: str, material_name: str = "物料", batch_type: str = "raw_material") -> dict:
    return {"code": code, "material_name": material_name, "batch_type": batch_type}


def relation(source: str, target: str) -> dict:
    return {"from_code": source, "to_code": target}


def post_trace(payload: dict):
    return client.post("/api/trace", json=payload)


def make_request(
    batches: list[dict],
    relations: list[dict],
    source: str,
) -> dict:
    return {"batches": batches, "relations": relations, "source_code": source}


# ---------------------------------------------------------------------------
# 追溯基本规则：层级、路径、汇聚
# ---------------------------------------------------------------------------


def test_direct_usage_is_level_one_with_single_relation_path() -> None:
    payload = make_request(
        [
            batch("R-1", "花生原料", "raw_material"),
            batch("I-1", "花生中间料", "intermediate"),
        ],
        [relation("R-1", "I-1")],
        "R-1",
    )
    response = post_trace(payload)
    assert response.status_code == 200
    body = response.json()
    assert body["source_code"] == "R-1"
    assert body["source_material_name"] == "花生原料"
    assert body["source_batch_type"] == "raw_material"
    assert body["affected_count"] == 1

    assert [level["level"] for level in body["levels"]] == [1]
    affected = body["affected_batches"]
    assert affected[0] == {
        "code": "I-1",
        "material_name": "花生中间料",
        "batch_type": "intermediate",
        "level": 1,
        "path_codes": ["R-1", "I-1"],
        "path_relation_indices": [0],
        "path_steps": [
            {"relation_index": 0, "from_code": "R-1", "to_code": "I-1"}
        ],
    }


def test_multi_layer_propagation_from_source_to_intermediate_and_finished_good() -> None:
    # R-1(原料) -> I-1(中间料) -> F-1(成品)
    payload = make_request(
        [
            batch("R-1", "牛奶原料", "raw_material"),
            batch("I-1", "奶基中间料", "intermediate"),
            batch("F-1", "奶糖成品", "finished_good"),
        ],
        [relation("R-1", "I-1"), relation("I-1", "F-1")],
        "R-1",
    )
    response = post_trace(payload)
    assert response.status_code == 200
    body = response.json()

    assert body["affected_count"] == 2
    assert [level["level"] for level in body["levels"]] == [1, 2]
    assert [b["code"] for b in body["levels"][0]["batches"]] == ["I-1"]
    assert [b["code"] for b in body["levels"][1]["batches"]] == ["F-1"]

    finished = body["affected_batches"][1]
    assert finished["level"] == 2
    assert finished["path_codes"] == ["R-1", "I-1", "F-1"]
    assert finished["path_relation_indices"] == [0, 1]
    assert finished["path_steps"] == [
        {"relation_index": 0, "from_code": "R-1", "to_code": "I-1"},
        {"relation_index": 1, "from_code": "I-1", "to_code": "F-1"},
    ]


def test_only_batches_reachable_from_source_are_returned() -> None:
    # R-1 -> I-1；R-2 -> I-2 与污染源无关，不得出现在结果中
    payload = make_request(
        [
            batch("R-1"),
            batch("R-2"),
            batch("I-1", batch_type="intermediate"),
            batch("I-2", batch_type="intermediate"),
        ],
        [relation("R-1", "I-1"), relation("R-2", "I-2")],
        "R-1",
    )
    body = post_trace(payload).json()
    assert body["affected_count"] == 1
    assert [b["code"] for b in body["affected_batches"]] == ["I-1"]


def test_reverse_direction_is_not_traced() -> None:
    # 投料方向 I-1 -> R-1：以 R-1 为污染源时，上游中间料 I-1 不可达
    payload = make_request(
        [batch("R-1"), batch("I-1", batch_type="intermediate")],
        [relation("I-1", "R-1")],
        "R-1",
    )
    body = post_trace(payload).json()
    assert body["affected_count"] == 0
    assert body["levels"] == []
    assert body["affected_batches"] == []


def test_source_batch_itself_is_not_listed_as_affected() -> None:
    payload = make_request(
        [batch("R-1"), batch("I-1", batch_type="intermediate")],
        [relation("R-1", "I-1")],
        "R-1",
    )
    body = post_trace(payload).json()
    assert {b["code"] for b in body["affected_batches"]} == {"I-1"}
    assert all(b["level"] >= 1 for b in body["affected_batches"])


def test_multilayer_convergence_diamond_shape_keeps_shortest_paths() -> None:
    # 菱形汇聚：R -> I1, R -> I2, I1 -> F, I2 -> F
    # F 经两条路径到达（关系序列 [0,2] 与 [1,3]，层级相同，按关系序号
    # 字典序取更小的 [0,2]，即经 I1 的路径）
    payload = make_request(
        [
            batch("R", "污染原料", "raw_material"),
            batch("I1", batch_type="intermediate"),
            batch("I2", batch_type="intermediate"),
            batch("F", batch_type="finished_good"),
        ],
        [
            relation("R", "I1"),  # 0
            relation("R", "I2"),  # 1
            relation("I1", "F"),  # 2
            relation("I2", "F"),  # 3
        ],
        "R",
    )
    response = post_trace(payload)
    assert response.status_code == 200
    body = response.json()

    by_code = {b["code"]: b for b in body["affected_batches"]}
    assert by_code["I1"]["level"] == 1
    assert by_code["I2"]["level"] == 1
    assert by_code["F"]["level"] == 2
    # 两条路径等长，取关系序号字典序更小者：先 R->I1(序号0) 再 I1->F(序号2)
    assert by_code["F"]["path_relation_indices"] == [0, 2]
    assert by_code["F"]["path_codes"] == ["R", "I1", "F"]
    # 层级分组：第 2 层只有 F
    assert [b["code"] for b in body["levels"][1]["batches"]] == ["F"]


def test_path_with_more_levels_is_never_preferred_over_shorter_one() -> None:
    # R -> I -> F -> X（3 跳）之外，再补一条更短的 R -> X（1 跳）。
    # 即使短路径的关系序号更大，也必须选择更短层级。
    payload = make_request(
        [
            batch("R"),
            batch("I", batch_type="intermediate"),
            batch("F", batch_type="finished_good"),
            batch("X", batch_type="finished_good"),
        ],
        [
            relation("R", "I"),  # 0
            relation("I", "F"),  # 1
            relation("F", "X"),  # 2  长路径 R-I-F-X（序号 [0,1,2]）
            relation("R", "X"),  # 3  短路径 R-X（序号 [3]）
        ],
        "R",
    )
    body = post_trace(payload).json()
    by_code = {b["code"]: b for b in body["affected_batches"]}
    assert by_code["X"]["level"] == 1
    assert by_code["X"]["path_relation_indices"] == [3]
    assert by_code["X"]["path_codes"] == ["R", "X"]


# ---------------------------------------------------------------------------
# 稳定遍历：录入顺序
# ---------------------------------------------------------------------------


def test_same_level_batches_follow_entry_order() -> None:
    # 同一层级的两个直接下游，按关系录入顺序稳定排列
    payload = make_request(
        [batch("R"), batch("I-b", batch_type="intermediate"), batch("I-a", batch_type="intermediate")],
        [relation("R", "I-b"), relation("R", "I-a")],
        "R",
    )
    body = post_trace(payload).json()
    assert [b["code"] for b in body["levels"][0]["batches"]] == ["I-b", "I-a"]
    assert [b["code"] for b in body["affected_batches"]] == ["I-b", "I-a"]


def test_duplicate_relations_between_same_pair_are_all_kept_and_lower_index_wins() -> None:
    # 同一对批次之间存在多条录入关系时均合法；路径按关系序号字典序取更小者
    payload = make_request(
        [batch("R"), batch("I", batch_type="intermediate")],
        [relation("R", "I"), relation("R", "I")],
        "R",
    )
    response = post_trace(payload)
    assert response.status_code == 200
    body = response.json()
    assert body["affected_batches"][0]["path_relation_indices"] == [0]


def test_equal_level_paths_compare_full_relation_tuple_not_last_edge() -> None:
    # 同层级（均为 2 跳）两条路径在第二跳上不同：
    # 经 A：关系序列 [0,4]（R->A 序号0，A->Z 序号4，后者序号较大）
    # 经 B：关系序列 [1,2]（R->B 序号1，B->Z 序号2，末跳序号更小）
    # 只比较“末跳”会误选 [1,2]；正确的最短路径字典序是对完整序列比较，取 [0,4]。
    payload = make_request(
        [
            batch("R"),
            batch("A", batch_type="intermediate"),
            batch("B", batch_type="intermediate"),
            batch("D", batch_type="intermediate"),
            batch("Z", batch_type="finished_good"),
        ],
        [
            relation("R", "A"),  # 0
            relation("R", "B"),  # 1
            relation("B", "Z"),  # 2
            relation("R", "D"),  # 3
            relation("A", "Z"),  # 4
            relation("D", "Z"),  # 5
        ],
        "R",
    )
    body = post_trace(payload).json()
    by_code = {b["code"]: b for b in body["affected_batches"]}
    assert by_code["Z"]["level"] == 2
    assert by_code["Z"]["path_relation_indices"] == [0, 4]
    assert by_code["Z"]["path_codes"] == ["R", "A", "Z"]


def test_output_grouping_skips_empty_levels() -> None:
    # R -> A -> B（A 第1层，B 第2层）；无第 3 层，层级分组连续无空档
    payload = make_request(
        [batch("R"), batch("A", batch_type="intermediate"), batch("B", batch_type="finished_good")],
        [relation("R", "A"), relation("A", "B")],
        "R",
    )
    body = post_trace(payload).json()
    assert [level["level"] for level in body["levels"]] == [1, 2]
    assert body["affected_count"] == 2


def test_response_contract_keys_are_stable() -> None:
    payload = make_request(
        [batch("R-1", "原料"), batch("I-1", "中间料", "intermediate")],
        [relation("R-1", "I-1")],
        "R-1",
    )
    body = post_trace(payload).json()
    assert set(body.keys()) == {
        "source_code",
        "source_material_name",
        "source_batch_type",
        "affected_count",
        "levels",
        "affected_batches",
    }
    assert set(body["affected_batches"][0].keys()) == {
        "code",
        "material_name",
        "batch_type",
        "level",
        "path_codes",
        "path_relation_indices",
        "path_steps",
    }
    assert set(body["affected_batches"][0]["path_steps"][0].keys()) == {
        "relation_index",
        "from_code",
        "to_code",
    }


# ---------------------------------------------------------------------------
# 422 字段级错误：定位到具体批次或关系，且不产生结果
# ---------------------------------------------------------------------------


def assert_field_error(payload: dict, expected_loc: tuple[str | int, ...]) -> None:
    response = post_trace(payload)
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert expected_loc in locations
    assert set(response.json().keys()) == {"detail"}  # 错误响应不携带追溯结果


def test_blank_batch_code_returns_field_error_located_to_batch() -> None:
    assert_field_error(
        make_request(
            [batch("   "), batch("I-1", batch_type="intermediate")],
            [relation("   ", "I-1")],
            "   ",
        ),
        ("body", "batches", 0, "code"),
    )


def test_blank_material_name_returns_field_error_located_to_batch() -> None:
    assert_field_error(
        make_request(
            [{"code": "R-1", "material_name": "  ", "batch_type": "raw_material"}],
            [],
            "R-1",
        ),
        ("body", "batches", 0, "material_name"),
    )


def test_unknown_batch_type_returns_field_error_located_to_batch_type() -> None:
    assert_field_error(
        make_request([batch("R-1", batch_type="semi")], [], "R-1"),
        ("body", "batches", 0, "batch_type"),
    )


def test_duplicate_codes_return_field_error_located_to_each_duplicate() -> None:
    response = post_trace(
        make_request(
            [batch("SAME"), batch(" SAME "), batch("OTHER")],
            [],
            "SAME",
        )
    )
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    # 两个同编号批次（含首个）各自定位到自身 code；第三个无关批次不报错
    assert ("body", "batches", 0, "code") in locations
    assert ("body", "batches", 1, "code") in locations
    assert not any(loc[:3] == ("batches", 2, "code") for loc in (l[1:] for l in locations))
    assert set(response.json().keys()) == {"detail"}


def test_missing_relation_source_endpoint_returns_field_error_located_to_relation() -> None:
    assert_field_error(
        make_request(
            [batch("R-1"), batch("I-1", batch_type="intermediate")],
            [relation("GHOST", "I-1")],
            "R-1",
        ),
        ("body", "relations", 0, "from_code"),
    )


def test_missing_relation_target_endpoint_returns_field_error_located_to_relation() -> None:
    assert_field_error(
        make_request(
            [batch("R-1")],
            [relation("R-1", "GHOST")],
            "R-1",
        ),
        ("body", "relations", 0, "to_code"),
    )


def test_self_reference_returns_field_error_located_to_relation() -> None:
    assert_field_error(
        make_request(
            [batch("R-1"), batch("I-1", batch_type="intermediate")],
            [relation("R-1", "I-1"), relation("I-1", "I-1")],
            "R-1",
        ),
        ("body", "relations", 1, "to_code"),
    )


def test_cycle_returns_field_error_located_to_each_relation_on_the_cycle() -> None:
    # 环：A -> B（关系0），B -> A（关系1）；两条关系都在环上，分别定位
    response = post_trace(
        make_request(
            [batch("A", batch_type="intermediate"), batch("B", batch_type="intermediate")],
            [relation("A", "B"), relation("B", "A")],
            "A",
        )
    )
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "relations", 0, "to_code") in locations
    assert ("body", "relations", 1, "to_code") in locations
    assert set(response.json().keys()) == {"detail"}  # 成环不产生追溯结果
    assert all("成环" in err["msg"] for err in response.json()["detail"])


def test_three_node_cycle_relations_are_all_located_and_offramp_is_not() -> None:
    # 环 A->B->C->A（关系 0,1,2）；关系 3（C->F）是环的“出口”，不在环上
    response = post_trace(
        make_request(
            [
                batch("A", batch_type="intermediate"),
                batch("B", batch_type="intermediate"),
                batch("C", batch_type="intermediate"),
                batch("F", batch_type="finished_good"),
            ],
            [
                relation("A", "B"),
                relation("B", "C"),
                relation("C", "A"),
                relation("C", "F"),
            ],
            "A",
        )
    )
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "relations", 0, "to_code") in locations
    assert ("body", "relations", 1, "to_code") in locations
    assert ("body", "relations", 2, "to_code") in locations
    # 出口关系不参与环，不应被标记成环
    assert ("body", "relations", 3, "to_code") not in locations


def test_cycle_unreachable_from_source_is_still_rejected_with_no_result() -> None:
    # 环与污染源不连通时仍然拒绝整张图（关系成环是图级非法，不产生任何追溯结果）
    response = post_trace(
        make_request(
            [
                batch("R"),
                batch("I", batch_type="intermediate"),
                batch("A", batch_type="intermediate"),
                batch("B", batch_type="intermediate"),
            ],
            [
                relation("R", "I"),
                relation("A", "B"),
                relation("B", "A"),
            ],
            "R",
        )
    )
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "relations", 1, "to_code") in locations
    assert ("body", "relations", 2, "to_code") in locations
    assert set(response.json().keys()) == {"detail"}


def test_unknown_source_code_returns_field_error_located_to_source() -> None:
    assert_field_error(
        make_request([batch("R-1")], [], "UNKNOWN"),
        ("body", "source_code"),
    )


def test_empty_batches_returns_field_error() -> None:
    response = post_trace({"batches": [], "relations": [], "source_code": "R-1"})
    assert response.status_code == 422
    assert ("body", "batches") in [tuple(err["loc"]) for err in response.json()["detail"]]


def test_missing_source_code_returns_field_error() -> None:
    response = post_trace({"batches": [batch("R-1")], "relations": []})
    assert response.status_code == 422
    assert ("body", "source_code") in [
        tuple(err["loc"]) for err in response.json()["detail"]
    ]


def test_unknown_extra_fields_are_rejected_at_each_level() -> None:
    # 批次层额外字段
    extra_batch = batch("R-1")
    extra_batch["allergen"] = "milk"
    response = post_trace(make_request([extra_batch], [], "R-1"))
    assert response.status_code == 422
    assert ("body", "batches", 0, "allergen") in [
        tuple(err["loc"]) for err in response.json()["detail"]
    ]

    # 关系层额外字段
    extra_relation = relation("R-1", "I-1")
    extra_relation["quantity"] = 3
    response = post_trace(
        make_request(
            [batch("R-1"), batch("I-1", batch_type="intermediate")],
            [extra_relation],
            "R-1",
        )
    )
    assert response.status_code == 422
    assert ("body", "relations", 0, "quantity") in [
        tuple(err["loc"]) for err in response.json()["detail"]
    ]

    # 请求层额外字段
    payload = make_request([batch("R-1")], [], "R-1")
    payload["snapshot_id"] = "x"
    response = post_trace(payload)
    assert response.status_code == 422
    assert ("body", "snapshot_id") in [
        tuple(err["loc"]) for err in response.json()["detail"]
    ]


def test_blank_relation_endpoint_is_structural_error_located_to_relation_field() -> None:
    payload = {
        "batches": [batch("R-1"), batch("I-1", batch_type="intermediate")],
        "relations": [{"from_code": "   ", "to_code": "I-1"}],
        "source_code": "R-1",
    }
    response = post_trace(payload)
    assert response.status_code == 422
    assert ("body", "relations", 0, "from_code") in [
        tuple(err["loc"]) for err in response.json()["detail"]
    ]


def test_multiple_errors_are_reported_together_and_no_result_is_produced() -> None:
    # 同时存在缺失端点、自引用与未知污染源：一次给全，且不产生结果
    response = post_trace(
        make_request(
            [batch("R-1"), batch("I-1", batch_type="intermediate")],
            [relation("GHOST", "I-1"), relation("R-1", "R-1")],
            "UNKNOWN",
        )
    )
    assert response.status_code == 422
    locations = [tuple(err["loc"]) for err in response.json()["detail"]]
    assert ("body", "relations", 0, "from_code") in locations
    assert ("body", "relations", 1, "to_code") in locations
    assert ("body", "source_code") in locations
    assert set(response.json().keys()) == {"detail"}
