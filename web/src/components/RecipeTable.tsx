import { TARGETS, TARGET_LABELS } from "../types";
import type { IngredientRow } from "../types";

interface RecipeTableProps {
  rows: IngredientRow[];
  onChange: (index: number, row: IngredientRow) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}

export function RecipeTable({ rows, onChange, onAdd, onRemove }: RecipeTableProps) {
  const update = (index: number, patch: Partial<IngredientRow>) => {
    onChange(index, { ...rows[index], ...patch });
  };

  return (
    <section className="card" aria-labelledby="recipe-heading">
      <div className="card-head">
        <h2 id="recipe-heading">结构化配方表</h2>
        <button type="button" className="secondary" onClick={onAdd} data-testid="add-row">
          添加原料行
        </button>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th rowSpan={2}>原料名称</th>
              <th colSpan={TARGETS.length}>直接成分（勾选=含有）</th>
              <th colSpan={TARGETS.length}>同组共线接触（勾选=同产线接触）</th>
              <th rowSpan={2}>操作</th>
            </tr>
            <tr>
              {TARGETS.map((target) => (
                <th key={`direct-${target}`}>{TARGET_LABELS[target]}</th>
              ))}
              {TARGETS.map((target) => (
                <th key={`contact-${target}`} className="contact-col">
                  接触{TARGET_LABELS[target]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={2 * TARGETS.length + 2} className="empty-hint" data-testid="empty-recipe-hint">
                  配方为空：放行台不会对空配方产生判定，请先添加原料行。
                </td>
              </tr>
            )}
            {rows.map((row, index) => (
              <tr key={index} data-testid={`row-${index}`}>
                <td>
                  <input
                    aria-label={`第 ${index + 1} 行原料名称`}
                    data-testid={`row-${index}-name`}
                    value={row.name}
                    onChange={(event) => update(index, { name: event.target.value })}
                    placeholder="如：燕麦粉"
                  />
                </td>
                {TARGETS.map((target) => (
                  <td key={`contains-${target}`} className="check-cell">
                    <input
                      type="checkbox"
                      aria-label={`第 ${index + 1} 行直接成分：${TARGET_LABELS[target]}`}
                      data-testid={`row-${index}-contains-${target}`}
                      checked={row[`contains_${target}`]}
                      onChange={(event) =>
                        update(index, { [`contains_${target}`]: event.target.checked })
                      }
                    />
                  </td>
                ))}
                {TARGETS.map((target) => (
                  <td key={`contact-${target}`} className="check-cell contact-col">
                    <input
                      type="checkbox"
                      aria-label={`第 ${index + 1} 行同组共线接触：${TARGET_LABELS[target]}`}
                      data-testid={`row-${index}-contact-${target}`}
                      checked={row[`contact_${target}`]}
                      onChange={(event) =>
                        update(index, { [`contact_${target}`]: event.target.checked })
                      }
                    />
                  </td>
                ))}
                <td>
                  <button
                    type="button"
                    className="danger"
                    aria-label={`删除第 ${index + 1} 行`}
                    data-testid={`row-${index}-remove`}
                    onClick={() => onRemove(index)}
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
  );
}
