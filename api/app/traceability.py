"""批次用料追溯：以物料批次及其投料关系为核心对象。

用户录入批次台账（批次编号、物料名称、批次类型）与“来源批次投入目标
批次”的投料关系，选定一个污染源批次后发起追溯。本模块完成两件事：

1. :func:`validate_graph` 统一校验整份关系图与污染源：
   - 批次编号空白（由 Pydantic 拦截）、编号重复（台账内）；
   - 投料关系端点（from_code/to_code）在台账中不存在；
   - 自引用（来源与目标为同一批次）；
   - 关系成环；
   - 污染源编号在台账中不存在。
   任一不满足都抛出 FastAPI 标准 422，loc 精确定位到具体批次或关系，
   **不产生任何追溯结果**。

2. :func:`trace` 以**录入顺序稳定遍历**（BFS，邻接按关系录入序号排列），
   只返回可从污染源沿投料方向到达的批次。同一批次经多条路径到达时，
   选择**层级最少（跳数最少）且关系序号序列字典序最小**的最短投料路径。
"""
from __future__ import annotations

from collections import deque

from fastapi.exceptions import RequestValidationError

from .schemas import (
    TraceabilityRequest,
    TraceabilityResponse,
    TraceBatchInput,
    TraceLevelGroup,
    TracePathStep,
    TracedBatch,
)


def _field_error(loc: tuple[str | int, ...], message: str) -> dict[str, object]:
    """构造 FastAPI 标准 422 detail 中的单条字段错误。"""
    return {"loc": ("body", *loc), "msg": message, "type": "value_error"}


def _find_cyclic_relations(
    codes: list[str], adjacency: dict[str, list[tuple[str, int]]]
) -> list[int]:
    """返回参与有向环的投料关系序号（含自引用之外的环；自引用另行处理）。

    一条关系 u→v 参与某个有向环，当且仅当从 v 能沿投料方向回到 u。
    对每条关系做一次从其目标端出发的可达性搜索（邻接按关系序号排列，
    结果稳定）。图规模为录入批次量级，平方复杂度可接受且实现直白、
    无需维护 Tarjan 栈，便于核对。
    """
    code_set = set(codes)
    cyclic: list[int] = []

    def reaches(start: str, target: str) -> bool:
        """从 start 沿投料方向是否能到达 target。"""
        seen: set[str] = {start}
        queue: deque[str] = deque([start])
        while queue:
            current = queue.popleft()
            for nxt, _ in adjacency.get(current, ()):
                if nxt not in code_set:
                    continue
                if nxt == target:
                    return True
                if nxt not in seen:
                    seen.add(nxt)
                    queue.append(nxt)
        return False

    # 调用方按关系录入顺序遍历，此处保持顺序收集
    for code in codes:
        for nxt, relation_index in adjacency.get(code, ()):
            if nxt == code:
                continue  # 自引用有独立报错，不计入“成环”列表
            if nxt in code_set and reaches(nxt, code):
                cyclic.append(relation_index)
    return cyclic


def validate_graph(request: TraceabilityRequest) -> None:
    """校验批次编号重复、关系端点引用、自引用、成环与污染源引用。

    结构问题（编号/名称空白、类型未知、字段缺失或多余）已由 Pydantic
    拦截；这里只处理需要跨记录或需要图分析的约束。任何一条不满足即
    抛出 RequestValidationError（FastAPI 转 422），不产生追溯结果。
    """
    errors: list[dict[str, object]] = []

    # 编号去空白后判重：所有参与重复的批次（含首次出现者）各自定位到 code
    code_positions: dict[str, list[int]] = {}
    for index, batch in enumerate(request.batches):
        code_positions.setdefault(batch.code.strip(), []).append(index)
    for positions in code_positions.values():
        if len(positions) < 2:
            continue
        for order, index in enumerate(positions):
            if order == 0:
                others = "、".join(f"第 {pos + 1} 个批次" for pos in positions[1:])
                message = f"批次编号与{others}重复：台账内批次编号必须唯一"
            else:
                message = (
                    f"批次编号与第 {positions[0] + 1} 个批次重复："
                    "台账内批次编号必须唯一"
                )
            errors.append(_field_error(("batches", index, "code"), message))

    # 编号有效（非空白，已由 Pydantic 保证）时建立编号集合；
    # 存在编号重复时编号集合仍可用于端点引用校验（重复项另已报错）
    known_codes = {batch.code for batch in request.batches}

    # 构造邻接：来源编号 -> [(目标编号, 关系录入序号)]，按关系录入顺序追加
    adjacency: dict[str, list[tuple[str, int]]] = {}
    for index, relation in enumerate(request.relations):
        source_known = relation.from_code in known_codes
        target_known = relation.to_code in known_codes
        if not source_known:
            errors.append(
                _field_error(
                    ("relations", index, "from_code"),
                    f"关系的来源批次编号 {relation.from_code!r} 在批次台账中不存在："
                    "投料关系两端必须都已录入",
                )
            )
        if not target_known:
            errors.append(
                _field_error(
                    ("relations", index, "to_code"),
                    f"关系的目标批次编号 {relation.to_code!r} 在批次台账中不存在："
                    "投料关系两端必须都已录入",
                )
            )
        # 自引用：两端指向同一（存在的）批次
        if source_known and target_known and relation.from_code == relation.to_code:
            errors.append(
                _field_error(
                    ("relations", index, "to_code"),
                    f"关系自引用：来源批次与目标批次均为 {relation.from_code!r}，"
                    "投料关系不得把批次投入自身",
                )
            )
        # 只有来源端存在时才挂邻接，避免 KeyError；目标端缺失不影响图分析
        if source_known:
            adjacency.setdefault(relation.from_code, []).append(
                (relation.to_code, index)
            )

    # 成环：在“端点均存在”的图上检测。若已有引用/自引用错误，仍继续
    # 报告成环（错误一次给全），但成环判定忽略缺失目标端与自引用。
    cyclic_relations = _find_cyclic_relations(
        [batch.code for batch in request.batches], adjacency
    )
    for relation_index in cyclic_relations:
        relation = request.relations[relation_index]
        errors.append(
            _field_error(
                ("relations", relation_index, "to_code"),
                f"关系成环：投料关系 {relation.from_code!r} → {relation.to_code!r} "
                "处于一个有向环中，沿投料方向可从目标批次回到来源批次；"
                "投料关系必须是无环图，无法定义唯一的传播层级",
            )
        )

    # 污染源必须引用台账中已存在的批次
    if request.source_code not in known_codes:
        errors.append(
            _field_error(
                ("source_code",),
                f"污染源批次编号 {request.source_code!r} 在批次台账中不存在："
                "请选择已录入的批次作为污染源",
            )
        )

    if errors:
        raise RequestValidationError(errors)


