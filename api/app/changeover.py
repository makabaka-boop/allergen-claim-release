"""换线残留推演：按生产批次序列逐批传递过敏原残留。

推演规则（固定，代码即规则）：

- 每个批次携带五类过敏原直接成分（牛奶、花生、小麦、大麦、黑麦）。
- 相邻批次之间标记是否完成**经验证清洁**：
  - 已清洁：下一批开始前清空全部残留，下一批进入残留为空；
  - 未清洁：上一批离开残留全部成为下一批进入残留。
- 离开残留 = 进入残留 ∪ 本批直接成分（按目标项求并集）。
- 带入物（前序批次带入项）仅取**本批未直接含有的进入残留**：
  进入残留中与本批直接成分同目标的项不构成带入，直接成分不得误报为
  “前序批次带入”。
- 每个残留项始终保留**最近来源批次**：目标项首次出现于某批直接成分后，
  若在后续批次中被该批直接成分再次含有，来源刷新为最近批次。

序列级约束（批次数量不足、名称空白或重复、清洁边界缺失/长度不符）
不在 Pydantic 模型层表达，由 :func:`validate_sequence` 统一转成
FastAPI 标准 422 detail，loc 精确定位到具体批次或边界，且不产生结果。
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
    """校验批次数量、名称（空白/重复）与清洁边界长度。

    成分标记非布尔、名称字段类型错误等结构问题已由 Pydantic 拦截；
    这里只处理需要跨字段或自定义定位的序列级约束。任何一条不满足即
    抛出 RequestValidationError（FastAPI 转 422），不产生推演结果。
    """
    errors: list[dict[str, object]] = []

    if len(request.batches) < MIN_BATCHES:
        errors.append(
            _field_error(
                ("batches",),
                f"生产批次序列至少需要 {MIN_BATCHES} 个批次，当前为 {len(request.batches)} 个",
            )
        )

    # 名称去空白后判重，所有参与重复的批次各自定位报错
    seen_names: dict[str, int] = {}
    duplicated: dict[int, int] = {}  # 当前批次序号 -> 首次出现的批次序号
    for index, batch in enumerate(request.batches):
        stripped = batch.name.strip()
        if stripped in seen_names:
            duplicated[index] = seen_names[stripped]
        else:
            seen_names[stripped] = index
    for index, first_index in duplicated.items():
        errors.append(
            _field_error(
                ("batches", index, "name"),
                f"批次名称与第 {first_index + 1} 批重复：生产批次序列内名称不得重复",
            )
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

        # 下一批开始前：经验证清洁清空残留，否则离开残留原样进入下一批
        if index < len(request.boundaries):
            if request.boundaries[index].cleaned:
                current = {}
            else:
                current = outgoing

    boundary_reports = [
        CleaningBoundaryReport(
            boundary_index=index,
            cleaned=boundary.cleaned,
            # 经验证清洁即在下一批开始前归零；未清洁则残留继续传递
            residue_cleared=boundary.cleaned,
        )
        for index, boundary in enumerate(request.boundaries)
    ]

    return ChangeoverResponse(batches=reports, boundaries=boundary_reports)
