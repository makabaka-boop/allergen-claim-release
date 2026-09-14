import type { FieldError } from "../types";

interface ErrorSummaryProps {
  errors: FieldError[];
  // 错误条目 testid 前缀，默认 field-error（放行台）；换线模块使用 changeover-field-error
  testIdPrefix?: string;
  // 标题可由调用方按模块覆盖
  title?: string;
}

const FIELD_NAMES: Record<string, string> = {
  ingredients: "配方",
  claims: "声明",
  name: "原料名称",
  batches: "生产批次序列",
  boundaries: "清洁边界",
  cleaned: "经验证清洁标记",
  source_code: "污染源批次",
};

function humanizeFlag(rest: string): string | null {
  if (rest.startsWith("contains_")) {
    return `直接成分标记（${rest.replace("contains_", "")}）`;
  }
  if (rest.startsWith("contact_")) {
    return `共线接触标记（${rest.replace("contact_", "")}）`;
  }
  return null;
}

function humanizeField(field: string): string {
  // 比较请求的 422 错误按方案路径定位：baseline.* / current.*
  const planMatch = field.match(/^(baseline|current)\.(.+)$/);
  if (planMatch) {
    const plan = planMatch[1] === "baseline" ? "对照方案" : "现方案";
    return `${plan}·${humanizeField(planMatch[2])}`;
  }

  const rowMatch = field.match(/^ingredients\[(\d+)\](?:\.(.+))?$/);
  if (rowMatch) {
    const rowNumber = Number(rowMatch[1]) + 1;
    const rest = rowMatch[2];
    if (!rest) return `第 ${rowNumber} 行原料`;
    if (rest === "name") return `第 ${rowNumber} 行原料名称`;
    const flag = humanizeFlag(rest);
    if (flag) return `第 ${rowNumber} 行${flag}`;
    return `第 ${rowNumber} 行字段 ${rest}`;
  }

  // 批次用料追溯：batches[i].code / material_name / batch_type
  // （必须在换线推演的 batches[i].* 通用匹配之前命中，取得精确字段名）
  const traceBatchMatch = field.match(
    /^batches\[(\d+)\]\.(code|material_name|batch_type)$/,
  );
  if (traceBatchMatch) {
    const order = Number(traceBatchMatch[1]) + 1;
    const rest = traceBatchMatch[2];
    if (rest === "code") return `第 ${order} 个批次编号`;
    if (rest === "material_name") return `第 ${order} 个批次物料名称`;
    return `第 ${order} 个批次类型`;
  }

  // 换线推演：batches[i].name / batches[i].contains_*
  const batchMatch = field.match(/^batches\[(\d+)\](?:\.(.+))?$/);
  if (batchMatch) {
    const batchNumber = Number(batchMatch[1]) + 1;
    const rest = batchMatch[2];
    if (!rest) return `第 ${batchNumber} 批`;
    if (rest === "name") return `第 ${batchNumber} 批批次名称`;
    const flag = humanizeFlag(rest);
    if (flag) return `第 ${batchNumber} 批${flag}`;
    return `第 ${batchNumber} 批字段 ${rest}`;
  }

  // 换线推演：boundaries[i].cleaned / boundaries[i].cleared_targets[?]
  const boundaryMatch = field.match(/^boundaries\[(\d+)\](?:\.(.+))?$/);
  if (boundaryMatch) {
    // 边界 i 位于第 i+1 批与第 i+2 批之间
    const left = Number(boundaryMatch[1]) + 1;
    const rest = boundaryMatch[2];
    if (!rest || rest === "cleaned") {
      return `第 ${left} 批与第 ${left + 1} 批之间的经验证清洁标记`;
    }
    if (rest === "cleared_targets" || rest.startsWith("cleared_targets[")) {
      return `第 ${left} 批与第 ${left + 1} 批之间局部清洁的清除目标`;
    }
    return `第 ${left} 批与第 ${left + 1} 批之间清洁边界字段 ${rest}`;
  }

  // 批次用料追溯：relations[i].from_code / to_code
  const traceRelationMatch = field.match(/^relations\[(\d+)\]\.(from_code|to_code)$/);
  if (traceRelationMatch) {
    const order = Number(traceRelationMatch[1]) + 1;
    return traceRelationMatch[2] === "from_code"
      ? `第 ${order} 条投料关系的来源批次`
      : `第 ${order} 条投料关系的目标批次`;
  }

  return FIELD_NAMES[field] ?? field;
}

export function ErrorSummary({
  errors,
  testIdPrefix = "field-error",
  title = "字段级错误（未产生判定，请修正后重新提交）",
}: ErrorSummaryProps) {
  if (errors.length === 0) return null;
  return (
    <section className="card error-summary" role="alert" aria-live="assertive">
      <h2>{title}</h2>
      <ul>
        {errors.map((error, index) => (
          <li key={`${error.field}-${index}`} data-testid={`${testIdPrefix}-${index}`}>
            <strong>{humanizeField(error.field)}：</strong>
            <span>{error.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
