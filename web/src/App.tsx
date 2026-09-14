import { useState } from "react";
import { ApiError, compareRelease, evaluateRelease } from "./api";
import { ChangeoverPanel } from "./components/ChangeoverPanel";
import { ClaimPicker } from "./components/ClaimPicker";
import { ComparePanel } from "./components/ComparePanel";
import { ErrorSummary } from "./components/ErrorSummary";
import { RecipeTable } from "./components/RecipeTable";
import { ResultPanel } from "./components/ResultPanel";
import { emptyRow } from "./types";
import type {
  Claim,
  CompareResponse,
  FieldError,
  IngredientRow,
  ReleasePlan,
  ReleaseResponse,
} from "./types";

export default function App() {
  const [rows, setRows] = useState<IngredientRow[]>([emptyRow()]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [result, setResult] = useState<ReleaseResponse | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [transportError, setTransportError] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  // 对照快照：深拷贝保存，后续编辑表格不会反向污染
  const [baseline, setBaseline] = useState<ReleasePlan | null>(null);
  const [comparison, setComparison] = useState<CompareResponse | null>(null);
  const [comparing, setComparing] = useState(false);
  // 当前表格内容是否相对最近一次成功裁决发生过改动：
  // 未经裁决的内容不能保存为对照，必须先重新提交裁决
  const [dirty, setDirty] = useState(false);

  const updateRow = (index: number, row: IngredientRow) => {
    setRows((current) => current.map((item, i) => (i === index ? row : item)));
    setDirty(true);
  };

  const addRow = () => {
    setRows((current) => [...current, emptyRow()]);
    setDirty(true);
  };

  const removeRow = (index: number) => {
    setRows((current) => current.filter((_, i) => i !== index));
    setDirty(true);
  };

  const toggleClaim = (claim: Claim) => {
    setClaims((current) =>
      current.includes(claim)
        ? current.filter((item) => item !== claim)
        : [...current, claim],
    );
    setDirty(true);
  };

  const resetOutcome = () => {
    setResult(null);
    setComparison(null);
    setFieldErrors([]);
    setTransportError("");
  };

  // 前端即时提示：空配方/未选声明不发请求；后端仍然独立强制校验
  const validateClientSide = (): boolean => {
    if (rows.length === 0) {
      setFieldErrors([
        { field: "ingredients", message: "配方不能为空：至少需要一条原料行。" },
      ]);
      return false;
    }
    if (claims.length === 0) {
      setFieldErrors([{ field: "claims", message: "请至少选择一条拟印刷声明。" }]);
      return false;
    }
    return true;
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    resetOutcome();
    if (!validateClientSide()) return;

    setSubmitting(true);
    try {
      const response = await evaluateRelease(rows, claims);
      setResult(response);
      // 当前内容已完成裁决：重新具备“设为对照”的资格
      setDirty(false);
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

  const snapshotBaseline = () => {
    // 深拷贝当前配方与声明：此后编辑表格不会改动已保存的对照
    setBaseline({
      ingredients: rows.map((row) => ({ ...row })),
      claims: [...claims],
    });
  };

  const handleCompare = async () => {
    if (!baseline) return;
    // 仅清除上一轮结果与错误；对照快照与编辑内容始终保留，失败可直接重试
    setComparison(null);
    setFieldErrors([]);
    setTransportError("");
    if (!validateClientSide()) return;

    setComparing(true);
    try {
      const response = await compareRelease(baseline, {
        ingredients: rows,
        claims,
      });
      setComparison(response);
      // 页面保留现方案结果
      setResult(response.current);
    } catch (error) {
      if (error instanceof ApiError) {
        setFieldErrors(error.fieldErrors);
      } else {
        setTransportError((error as Error).message);
      }
    } finally {
      setComparing(false);
    }
  };

  return (
    <div className="page">
      <div className="desk-grid">
        <div className="desk-column" data-testid="release-desk">
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
              <button
                type="button"
                className="secondary"
                onClick={snapshotBaseline}
                disabled={!result || dirty}
                title={
                  dirty ? "内容自上次裁决后已修改，请先重新提交裁决再设为对照" : undefined
                }
                data-testid="set-baseline"
              >
                设为对照
              </button>
              <button
                type="button"
                className="secondary"
                onClick={handleCompare}
                disabled={!baseline || comparing}
                data-testid="compare"
              >
                {comparing ? "比较中…" : "比较改动"}
              </button>
              <button type="submit" disabled={submitting} data-testid="submit">
                {submitting ? "裁决中…" : "提交裁决"}
              </button>
            </div>
          </form>

          {dirty && result && (
            <p className="baseline-hint dirty-hint" role="alert" data-testid="dirty-hint">
              配方或声明自上次裁决后已修改：请先重新“提交裁决”，再设为对照，避免把未经裁决的
              内容保存成比较基准。
            </p>
          )}

          {baseline && (
            <p className="baseline-hint" data-testid="baseline-hint">
              已保存对照快照：{baseline.ingredients.length} 行原料、{baseline.claims.length}{" "}
              条声明。继续编辑上方表格后点击“比较改动”。
            </p>
          )}

          {transportError && (
            <section className="card error-summary" role="alert" data-testid="transport-error">
              {transportError}
            </section>
          )}

          <ErrorSummary errors={fieldErrors} />
          {result && <ResultPanel result={result} />}
          {comparison && <ComparePanel comparison={comparison} />}
        </div>

        {/* 独立的换线残留推演模块：自管批次序列与清洁边界状态，
            不与放行台的配方/裁决/对照状态共享。 */}
        <div className="desk-column">
          <ChangeoverPanel />
        </div>
      </div>
    </div>
  );
}
