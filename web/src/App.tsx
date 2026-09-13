import { useState } from "react";
import { ApiError, evaluateRelease } from "./api";
import { ClaimPicker } from "./components/ClaimPicker";
import { ErrorSummary } from "./components/ErrorSummary";
import { RecipeTable } from "./components/RecipeTable";
import { ResultPanel } from "./components/ResultPanel";
import { emptyRow } from "./types";
import type { Claim, FieldError, IngredientRow, ReleaseResponse } from "./types";

export default function App() {
  const [rows, setRows] = useState<IngredientRow[]>([emptyRow()]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [result, setResult] = useState<ReleaseResponse | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [transportError, setTransportError] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  const updateRow = (index: number, row: IngredientRow) => {
    setRows((current) => current.map((item, i) => (i === index ? row : item)));
  };

  const addRow = () => setRows((current) => [...current, emptyRow()]);

  const removeRow = (index: number) => {
    setRows((current) => current.filter((_, i) => i !== index));
  };

  const toggleClaim = (claim: Claim) => {
    setClaims((current) =>
      current.includes(claim)
        ? current.filter((item) => item !== claim)
        : [...current, claim],
    );
  };

  const resetOutcome = () => {
    setResult(null);
    setFieldErrors([]);
    setTransportError("");
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    resetOutcome();

    // 前端即时提示：空配方/未选声明不发请求；后端仍然独立强制校验
    if (rows.length === 0) {
      setFieldErrors([{ field: "ingredients", message: "配方不能为空：至少需要一条原料行。" }]);
      return;
    }
    if (claims.length === 0) {
      setFieldErrors([{ field: "claims", message: "请至少选择一条拟印刷声明。" }]);
      return;
    }

    setSubmitting(true);
    try {
      const response = await evaluateRelease(rows, claims);
      setResult(response);
    } catch (error) {
      if (error instanceof ApiError) {
        setFieldErrors(error.fieldErrors);
      } else {
        setTransportError((error as Error).message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page">
      <header>
        <h1>包装放行台</h1>
        <p className="subtitle">
          直接成分与同组共线接触联合裁决：所有原料及共线标记均未命中目标项，声明方可放行。
          麸质命中集合严格等于小麦、大麦、黑麦。
        </p>
      </header>

      <form onSubmit={handleSubmit} noValidate>
        <RecipeTable rows={rows} onChange={updateRow} onAdd={addRow} onRemove={removeRow} />
        <ClaimPicker selected={claims} onToggle={toggleClaim} />

        <div className="actions">
          <button type="submit" disabled={submitting} data-testid="submit">
            {submitting ? "裁决中…" : "提交裁决"}
          </button>
        </div>
      </form>

      {transportError && (
        <section className="card error-summary" role="alert" data-testid="transport-error">
          {transportError}
        </section>
      )}

      <ErrorSummary errors={fieldErrors} />
      {result && <ResultPanel result={result} />}
    </div>
  );
}