def trace(request: TraceabilityRequest) -> TraceabilityResponse:
    """对完整关系图执行追溯：稳定遍历 + 最短投料路径选路。"""
    validate_graph(request)

    batches_by_code: dict[str, TraceBatchInput] = {
        batch.code: batch for batch in request.batches
    }
    source = batches_by_code[request.source_code]

    # 邻接按关系录入顺序排列（validate_graph 已按顺序追加），保证 BFS
    # 在同一层级上以录入顺序稳定展开
    adjacency: dict[str, list[tuple[str, int]]] = {}
    for index, relation in enumerate(request.relations):
        adjacency.setdefault(relation.from_code, []).append((relation.to_code, index))

    # BFS 最短路径。best[code] = (层级, 关系序号序列)；
    # 同一批次经多条路径到达时，取层级最少且关系序号序列字典序最小者。
    best: dict[str, tuple[int, list[int]]] = {}
    order: list[str] = []  # 首次到达顺序，用于稳定输出
    queue: deque[str] = deque([request.source_code])
    best[request.source_code] = (0, [])

    while queue:
        current = queue.popleft()
        level, path = best[current]
        for nxt, relation_index in adjacency.get(current, ()):
            candidate = (level + 1, [*path, relation_index])
            if nxt not in best:
                best[nxt] = candidate
                order.append(nxt)
                queue.append(nxt)
            else:
                old_level, old_path = best[nxt]
                # 层级更少，或层级相同且关系序号序列字典序更小：换路
                if (candidate[0], candidate[1]) < (old_level, old_path):
                    best[nxt] = candidate

    def build_report(code: str) -> TracedBatch:
        level, relation_path = best[code]
        batch = batches_by_code[code]
        path_codes = [request.source_code]
        steps: list[TracePathStep] = []
        cursor = request.source_code
        for relation_index in relation_path:
            relation = request.relations[relation_index]
            # 路径由 BFS 选出，关系序号序列一定从 cursor 指向下一个批次
            assert relation.from_code == cursor
            steps.append(
                TracePathStep(
                    relation_index=relation_index,
                    from_code=relation.from_code,
                    to_code=relation.to_code,
                )
            )
            cursor = relation.to_code
            path_codes.append(cursor)
        return TracedBatch(
            code=code,
            material_name=batch.material_name,
            batch_type=batch.batch_type,
            level=level,
            path_codes=path_codes,
            path_relation_indices=relation_path,
            path_steps=steps,
        )

    # 仅输出下游批次（污染源本身层级为 0，不作为受影响结果）
    affected = [build_report(code) for code in order if best[code][0] > 0]

    # 按传播层级分组；首次到达顺序在同层内保持稳定（BFS 逐层展开，
    # order 中同层节点天然相邻且按录入顺序排列）
    groups: list[TraceLevelGroup] = []
    per_level: dict[int, list[TracedBatch]] = {}
    for report in affected:
        per_level.setdefault(report.level, []).append(report)
    for level in sorted(per_level):
        groups.append(TraceLevelGroup(level=level, batches=per_level[level]))

    return TraceabilityResponse(
        source_code=source.code,
        source_material_name=source.material_name,
        source_batch_type=source.batch_type,
        affected_count=len(affected),
        levels=groups,
        affected_batches=affected,
    )
