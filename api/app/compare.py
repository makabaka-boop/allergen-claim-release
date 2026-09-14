"""前后方案影响比较：对照与现方案分别复用同一裁决函数，再按声明对比。

三态判定固定：对照放行而现方案受阻为“新受阻”，反之为“已解除”，
两侧结论一致为“未变化”。

参与对比的声明固定为两侧**都选择**的声明：只在一侧出现的声明不在
三态结论之内——未选择某条声明不等于该声明“放行”，取消一条原本受阻
的声明不能被报成“已解除”。

阻断证据的求差不直接按行号对位（否则在前面插入/删除原料会让同一行
的证据同时被判成新增与解除），而是先按原料名做最长公共子序列对齐、
再把双方剩余行按位置顺序配对（兼容纯改名），最后在配对的行之间按
（目标项、来源）求差集；只在一侧剩余的行整行计入对应一侧。原料改名
（行位置与命中均未变）不产生伪差异。
"""
from __future__ import annotations

from .evaluate import evaluate
from .rules import CompareStatus, Target
from .schemas import (
    ClaimComparison,
    ClaimVerdict,
    CompareRequest,
    CompareResponse,
    Evidence,
    ReleaseResponse,
)

# 对齐后的一对原料行：各自给出（原始行号, 原料名），未匹配一侧为 None
RowPair = tuple[tuple[int, str] | None, tuple[int, str] | None]


def _align_rows(
    baseline_rows: list[tuple[int, str]], current_rows: list[tuple[int, str]]
) -> list[RowPair]:
    """对齐两侧原料行：先按原料名匹配，剩余行再按位置顺序配对。

    1. 同名行优先一一配对（最长公共子序列），这样在前面插入/删除原料导致
       行号整体平移时，同一行仍能对齐；
    2. 两侧都未配完的行再按顺序逐个配对，纯改名（位置、命中均未变）不会被
       当成一删一增而产生伪差异；
    3. 最后只在一侧剩下的行才是真正的新增/删除，另一侧记 None。

    返回按对照方案行序排列的配对。
    """
    before = [name for _, name in baseline_rows]
    after = [name for _, name in current_rows]

    # LCS 动态规划表：lcs[i][j] = before[i:] 与 after[j:] 的公共子序列长度
    m, n = len(before), len(after)
    lcs = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m - 1, -1, -1):
        for j in range(n - 1, -1, -1):
            if before[i] == after[j]:
                lcs[i][j] = lcs[i + 1][j + 1] + 1
            else:
                lcs[i][j] = max(lcs[i + 1][j], lcs[i][j + 1])

    pairs: list[RowPair] = []
    unmatched_before: list[tuple[int, str]] = []
    unmatched_after: list[tuple[int, str]] = []
    i = j = 0
    while i < m and j < n:
        if before[i] == after[j]:
            pairs.append((baseline_rows[i], current_rows[j]))
            i += 1
            j += 1
        elif lcs[i + 1][j] >= lcs[i][j + 1]:
            unmatched_before.append(baseline_rows[i])
            i += 1
        else:
            unmatched_after.append(current_rows[j])
            j += 1
    unmatched_before.extend(baseline_rows[i:])
    unmatched_after.extend(current_rows[j:])

    # 同名配对之外、两侧都还有剩余行：按位置顺序配对（覆盖改名情形）
    positional = list(zip(unmatched_before, unmatched_after))
    pairs.extend(positional)
    pairs.extend((row, None) for row in unmatched_before[len(positional):])
    pairs.extend((None, row) for row in unmatched_after[len(positional):])

    pairs.sort(
        key=lambda pair: pair[0][0] if pair[0] is not None else m + pair[1][0]
    )
    return pairs


def _evidence_by_row(verdict: ClaimVerdict) -> dict[int, list[Evidence]]:
    grouped: dict[int, list[Evidence]] = {}
    for item in verdict.blocked_by:
        grouped.setdefault(item.row_index, []).append(item)
    return grouped


def _evidence_identity(evidence: Evidence) -> tuple[Target, str]:
    """配对行之间的证据身份：目标项 + 来源（行已按原料名对齐）。"""
    return (evidence.target, evidence.source)


def _diff_blockers(
    baseline: ReleaseResponse,
    current: ReleaseResponse,
    before_verdict: ClaimVerdict,
    after_verdict: ClaimVerdict,
) -> tuple[list[Evidence], list[Evidence]]:
    """在两侧都选择某声明时，返回 (仅现方案证据, 仅对照证据)。

    先按原料名对齐两侧行（剩余行按位置配对），再在配对行之间按
    目标项+来源求差，避免因行号平移（前面插入/删除原料）把同一证据
    同时记为新增与解除。
    """
    baseline_names = [(row.row_index, row.name) for row in baseline.rows]
    current_names = [(row.row_index, row.name) for row in current.rows]
    before_by_row = _evidence_by_row(before_verdict)
    after_by_row = _evidence_by_row(after_verdict)

    resolved: list[Evidence] = []
    new: list[Evidence] = []
    for before_row, after_row in _align_rows(baseline_names, current_names):
        before_items = before_by_row.get(before_row[0], []) if before_row else []
        after_items = after_by_row.get(after_row[0], []) if after_row else []
        before_keys = {_evidence_identity(item) for item in before_items}
        after_keys = {_evidence_identity(item) for item in after_items}
        resolved.extend(
            item for item in before_items if _evidence_identity(item) not in after_keys
        )
        new.extend(
            item for item in after_items if _evidence_identity(item) not in before_keys
        )

    resolved.sort(key=lambda item: (item.row_index, item.source, item.target))
    new.sort(key=lambda item: (item.row_index, item.source, item.target))
    return new, resolved


def compare(request: CompareRequest) -> CompareResponse:
    baseline = evaluate(request.baseline)
    current = evaluate(request.current)

    current_map = {verdict.claim: verdict for verdict in current.verdicts}

    # 仅对两侧都选择的声明给出三态结论，保持对照方案的声明顺序
    comparisons: list[ClaimComparison] = []
    for before in baseline.verdicts:
        after = current_map.get(before.claim)
        if after is None:
            # 现方案未选择该声明：不是“放行”，不参与三态对比
            continue

        if before.allowed and not after.allowed:
            status = CompareStatus.NEWLY_BLOCKED
        elif not before.allowed and after.allowed:
            status = CompareStatus.RESOLVED
        else:
            status = CompareStatus.UNCHANGED

        new_blockers, resolved_blockers = _diff_blockers(
            baseline, current, before, after
        )
        comparisons.append(
            ClaimComparison(
                claim=before.claim,
                status=status,
                baseline_allowed=before.allowed,
                current_allowed=after.allowed,
                new_blockers=new_blockers,
                resolved_blockers=resolved_blockers,
            )
        )

    return CompareResponse(baseline=baseline, current=current, comparisons=comparisons)
