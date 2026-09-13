"""前后方案影响比较：对照与现方案分别复用同一裁决函数，再按声明对比。

三态判定固定：对照放行而现方案受阻为“新受阻”，反之为“已解除”，
两侧结论一致为“未变化”；阻断证据按（行号、目标项、来源）求差集，
原料改名不会产生伪差异。
"""
from __future__ import annotations

from .evaluate import evaluate
from .rules import Claim, CompareStatus, Target
from .schemas import (
    ClaimComparison,
    CompareRequest,
    CompareResponse,
    Evidence,
)


def _evidence_key(evidence: Evidence) -> tuple[int, Target, str]:
    """证据身份：行号 + 目标项 + 来源（不含原料名，避免改名造成伪差异）。"""
    return (evidence.row_index, evidence.target, evidence.source)


def compare(request: CompareRequest) -> CompareResponse:
    baseline = evaluate(request.baseline)
    current = evaluate(request.current)

    baseline_map = {verdict.claim: verdict for verdict in baseline.verdicts}
    current_map = {verdict.claim: verdict for verdict in current.verdicts}

    # 声明并集保持请求顺序：先对照方案，再追加现方案独有的声明
    ordered: list[Claim] = []
    for verdict in [*baseline.verdicts, *current.verdicts]:
        if verdict.claim not in ordered:
            ordered.append(verdict.claim)

    comparisons: list[ClaimComparison] = []
    for claim in ordered:
        before = baseline_map.get(claim)
        after = current_map.get(claim)
        # 一侧未选择该声明时按“无阻断”参与对比
        before_allowed = before.allowed if before else True
        after_allowed = after.allowed if after else True
        before_blocked = before.blocked_by if before else []
        after_blocked = after.blocked_by if after else []

        if before_allowed and not after_allowed:
            status = CompareStatus.NEWLY_BLOCKED
        elif not before_allowed and after_allowed:
            status = CompareStatus.RESOLVED
        else:
            status = CompareStatus.UNCHANGED

        before_keys = {_evidence_key(item) for item in before_blocked}
        after_keys = {_evidence_key(item) for item in after_blocked}
        comparisons.append(
            ClaimComparison(
                claim=claim,
                status=status,
                baseline_allowed=before_allowed,
                current_allowed=after_allowed,
                new_blockers=[
                    item for item in after_blocked if _evidence_key(item) not in before_keys
                ],
                resolved_blockers=[
                    item for item in before_blocked if _evidence_key(item) not in after_keys
                ],
            )
        )

    return CompareResponse(baseline=baseline, current=current, comparisons=comparisons)
