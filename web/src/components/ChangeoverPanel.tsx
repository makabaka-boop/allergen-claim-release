import { useState } from "react";
import { ApiError, simulateChangeover } from "../api";
import { ErrorSummary } from "./ErrorSummary";
import {
  emptyBatch,
  TARGETS,
  TARGET_LABELS,
  type CleaningMode,
  type Target,
} from "../types";
import type {
  BatchInput,
  ChangeoverResponse,
  CleaningBoundaryInput,
  FieldError,
  ResidueItem,
} from "../types";

const MIN_BATCHES = 2;

// 一条清洁边界的编辑态：未清洁 / 全部清洁 / 局部清洁（携带已勾选的清除目标）
interface BoundaryState {
  mode: CleaningMode;
  clearedTargets: Target[];
}

function emptyBoundary(): BoundaryState {
  return { mode: "uncleaned", clearedTargets: [] };
}

function validateSequence(batches: BatchInput[], boundaries: BoundaryState[]): FieldError[] {
  const errors: FieldError[] = [];
  if (batches.length < MIN_BATCHES) {
    errors.push({
      field: "batches",
      message: `生产批次序列至少需要 ${MIN_BATCHES} 个批次，当前为 ${batches.length} 个。`,
    });
  }

  const seen = new Map<string, number>();
  batches.forEach((batch, index) => {
    const trimmed = batch.name.trim();
    if (!trimmed) {
      errors.push({
        field: `batches[${index}].name`,
        message: "批次名称不能为空：请填写该生产批次的名称。",
      });
      return;
    }
    if (seen.has(trimmed)) {
      errors.push({
        field: `batches[${index}].name`,
        message: `批次名称与第 ${(seen.get(trimmed) ?? 0) + 1} 批重复：生产批次序列内名称不得重复。`,
      });
    } else {
      seen.set(trimmed, index);
    }
  });

  // UI 恒定维护 len(batches)-1 条边界；局部清洁必须至少选定一个清除目标
  boundaries.forEach((boundary, index) => {
    if (boundary.mode === "partial" && boundary.clearedTargets.length === 0) {
      errors.push({
        field: `boundaries[${index}].cleared_targets`,
        message:
          "局部清洁至少需要指定一个已验证清除的目标；若无需清除请选择未清洁，若全部清除请选择全部清洁。",
      });
    }
  });
  return errors;
}

function ResidueList({
  items,
  testId,
}: {
  items: ResidueItem[];
  testId: string;
}) {
  if (items.length === 0) {
    return (
      <ul className="residue-list" data-testid={testId}>
        <li className="residue-empty">无</li>
      </ul>
    );
  }
  return (
    <ul className="residue-list" data-testid={testId}>
      {items.map((item) => (
        <li key={item.target} data-testid={`${testId}-${item.target}`}>
          {TARGET_LABELS[item.target]}
          <span className="residue-source">
            （来源：第 {item.source_batch_index + 1} 批「{item.source_batch_name}」）
          </span>
        </li>
      ))}
    </ul>
  );
}

interface ChangeoverResultProps {
  result: ChangeoverResponse;
}

