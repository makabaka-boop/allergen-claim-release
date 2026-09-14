"""换线残留推演：按生产批次序列逐批传递过敏原残留。

推演规则（固定，代码即规则）：

- 每个批次携带五类过敏原直接成分（牛奶、花生、小麦、大麦、黑麦）。
- 相邻批次之间的清洁边界三选一：
  - 全部清洁（cleaned=true）：下一批开始前清空全部残留，下一批进入残留为空；
  - 未清洁（cleaned=false 且不提供 cleared_targets）：上一批离开残留全部成为
    下一批进入残留；
  - 局部清洁（cleaned=false 且 cleared_targets 指定已验证清除的目标）：进入
    下一批前仅移除这些目标，保留项继续携带最近来源批次。
- 离开残留 = 进入残留 ∪ 本批直接成分（按目标项求并集）。
- 带入物（前序批次带入项）仅取**本批未直接含有的进入残留**：
  进入残留中与本批直接成分同目标的项不构成带入，直接成分不得误报为
  “前序批次带入”。
- 每个残留项始终保留**最近来源批次**：目标项首次出现于某批直接成分后，
  若在后续批次中被该批直接成分再次含有，来源刷新为最近批次。

序列级约束（批次数量不足、名称空白或重复、清洁边界缺失/长度不符、
局部清除目标为空/重复/越界/与全部清洁冲突）不在 Pydantic 模型层表达，
由 :func:`validate_sequence` 统一转成 FastAPI 标准 422 detail，loc 精确定位
到具体批次或边界，且不产生结果。
"""
from __future__ import annotations

from fastapi.exceptions import RequestValidationError

from .rules import DIRECT_FIELD_TARGETS, Target
from .schemas import (
    BatchInput,
    BatchResidueReport,
    ChangeoverRequest,
    ChangeoverResponse,
    CleaningBoundaryReport,
    ResidueItem,
)

MIN_BATCHES = 2


def _field_error(loc: tuple[str | int, ...], message: str) -> dict[str, object]:
    """构造 FastAPI 标准 422 detail 中的单条字段错误。"""
    return {"loc": ("body", *loc), "msg": message, "type": "value_error"}


def validate_sequence(request: ChangeoverRequest) -> None:
    """校验批次数量、名称（空白/重复）、清洁边界长度与局部清除目标。

    成分标记非布尔、名称字段类型错误、清除目标取值越界/非字符串等结构问题
    已由 Pydantic 拦截；这里只处理需要跨字段或自定义定位的序列级约束
    （含局部清除目标为空/重复/与全部清洁冲突）。任何一条不满足即抛出
    RequestValidationError（FastAPI 转 422），不产生推演结果。
    """
    errors: list[dict[str, object]] = []

    if len(request.batches) < MIN_BATCHES:
        errors.append(
            _field_error(
                ("batches",),
                f"生产批次序列至少需要 {MIN_BATCHES} 个批次，当前为 {len(request.batches)} 个",
            )
        )

    # 名称去空白后判重，所有参与重复的批次（含首次出现者）各自定位报错
    name_positions: dict[str, list[int]] = {}
    for index, batch in enumerate(request.batches):
        name_positions.setdefault(batch.name.strip(), []).append(index)
    for positions in name_positions.values():
        if len(positions) < 2:
            continue
        for order, index in enumerate(positions):
            others = [pos + 1 for pos in positions if pos != index]
            if order == 0:
                other_text = "、".join(f"第 {pos} 批" for pos in others)
                message = (
                    f"批次名称与{other_text}重复：生产批次序列内名称不得重复"
                )
            else:
                first_index = positions[0]
                message = (
                    f"批次名称与第 {first_index + 1} 批重复："
                    "生产批次序列内名称不得重复"
                )
            errors.append(
                _field_error(("batches", index, "name"), message)
            )

    expected_boundaries = max(len(request.batches) - 1, 0)
    if len(request.boundaries) != expected_boundaries:
        errors.append(
            _field_error(
                ("boundaries",),
                "清洁边界数量必须为批次数减一："
                f"{len(request.batches)} 个批次需要 {expected_boundaries} 条相邻批次间的清洁标记，"
                f"当前为 {len(request.boundaries)} 条",
            )
        )
    else:
        # 边界数量正确时才逐边界校验，避免越界；局部清除目标的结构性错误
        # （非字符串/非数组等）已由 Pydantic 拦截
        for index, boundary in enumerate(request.boundaries):
            location = ("boundaries", index, "cleared_targets")
            targets = boundary.cleared_targets
            if targets is None:
                continue
            if not targets:
                errors.append(
                    _field_error(
                        location,
                        "局部清洁的清除目标不能为空：请至少选择一个已验证清除的目标，"
                        "或改用未清洁/全部清洁",
                    )
                )
                continue
            seen: set[Target] = set()
            duplicate_targets: list[Target] = []
            for target in targets:
                if target in seen:
                    duplicate_targets.append(target)
                else:
                    seen.add(target)
            if duplicate_targets:
                names = "、".join(
                    target.value for target in dict.fromkeys(duplicate_targets)
                )
                errors.append(
                    _field_error(
                        location,
                        f"清除目标存在重复项：{names}；每个目标在同一条边界上至多指定一次",
                    )
                )
            if boundary.cleaned:
                errors.append(
                    _field_error(
                        location,
                        "清除目标与全部清洁标记冲突：cleaned=true 表示清空全部残留，"
                        "不应再指定局部清除目标",
                    )
                )

    if errors:
        raise RequestValidationError(errors)


