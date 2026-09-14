import { useRef, useState } from "react";
import { ApiError, traceBatches } from "../api";
import { ErrorSummary } from "./ErrorSummary";
import {
  BATCH_TYPES,
  BATCH_TYPE_LABELS,
  emptyTraceBatch,
  emptyTraceRelation,
  type BatchType,
} from "../types";
import type {
  FieldError,
  TraceBatchInput,
  TraceabilityResponse,
  TraceRelationInput,
  TracedBatch,
} from "../types";

// ---------------------------------------------------------------------------
// 前端即时校验（与后端 traceability.validate_graph 保持一致的定位语义）。
// 后端仍然独立强制校验；这里拦截是为了不发明显非法的请求并就地保留草稿。
// ---------------------------------------------------------------------------

interface GraphValidation {
  errors: FieldError[];
  // 去空白后的有效编号 -> 台账行号（用于关系端点引用）
  codes: Map<string, number>;
}

function validateGraph(
  batches: TraceBatchInput[],
  relations: TraceRelationInput[],
  sourceCode: string,
): GraphValidation {
  const errors: FieldError[] = [];

  if (batches.length === 0) {
    errors.push({ field: "batches", message: "批次台账不能为空：至少需要录入一个批次。" });
  }

  const codePositions = new Map<string, number[]>();
  batches.forEach((batch, index) => {
    const code = batch.code.trim();
    if (!code) {
      errors.push({
        field: `batches[${index}].code`,
        message: "批次编号不能为空：请填写该物料批次的唯一编号。",
      });
    } else {
      const positions = codePositions.get(code) ?? [];
      positions.push(index);
      codePositions.set(code, positions);
    }
    if (!batch.material_name.trim()) {
      errors.push({
        field: `batches[${index}].material_name`,
        message: "物料名称不能为空：请填写该批次对应的物料名称。",
      });
    }
    if (!batch.batch_type) {
      errors.push({
        field: `batches[${index}].batch_type`,
        message: "请选择批次类型：原料、中间料或成品。",
      });
    }
  });

  // 所有参与重复的批次（含首次出现者）各自定位到 code
  codePositions.forEach((positions) => {
    if (positions.length < 2) return;
    positions.forEach((batchIndex, order) => {
      if (order === 0) {
        const others = positions.slice(1).map((pos) => `第 ${pos + 1} 个批次`).join("、");
        errors.push({
          field: `batches[${batchIndex}].code`,
          message: `批次编号与${others}重复：台账内批次编号必须唯一。`,
        });
      } else {
        errors.push({
          field: `batches[${batchIndex}].code`,
          message: `批次编号与第 ${positions[0] + 1} 个批次重复：台账内批次编号必须唯一。`,
        });
      }
    });
  });

  const codes = new Map<string, number>();
  batches.forEach((batch, index) => {
    const code = batch.code.trim();
    if (code && !codes.has(code)) codes.set(code, index);
  });

  // 邻接（仅挂来源端存在的关系），用于自引用之外的成环检测
  const adjacency = new Map<string, { to: string; relationIndex: number }[]>();
  relations.forEach((relation, index) => {
    const from = relation.from_code.trim();
    const to = relation.to_code.trim();
    const fromKnown = codes.has(from);
    const toKnown = codes.has(to);
    if (!from) {
      errors.push({
        field: `relations[${index}].from_code`,
        message: "投料关系的来源批次编号不能为空。",
      });
    } else if (!fromKnown) {
      errors.push({
        field: `relations[${index}].from_code`,
        message: `来源批次编号「${from}」在批次台账中不存在：投料关系两端必须都已录入。`,
      });
    }
    if (!to) {
      errors.push({
        field: `relations[${index}].to_code`,
        message: "投料关系的目标批次编号不能为空。",
      });
    } else if (!toKnown) {
      errors.push({
        field: `relations[${index}].to_code`,
        message: `目标批次编号「${to}」在批次台账中不存在：投料关系两端必须都已录入。`,
      });
    }
    if (fromKnown && toKnown && from === to) {
      errors.push({
        field: `relations[${index}].to_code`,
        message: `关系自引用：来源批次与目标批次均为「${from}」，投料关系不得把批次投入自身。`,
      });
    }
    if (fromKnown) {
      const edges = adjacency.get(from) ?? [];
      edges.push({ to, relationIndex: index });
      adjacency.set(from, edges);
    }
  });

  // 成环：一条关系 u→v 在环上当且仅当从 v 能沿投料方向回到 u
  const known = new Set(codes.keys());
  const reaches = (start: string, target: string): boolean => {
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const edge of adjacency.get(current) ?? []) {
        if (!known.has(edge.to)) continue;
        if (edge.to === target) return true;
        if (!seen.has(edge.to)) {
          seen.add(edge.to);
          queue.push(edge.to);
        }
      }
    }
    return false;
  };
  relations.forEach((relation, index) => {
    const from = relation.from_code.trim();
    const to = relation.to_code.trim();
    if (from !== to && codes.has(from) && codes.has(to) && reaches(to, from)) {
      errors.push({
        field: `relations[${index}].to_code`,
        message: `关系成环：「${from}」→「${to}」处于一个有向环中，沿投料方向可从目标批次回到来源批次；投料关系必须无环。`,
      });
    }
  });

  if (!sourceCode.trim()) {
    errors.push({ field: "source_code", message: "请选择或填写发起追溯的污染源批次编号。" });
  } else if (!codes.has(sourceCode.trim())) {
    errors.push({
      field: "source_code",
      message: `污染源批次编号「${sourceCode.trim()}」在批次台账中不存在：请选择已录入的批次。`,
    });
  }

  return { errors, codes };
}

