import { CLAIM_LABELS, COMPARE_STATUS_LABELS } from "../types";
import type { ClaimComparison, CompareResponse, CompareStatus } from "../types";
import { formatEvidence } from "./ResultPanel";

const STATUS_CLASS: Record<CompareStatus, string> = {
  newly_blocked: "block",
  resolved: "pass",
  unchanged: "neutral",
};

function statusHint(item: ClaimComparison): string {
  const before = item.baseline_allowed ? "放行" : "阻断";
  const after = item.current_allowed ? "放行" : "阻断";
  return `对照方案：${before} → 现方案：${after}`;
}

interface ComparePanelProps {
  comparison: CompareResponse;
}

export function ComparePanel({ comparison }: ComparePanelProps) {
  return (
    <section className="card" aria-live="polite" data-testid="compare-panel">
      <h2>前后方案影响比较（对照 → 现方案）</h2>
      {comparison.comparisons.length === 0 && (
        <p className="clean" data-testid="compare-empty">
          两侧没有共同选择的声明：取消勾选的声明不会按“放行”参与比较，请勾选共同关注的声明后
          再比较。
        </p>
      )}
      <div className="claim-verdicts">
        {comparison.comparisons.map((item) => (
          <div
            key={item.claim}
            className={`claim-verdict ${STATUS_CLASS[item.status]}`}
            data-testid={`compare-${item.claim}`}
          >
            <div className="claim-title">
              <span>“{CLAIM_LABELS[item.claim]}”</span>
              <strong>{COMPARE_STATUS_LABELS[item.status]}</strong>
            </div>
            <p className="compare-transition">{statusHint(item)}</p>
            {item.new_blockers.length > 0 && (
              <div className="compare-evidence">
                <h3>仅现方案存在的阻断（改动引入）</h3>
                <ul className="blocked-list">
                  {item.new_blockers.map((evidence, i) => (
                    <li key={i} data-testid={`compare-${item.claim}-new-${i}`}>
                      {formatEvidence(evidence)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {item.resolved_blockers.length > 0 && (
              <div className="compare-evidence">
                <h3>仅对照方案存在的阻断（改动解除）</h3>
                <ul className="blocked-list">
                  {item.resolved_blockers.map((evidence, i) => (
                    <li key={i} data-testid={`compare-${item.claim}-resolved-${i}`}>
                      {formatEvidence(evidence)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {item.new_blockers.length === 0 && item.resolved_blockers.length === 0 && (
              <p className="clean">两侧阻断证据一致，改动未影响该声明。</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