def direct_targets(batch: BatchInput) -> set[Target]:
    """该批次五类过敏原直接成分命中的目标项。"""
    return {
        target
        for field, target in DIRECT_FIELD_TARGETS.items()
        if getattr(batch, field)
    }


def _sorted_items(residue: dict[Target, tuple[int, str]]) -> list[ResidueItem]:
    """按固定目标顺序输出残留项，保证结果稳定可核对。"""
    items: list[ResidueItem] = []
    for target in Target:
        source = residue.get(target)
        if source is not None:
            index, name = source
            items.append(
                ResidueItem(
                    target=target, source_batch_index=index, source_batch_name=name
                )
            )
    return items


def simulate(request: ChangeoverRequest) -> ChangeoverResponse:
    """对生产批次序列执行换线残留推演。"""
    validate_sequence(request)

    reports: list[BatchResidueReport] = []
    # 当前产线残留：目标项 -> (最近来源批次序号, 最近来源批次名)
    current: dict[Target, tuple[int, str]] = {}

    for index, batch in enumerate(request.batches):
        direct = direct_targets(batch)

        # 上一条边界的经验证清洁已在进入本批前生效（见循环末尾），
        # 因此 current 即本批进入残留
        incoming = dict(current)

        # 带入物：仅取本批未直接含有的进入残留。
        # 进入残留中与本批直接成分同目标的项不是“前序带入”，避免直接成分误报。
        carried = {
            target: source for target, source in incoming.items() if target not in direct
        }

        # 离开残留 = 进入残留 ∪ 本批直接成分；
        # 并集中被本批直接成分再次命中的目标项，来源刷新为本批（最近来源）
        outgoing = dict(incoming)
        for target in direct:
            outgoing[target] = (index, batch.name)

        cleaned_before: bool | None = None
        if index > 0:
            cleaned_before = request.boundaries[index - 1].cleaned

        reports.append(
            BatchResidueReport(
                batch_index=index,
                name=batch.name,
                direct_ingredients=[t for t in Target if t in direct],
                incoming_residue=_sorted_items(incoming),
                carried_over=_sorted_items(carried),
                outgoing_residue=_sorted_items(outgoing),
                cleaned_before=cleaned_before,
            )
        )

        # 下一批开始前按边界清洁选择处理：
        # - 全部清洁：清空全部残留；
        # - 局部清洁：仅移除指定的已清除目标，保留项继续携带最近来源；
        # - 未清洁：离开残留原样进入下一批。
        if index < len(request.boundaries):
            boundary = request.boundaries[index]
            if boundary.cleaned:
                current = {}
            elif boundary.cleared_targets:
                removed = set(boundary.cleared_targets)
                current = {
                    target: source
                    for target, source in outgoing.items()
                    if target not in removed
                }
            else:
                current = outgoing

    boundary_reports: list[CleaningBoundaryReport] = []
    for index, boundary in enumerate(request.boundaries):
        if boundary.cleaned:
            # 全部清洁即五类全部归零，结果中确认实际清除项为五类全列
            cleared = [target for target in Target]
        elif boundary.cleared_targets:
            # 局部清洁：按固定目标顺序回显实际指定的已清除目标
            chosen = set(boundary.cleared_targets)
            cleared = [target for target in Target if target in chosen]
        else:
            cleared = []
        boundary_reports.append(
            CleaningBoundaryReport(
                boundary_index=index,
                cleaned=boundary.cleaned,
                # 只有全部清洁使残留归零；局部清洁/未清洁均有残留可能继续传递
                residue_cleared=boundary.cleaned,
                cleared_targets=cleared,
            )
        )

    return ChangeoverResponse(batches=reports, boundaries=boundary_reports)