// ---------------------------------------------------------------------------
// 结果展示
// ---------------------------------------------------------------------------

function typeLabel(type: BatchType): string {
  return BATCH_TYPE_LABELS[type] ?? type;
}

function PathExplanation({ batch }: { batch: TracedBatch }) {
  return (
    <ol className="tr-path" data-testid={`tr-path-${batch.code}`}>
      {batch.path_steps.map((step, hop) => (
        <li
          key={`${step.relation_index}-${hop}`}
          className="tr-path-hop"
          data-testid={`tr-path-${batch.code}-hop-${hop}`}
        >
          <span className="tr-path-codes">
            {step.from_code} <span aria-hidden="true">→</span> {step.to_code}
          </span>
          <span className="tr-path-relation">
            （投料关系 #{step.relation_index + 1}）
          </span>
        </li>
      ))}
    </ol>
  );
}

function TraceResult({ result }: { result: TraceabilityResponse }) {
  return (
    <section className="card" aria-live="polite" data-testid="tr-result">
      <h2>
        追溯结果：污染源「{result.source_code}」（{result.source_material_name}·
        {typeLabel(result.source_batch_type)}）
      </h2>
      <p className="tr-summary" data-testid="tr-summary">
        共影响 <strong>{result.affected_count}</strong> 个下游批次
        {result.affected_count > 0 ? "，按传播层级如下：" : "：该污染源未投入任何下游批次。"}
      </p>

      {result.levels.map((group) => (
        <div key={group.level} className="tr-level" data-testid={`tr-level-${group.level}`}>
          <h3>
            第 {group.level} 层（{group.level === 1 ? "直接使用" : `间接影响 · ${group.level} 跳`}，
            {group.batches.length} 个批次）
          </h3>
          <ul className="tr-affected-list">
            {group.batches.map((batch) => (
              <li
                key={batch.code}
                className="tr-affected-item"
                data-testid={`tr-affected-${batch.code}`}
              >
                <div className="tr-affected-head">
                  <span className="tr-affected-code">{batch.code}</span>
                  <span className="tr-affected-meta">
                    {batch.material_name}·{typeLabel(batch.batch_type)}
                  </span>
                </div>
                <div className="tr-affected-route">
                  最短投料路径（{batch.level} 跳）：
                  <strong data-testid={`tr-affected-${batch.code}-route`}>
                    {batch.path_codes.join(" → ")}
                  </strong>
                </div>
                <PathExplanation batch={batch} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 追溯台主模块：自管批次台账、投料关系与污染源状态，不与放行台/换线模块共享
// ---------------------------------------------------------------------------

export function TraceabilityPanel() {
  const [batches, setBatches] = useState<TraceBatchInput[]>([emptyTraceBatch()]);
  const [relations, setRelations] = useState<TraceRelationInput[]>([emptyTraceRelation()]);
  const [sourceCode, setSourceCode] = useState("");
  const [result, setResult] = useState<TraceabilityResponse | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [transportError, setTransportError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // 编辑代号：任何编辑都使上一轮结果失效，在途响应（成功或 422）返回时作废，
  // 避免与当前输入不一致的旧结果重新显示。
  const generationRef = useRef(0);

  // 任何编辑都保留草稿，但清除与当前输入不一致的旧结果与提示
  const invalidate = () => {
    generationRef.current += 1;
    setResult(null);
    setFieldErrors([]);
    setTransportError("");
    setSubmitting(false);
  };

  const updateBatch = (index: number, patch: Partial<TraceBatchInput>) => {
    setBatches((current) =>
      current.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
    invalidate();
  };

  const addBatch = () => {
    setBatches((current) => [...current, emptyTraceBatch()]);
    invalidate();
  };

  const removeBatch = (index: number) => {
    setBatches((current) => current.filter((_, i) => i !== index));
    invalidate();
  };

  const updateRelation = (index: number, patch: Partial<TraceRelationInput>) => {
    setRelations((current) =>
      current.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
    invalidate();
  };

  const addRelation = () => {
    setRelations((current) => [...current, emptyTraceRelation()]);
    invalidate();
  };

  const removeRelation = (index: number) => {
    setRelations((current) => current.filter((_, i) => i !== index));
    invalidate();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setResult(null);
    setTransportError("");

    const { errors } = validateGraph(batches, relations, sourceCode);
    if (errors.length > 0) {
      setFieldErrors(errors);
      return;
    }

    generationRef.current += 1;
    const requestGeneration = generationRef.current;
    setFieldErrors([]);
    setSubmitting(true);
    try {
      const response = await traceBatches({
        batches: batches.map((batch) => ({
          code: batch.code.trim(),
          material_name: batch.material_name.trim(),
          batch_type: batch.batch_type as BatchType,
        })),
        relations: relations.map((relation) => ({
          from_code: relation.from_code.trim(),
          to_code: relation.to_code.trim(),
        })),
        source_code: sourceCode.trim(),
      });
      // 等待期间台账/关系/污染源被改过或已发起新追溯：旧响应丢弃
      if (generationRef.current !== requestGeneration) return;
      setResult(response);
    } catch (error) {
      if (generationRef.current !== requestGeneration) return;
      if (error instanceof ApiError) {
        setFieldErrors(error.fieldErrors);
      } else {
        setTransportError((error as Error).message);
      }
    } finally {
      if (generationRef.current === requestGeneration) {
        setSubmitting(false);
      }
    }
  };

  return (
    <div className="trace-module" data-testid="trace-panel">
      <header>
        <h2>批次用料追溯（物料批次投料关系图）</h2>
        <p className="subtitle">
          录入物料批次（编号、物料名称、类型：原料/中间料/成品）与“来源批次投入目标批次”
          的投料关系，选定污染源批次后发起追溯。页面按传播层级展示直接使用与间接影响批次，
          并为每个批次还原层级最少、关系序号字典序最小的最短投料路径。
        </p>
      </header>

      <form onSubmit={handleSubmit} noValidate>
        <section className="card">
          <div className="card-head">
            <h3>批次台账</h3>
            <button type="button" className="secondary" onClick={addBatch} data-testid="tr-add-batch">
              添加批次
            </button>
          </div>
          <div className="table-wrap">
            <table className="tr-table">
              <thead>
                <tr>
                  <th>序号</th>
                  <th>批次编号</th>
                  <th>物料名称</th>
                  <th>批次类型</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch, index) => (
                  <tr key={index} data-testid={`tr-batch-row-${index}`}>
                    <td>第 {index + 1} 个</td>
                    <td>
                      <input
                        aria-label={`第 ${index + 1} 个批次编号`}
                        data-testid={`tr-batch-${index}-code`}
                        value={batch.code}
                        onChange={(event) => updateBatch(index, { code: event.target.value })}
                        placeholder="如：RAW-2026-001"
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`第 ${index + 1} 个物料名称`}
                        data-testid={`tr-batch-${index}-material`}
                        value={batch.material_name}
                        onChange={(event) =>
                          updateBatch(index, { material_name: event.target.value })
                        }
                        placeholder="如：花生原料"
                      />
                    </td>
                    <td>
                      <select
                        aria-label={`第 ${index + 1} 个批次类型`}
                        data-testid={`tr-batch-${index}-type`}
                        value={batch.batch_type}
                        onChange={(event) =>
                          updateBatch(index, { batch_type: event.target.value as BatchType | "" })
                        }
                      >
                        <option value="" disabled>
                          请选择
                        </option>
                        {BATCH_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {BATCH_TYPE_LABELS[type]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="danger"
                        aria-label={`删除第 ${index + 1} 个批次`}
                        data-testid={`tr-batch-${index}-remove`}
                        onClick={() => removeBatch(index)}
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>投料关系（来源批次投入目标批次）</h3>
            <button
              type="button"
              className="secondary"
              onClick={addRelation}
              data-testid="tr-add-relation"
            >
              添加关系
            </button>
          </div>
          <div className="table-wrap">
            <table className="tr-table">
              <thead>
                <tr>
                  <th>关系序号</th>
                  <th>来源批次编号（被投入）</th>
                  <th>方向</th>
                  <th>目标批次编号（投料去向）</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {relations.map((relation, index) => (
                  <tr key={index} data-testid={`tr-relation-row-${index}`}>
                    <td>#{index + 1}</td>
                    <td>
                      <input
                        aria-label={`第 ${index + 1} 条投料关系的来源批次编号`}
                        data-testid={`tr-relation-${index}-from`}
                        value={relation.from_code}
                        onChange={(event) =>
                          updateRelation(index, { from_code: event.target.value })
                        }
                        placeholder="来源批次编号"
                        list="tr-batch-codes"
                      />
                    </td>
                    <td aria-hidden="true">→</td>
                    <td>
                      <input
                        aria-label={`第 ${index + 1} 条投料关系的目标批次编号`}
                        data-testid={`tr-relation-${index}-to`}
                        value={relation.to_code}
                        onChange={(event) =>
                          updateRelation(index, { to_code: event.target.value })
                        }
                        placeholder="目标批次编号"
                        list="tr-batch-codes"
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="danger"
                        aria-label={`删除第 ${index + 1} 条投料关系`}
                        data-testid={`tr-relation-${index}-remove`}
                        onClick={() => removeRelation(index)}
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* 数据列表辅助录入：浏览器可从已录入批次编号中自动补全 */}
            <datalist id="tr-batch-codes">
              {batches.map((batch, index) => (
                <option key={index} value={batch.code.trim()} />
              ))}
            </datalist>
          </div>
        </section>

        <section className="card">
          <h3>污染源批次</h3>
          <label className="tr-source-label">
            污染源批次编号：
            <input
              aria-label="污染源批次编号"
              data-testid="tr-source"
              value={sourceCode}
              onChange={(event) => {
                setSourceCode(event.target.value);
                invalidate();
              }}
              placeholder="选择或填写发起追溯的污染源批次编号"
              list="tr-batch-codes"
              className="tr-source-input"
            />
          </label>
        </section>

        <div className="actions">
          <button type="submit" disabled={submitting} data-testid="tr-submit">
            {submitting ? "追溯中…" : "发起追溯"}
          </button>
        </div>
      </form>

      {transportError && (
        <section className="card error-summary" role="alert" data-testid="tr-transport-error">
          {transportError}
        </section>
      )}

      <ErrorSummary
        errors={fieldErrors}
        testIdPrefix="tr-field-error"
        title="字段级错误（未产生追溯结果，请修正后重新发起）"
      />
      {result && <TraceResult result={result} />}
    </div>
  );
}
