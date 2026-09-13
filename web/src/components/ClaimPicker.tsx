import { CLAIMS, CLAIM_LABELS } from "../types";
import type { Claim } from "../types";

interface ClaimPickerProps {
  selected: Claim[];
  onToggle: (claim: Claim) => void;
}

export function ClaimPicker({ selected, onToggle }: ClaimPickerProps) {
  return (
    <fieldset className="card claim-picker">
      <legend>拟印刷声明（可多选，仅允许以下三种）</legend>
      {CLAIMS.map((claim) => (
        <label key={claim} className="claim-option" data-testid={`claim-${claim}`}>
          <input
            type="checkbox"
            checked={selected.includes(claim)}
            onChange={() => onToggle(claim)}
          />
          <span>{CLAIM_LABELS[claim]}</span>
        </label>
      ))}
      {selected.length === 0 && (
        <p className="empty-hint" data-testid="empty-claims-hint">
          未选择任何声明：至少需要选择一条拟印刷声明。
        </p>
      )}
    </fieldset>
  );
}
