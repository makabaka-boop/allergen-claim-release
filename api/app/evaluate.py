"""放行裁决：直接成分与共线接触同时计入，任一命中即阻断对应声明。"""
from __future__ import annotations

from .rules import CLAIM_TARGETS, Claim, Target, contact_targets, direct_targets
from .schemas import (
    ClaimVerdict,
    Evidence,
    ReleaseRequest,
    ReleaseResponse,
    RowReport,
)


def evaluate(request: ReleaseRequest) -> ReleaseResponse:
    row_reports: list[RowReport] = []
    # (row_index, 原料名, 来源, 目标) 的命中清单
    all_hits: list[tuple[int, str, str, Target]] = []

    for index, row in enumerate(request.ingredients):
        direct = direct_targets(row)
        contact = contact_targets(row)
        row_reports.append(
            RowReport(
                row_index=index,
                name=row.name,
                # 按固定目标顺序输出，保证结果稳定可核对
                direct_hits=[t for t in Target if t in direct],
                contact_hits=[t for t in Target if t in contact],
            )
        )
        for target in Target:
            if target in direct:
                all_hits.append((index, row.name, "direct", target))
            if target in contact:
                all_hits.append((index, row.name, "contact", target))

    verdicts: list[ClaimVerdict] = []
    # 按请求声明顺序裁决（去重，避免重复声明产生重复结论）
    seen: set[Claim] = set()
    for claim in request.claims:
        if claim in seen:
            continue
        seen.add(claim)
        wanted = CLAIM_TARGETS[claim]
        blocked = [
            Evidence(
                row_index=row_index,
                ingredient_name=name,
                target=target,
                source=source,
            )
            for row_index, name, source, target in all_hits
            if target in wanted
        ]
        verdicts.append(
            ClaimVerdict(claim=claim, allowed=not blocked, blocked_by=blocked)
        )

    return ReleaseResponse(
        printable=all(verdict.allowed for verdict in verdicts),
        rows=row_reports,
        verdicts=verdicts,
    )
