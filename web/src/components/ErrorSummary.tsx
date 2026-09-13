import type { FieldError } from "../types";

interface ErrorSummaryProps {
  errors: FieldError[];
}

const FIELD_NAMES: Record<string, string> = {
  ingredients: "配方",
  claims: "声明",
  name: "原料名称",
};

function humanizeField(field: string): string {
  const rowMatch = field.match(/^ingredients\[(\d+)\](?:\.(.+))?$/);
  if (rowMatch) {
    const rowNumber = Number(rowMatch[1]) + 1;
    const rest = rowMatch[2];
    if (!rest) return `第 ${rowNumber} 行原料`;
    if (rest === "name") return `第 ${rowNumber} 行原料名称`;
    if (rest.startsWith("contains_")) {
      return `第 ${rowNumber} 行直接成分标记（${rest.replace("contains_", "")}）`;
    }
    if (rest.startsWith("contact_")) {
      return `第 ${rowNumber} 行共线接触标记（${rest.replace("contact_", "")}）`;
    }
    return `第 ${rowNumber} 行字段 ${rest}`;
  }
  return FIELD_NAMES[field] ?? field;
}

export function ErrorSummary({ errors }: ErrorSummaryProps) {
  if (errors.length === 0) return null;
  return (
    <section className="card error-summary" role="alert" aria-live="assertive">
      <h2>字段级错误（未产生判定，请修正后重新提交）</h2>
      <ul>
        {errors.map((error, index) => (
          <li key={`${error.field}-${index}`} data-testid={`field-error-${index}`}>
            <strong>{humanizeField(error.field)}：</strong>
            <span>{error.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