function BoundaryReports({ result }: ChangeoverResultProps) {
  return (
    <section className="card" aria-live="polite" data-testid="co-boundary-results">
      <h3>清洁边界结果（实际清除项）</h3>
      <ul className="co-boundary-result-list">
        {result.boundaries.map((boundary) => {
          const mode =
            boundary.cleaned || boundary.residue_cleared
              ? "全部清洁：五类残留全部清除"
              : boundary.cleared_targets.length > 0
                ? "局部清洁：仅清除指定目标"
                : "未清洁：残留全部带入下一批";
          return (
            <li
              key={boundary.boundary_index}
              data-testid={`co-boundary-report-${boundary.boundary_index}`}
            >
              <span className="co-boundary-result-title">
                第 {boundary.boundary_index + 1} 批 → 第 {boundary.boundary_index + 2} 批：
                {mode}
              </span>
              {boundary.cleared_targets.length > 0 ? (
                <ul
                  className="co-cleared-targets"
                  data-testid={`co-boundary-report-${boundary.boundary_index}-targets`}
                >
                  {boundary.cleared_targets.map((target) => (
                    <li key={target} data-testid={`co-boundary-report-${boundary.boundary_index}-target-${target}`}>
                      {TARGET_LABELS[target]}
                    </li>
                  ))}
                </ul>
              ) : (
                <span
                  className="residue-empty"
                  data-testid={`co-boundary-report-${boundary.boundary_index}-targets`}
                >
                  无确认清除项
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ChangeoverResult({ result }: ChangeoverResultProps) {
  return (
    <>
      <section className="card" aria-live="polite" data-testid="co-result">
        <h2>逐批残留推演</h2>
        {result.batches.map((batch) => (
          <div key={batch.batch_index} className="co-batch-report" data-testid={`co-batch-${batch.batch_index}`}>
            <h3>
              第 {batch.batch_index + 1} 批「{batch.name}」
            </h3>
            {batch.cleaned_before === true && (
              <p className="clean-badge" data-testid={`co-batch-${batch.batch_index}-cleaned`}>
                本批开始前已完成经验证的全部清洁，进入残留已清空。
              </p>
            )}
            <div className="co-residue-grid">
              <div>
                <h4>进入残留</h4>
                <ResidueList items={batch.incoming_residue} testId={`co-batch-${batch.batch_index}-incoming`} />
              </div>
              <div>
                <h4>本批直接成分</h4>
                <ul className="residue-list" data-testid={`co-batch-${batch.batch_index}-direct`}>
                  {batch.direct_ingredients.length === 0 ? (
                    <li className="residue-empty">无五类过敏原直接成分</li>
                  ) : (
                    batch.direct_ingredients.map((target) => (
                      <li key={target}>{TARGET_LABELS[target]}</li>
                    ))
                  )}
                </ul>
              </div>
              <div>
                <h4>前序批次带入物</h4>
                <ResidueList items={batch.carried_over} testId={`co-batch-${batch.batch_index}-carried`} />
              </div>
              <div>
                <h4>离开残留</h4>
                <ResidueList items={batch.outgoing_residue} testId={`co-batch-${batch.batch_index}-outgoing`} />
              </div>
            </div>
          </div>
        ))}
      </section>
      <BoundaryReports result={result} />
    </>
  );
}

export function ChangeoverPanel() {
  const [batches, setBatches] = useState<BatchInput[]>([emptyBatch(), emptyBatch()]);
  const [boundaries, setBoundaries] = useState<BoundaryState[]>([emptyBoundary()]);
  const [result, setResult] = useState<ChangeoverResponse | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [transportError, setTransportError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // 任何编辑都会使上一轮推演失效：保留全部输入，清除旧结果与提示，等待重新推演
  const invalidate = () => {
    setResult(null);
    setFieldErrors([]);
    setTransportError("");
  };

  const updateBatch = (index: number, patch: Partial<BatchInput>) => {
    setBatches((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));
    invalidate();
  };

  const addBatch = () => {
    setBatches((current) => [...current, emptyBatch()]);
    setBoundaries((current) => [...current, emptyBoundary()]);
    invalidate();
  };

  const removeBatch = (index: number) => {
    setBatches((current) => current.filter((_, i) => i !== index));
    // 边界按“相邻间隙”对齐。删除批次后：
    // - 删首批/末批：该批与邻居之间的间隙直接消失；
    // - 删中间批：其前后两条间隙合并为一条，合并后的边界无法再声称
    //   已验证清洁（全部或局部），保守视为未清洁，由用户按新相邻关系重新标记。
    setBoundaries((current) => {
      if (index === 0) return current.slice(1);
      if (index === current.length) return current.slice(0, -1);
      const next = current.filter((_, gapIndex) => gapIndex !== index);
      next[index - 1] = emptyBoundary();
      return next;
    });
    invalidate();
  };

  const moveBatch = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= batches.length) return;
    setBatches((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    invalidate();
  };

  const setBoundaryMode = (boundaryIndex: number, mode: CleaningMode) => {
    setBoundaries((current) =>
      current.map((boundary, i) => {
        if (i !== boundaryIndex) return boundary;
        // 切走局部清洁时清空已选目标，切回时重新勾选，避免隐藏的陈旧选择被提交
        if (mode === "partial") return { mode, clearedTargets: boundary.clearedTargets };
        return { mode, clearedTargets: [] };
      }),
    );
    invalidate();
  };

  const toggleClearedTarget = (boundaryIndex: number, target: Target) => {
    setBoundaries((current) =>
      current.map((boundary, i) => {
        if (i !== boundaryIndex) return boundary;
        const selected = boundary.clearedTargets.includes(target)
          ? boundary.clearedTargets.filter((item) => item !== target)
          : [...boundary.clearedTargets, target].sort(
              (a, b) => TARGETS.indexOf(a) - TARGETS.indexOf(b),
            );
        return { ...boundary, clearedTargets: selected };
      }),
    );
    invalidate();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setResult(null);
    setTransportError("");

    const errors = validateSequence(batches, boundaries);
    if (errors.length > 0) {
      setFieldErrors(errors);
      return;
    }
    // UI 恒定维护 len(batches)-1 条边界；防御性校验仍保留
    if (boundaries.length !== batches.length - 1) {
      setFieldErrors([
        {
          field: "boundaries",
          message: "清洁边界数量必须为批次数减一：请检查相邻批次间的清洁标记。",
        },
      ]);
      return;
    }

    setFieldErrors([]);
    setSubmitting(true);
    try {
      const payloadBoundaries: CleaningBoundaryInput[] = boundaries.map((boundary) => {
        if (boundary.mode === "full") return { cleaned: true };
        if (boundary.mode === "partial") {
          return { cleaned: false, cleared_targets: boundary.clearedTargets };
        }
        return { cleaned: false };
      });
      const response = await simulateChangeover({
        batches,
        boundaries: payloadBoundaries,
      });
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
    <div className="changeover-module" data-testid="changeover-panel">
      <header>
        <h2>换线残留推演（生产批次序列）</h2>
        <p className="subtitle">
          按生产顺序录入至少两个批次及五类过敏原直接成分，并在相邻批次间选择清洁方式：
          未清洁（残留全部带入）、全部清洁（下一批开始前清空全部残留）或局部清洁
          （仅移除指定的已验证清除目标，保留项继续携带最近来源批次）。
          离开残留为进入残留与本批直接成分的并集，带入物仅取本批未直接含有的进入残留。
        </p>
      </header>

      <form onSubmit={handleSubmit} noValidate>
        <section className="card">
          <div className="card-head">
            <h3>批次序列</h3>
            <button type="button" className="secondary" onClick={addBatch} data-testid="co-add-batch">
              添加批次
            </button>
          </div>
          <div className="table-wrap">
            <table className="co-table">
              <thead>
                <tr>
                  <th>顺序</th>
                  <th>批次名称</th>
                  <th colSpan={TARGETS.length}>五类过敏原直接成分（勾选=含有）</th>
                  <th>操作</th>
                </tr>
                <tr>
                  <th aria-hidden="true" />
                  <th aria-hidden="true" />
                  {TARGETS.map((target) => (
                    <th key={target}>{TARGET_LABELS[target]}</th>
                  ))}
                  <th aria-hidden="true" />
                </tr>
              </thead>
              <tbody>
                {batches.map((batch, index) => (
                  <BatchRows
                    key={index}
                    batch={batch}
                    index={index}
                    total={batches.length}
                    boundary={index < boundaries.length ? boundaries[index] : emptyBoundary()}
                    onUpdate={updateBatch}
                    onRemove={removeBatch}
                    onMove={moveBatch}
                    onSetMode={setBoundaryMode}
                    onToggleClearedTarget={toggleClearedTarget}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="actions">
          <button type="submit" disabled={submitting} data-testid="co-submit">
            {submitting ? "推演中…" : "提交推演"}
          </button>
        </div>
      </form>

      {transportError && (
        <section className="card error-summary" role="alert" data-testid="co-transport-error">
          {transportError}
        </section>
      )}

      <ErrorSummary
        errors={fieldErrors}
        testIdPrefix="co-field-error"
        title="字段级错误（未产生推演，请修正后重新提交）"
      />
      {result && <ChangeoverResult result={result} />}
    </div>
  );
}

interface BatchRowsProps {
  batch: BatchInput;
  index: number;
  total: number;
  boundary: BoundaryState;
  onUpdate: (index: number, patch: Partial<BatchInput>) => void;
  onRemove: (index: number) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onSetMode: (boundaryIndex: number, mode: CleaningMode) => void;
  onToggleClearedTarget: (boundaryIndex: number, target: Target) => void;
}

function BatchRows({
  batch,
  index,
  total,
  boundary,
  onUpdate,
  onRemove,
  onMove,
  onSetMode,
  onToggleClearedTarget,
}: BatchRowsProps) {
  const colCount = TARGETS.length + 3;
  const radioGroup = `co-boundary-${index}-mode`;
  return (
    <>
      <tr data-testid={`co-batch-row-${index}`}>
        <td className="co-order">
          <div className="co-order-actions">
            <button
              type="button"
              className="secondary"
              aria-label={`第 ${index + 1} 批上移`}
              data-testid={`co-batch-${index}-up`}
              disabled={index === 0}
              onClick={() => onMove(index, -1)}
            >
              ↑
            </button>
            <span>第 {index + 1} 批</span>
            <button
              type="button"
              className="secondary"
              aria-label={`第 ${index + 1} 批下移`}
              data-testid={`co-batch-${index}-down`}
              disabled={index === total - 1}
              onClick={() => onMove(index, 1)}
            >
              ↓
            </button>
          </div>
        </td>
        <td>
          <input
            aria-label={`第 ${index + 1} 批批次名称`}
            data-testid={`co-batch-${index}-name`}
            value={batch.name}
            onChange={(event) => onUpdate(index, { name: event.target.value })}
            placeholder="如：花生酱批次 A"
          />
        </td>
        {TARGETS.map((target) => (
          <td key={target} className="check-cell">
            <input
              type="checkbox"
              aria-label={`第 ${index + 1} 批直接成分：${TARGET_LABELS[target]}`}
              data-testid={`co-batch-${index}-contains-${target}`}
              checked={batch[`contains_${target}`]}
              onChange={(event) => onUpdate(index, { [`contains_${target}`]: event.target.checked })}
            />
          </td>
        ))}
        <td>
          <button
            type="button"
            className="danger"
            aria-label={`删除第 ${index + 1} 批`}
            data-testid={`co-batch-${index}-remove`}
            onClick={() => onRemove(index)}
          >
            删除
          </button>
        </td>
      </tr>
      {index < total - 1 && (
        <tr className="co-boundary-row" data-testid={`co-boundary-row-${index}`}>
          <td colSpan={colCount}>
            <fieldset
              className="co-boundary-choice"
              data-testid={`co-boundary-${index}`}
              aria-label={`第 ${index + 1} 批到第 ${index + 2} 批的清洁方式`}
            >
              <legend>
                第 {index + 1} 批 → 第 {index + 2} 批之间的清洁方式
              </legend>
              <label className="co-boundary-label">
                <input
                  type="radio"
                  name={radioGroup}
                  data-testid={`co-boundary-${index}-mode-uncleaned`}
                  checked={boundary.mode === "uncleaned"}
                  onChange={() => onSetMode(index, "uncleaned")}
                />
                <span>未清洁（上一批残留全部带入下一批）</span>
              </label>
              <label className="co-boundary-label">
                <input
                  type="radio"
                  name={radioGroup}
                  data-testid={`co-boundary-${index}-mode-full`}
                  checked={boundary.mode === "full"}
                  onChange={() => onSetMode(index, "full")}
                />
                <span>全部清洁（下一批开始前清空全部残留）</span>
              </label>
              <label className="co-boundary-label">
                <input
                  type="radio"
                  name={radioGroup}
                  data-testid={`co-boundary-${index}-mode-partial`}
                  checked={boundary.mode === "partial"}
                  onChange={() => onSetMode(index, "partial")}
                />
                <span>局部清洁（仅移除下方勾选的已验证清除目标）</span>
              </label>
              {boundary.mode === "partial" && (
                <div className="co-cleared-target-picker" data-testid={`co-boundary-${index}-targets`}>
                  <span className="co-cleared-target-hint">已验证清除的目标：</span>
                  {TARGETS.map((target) => (
                    <label key={target} className="co-cleared-target-label">
                      <input
                        type="checkbox"
                        data-testid={`co-boundary-${index}-target-${target}`}
                        checked={boundary.clearedTargets.includes(target)}
                        onChange={() => onToggleClearedTarget(index, target)}
                      />
                      <span>{TARGET_LABELS[target]}</span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
          </td>
        </tr>
      )}
    </>
  );
}
