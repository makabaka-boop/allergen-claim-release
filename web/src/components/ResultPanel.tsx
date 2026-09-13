import { CLAIM_LABELS, TARGET_LABELS } from "../types";
import type { Evidence, ReleaseResponse } from "../types";

function formatEvidence(evidence: Evidence): string {
  const source = evidence.source === "direct" ? "直接成分" : "同组共线接触";
  return `第 ${evidence.row_index + 1} 行「${evidence.ingredient_name}」${source}命中${TARGET_LABELS[evidence.target]}`;
}

interface ResultPanelProps {
  result: ReleaseResponse;
}

export function ResultPanel({ result }: ResultPanelProps) {
  return (
    <section className="card" aria-live="polite">
      <div
        className={`verdict-banner ${result.printable ? "pass" : "block"}`}
        data-testid="verdict-banner"
      >
        {result.printable ? "可印刷" : "禁止印刷：存在被阻断的声明"}
      </div>

      <h2>逐行证据</h2>
      <ul className="row-evidence">
        {result.rows.map((row) => {
          const clean = row.direct_hits.length === 0 && row.contact_hits.length === 0;
          return (
            <li key={row.row_index} data-testid={`report-row-${row.row_index}`}>
              <strong>
                第 {row.row_index + 1} 行「{row.name}」
              </strong>
              {clean ? (
                <span className="clean">直接成分与共线接触均未命中目标项</span>
              ) : (
                <ul>
                  {row.direct_hits.map((target) => (
                    <li key={`direct-${target}`} className="hit-direct">
                      直接成分：{TARGET_LABELS[target]}
                    </li>
                  ))}
                  {row.contact_hits.map((target) => (
                    <li key={`contact-${target}`} className="hit-contact">
                      同组共线接触：{TARGET_LABELS[target]}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      <h2>逐条声明裁决</h2>
      <div className="claim-verdicts">
        {result.verdicts.map((verdict) => (
          <div
            key={verdict.claim}
            className={`claim-verdict ${verdict.allowed ? "pass" : "block"}`}
            data-testid={`verdict-${verdict.claim}`}
          >
            <div className="claim-title">
              <span>“{CLAIM_LABELS[verdict.claim]}”</span>
              <strong>{verdict.allowed ? "放行" : "阻断"}</strong>
            </div>
            {verdict.allowed ? (
              <p className="clean">所有原料直接成分与共线标记均未命中相关目标项。</p>
            ) : (
              <ul className="blocked-list">
                {verdict.blocked_by.map((evidence, i) => (
                  <li key={i} data-testid={`blocked-${verdict.claim}-${i}`}>
                    {formatEvidence(evidence)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
