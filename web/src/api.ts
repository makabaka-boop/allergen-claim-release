import type { Claim, FieldError, IngredientRow, ReleaseResponse } from "./types";

// 开发环境走 Vite 代理（同源）；容器内由 Nginx 同源反代到 API
const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export class ApiError extends Error {
  constructor(
    public readonly fieldErrors: FieldError[],
    public readonly status: number,
  ) {
    super(fieldErrors.length ? `字段错误 ${fieldErrors.length} 条` : `请求失败（HTTP ${status}）`);
    this.name = "ApiError";
  }
}

interface FastApiError {
  loc: (string | number)[];
  msg: string;
  type: string;
}

// 将 FastAPI 的 422 detail 映射为字段级错误路径
export function mapFieldErrors(detail: FastApiError[]): FieldError[] {
  return detail.map((err) => {
    const parts = err.loc.filter((segment) => segment !== "body");
    const field = formatLocation(parts);
    return { field, message: err.msg };
  });
}

function formatLocation(parts: (string | number)[]): string {
  if (parts.length === 0) return "form";
  let out = String(parts[0]);
  for (const part of parts.slice(1)) {
    if (typeof part === "number") {
      out += `[${part}]`;
    } else {
      out += `.${part}`;
    }
  }
  return out;
}

export async function evaluateRelease(
  ingredients: IngredientRow[],
  claims: Claim[],
): Promise<ReleaseResponse> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ingredients, claims }),
    });
  } catch (cause) {
    throw new Error(`无法连接裁决服务：${(cause as Error).message}`);
  }

  if (response.ok) {
    return (await response.json()) as ReleaseResponse;
  }

  if (response.status === 422) {
    const payload = (await response.json()) as { detail: FastApiError[] };
    throw new ApiError(mapFieldErrors(payload.detail), response.status);
  }

  let detail = "";
  try {
    const payload = (await response.json()) as { detail?: string };
    detail = typeof payload.detail === "string" ? payload.detail : "";
  } catch {
    // 非 JSON 错误体，忽略
  }
  throw new Error(`裁决服务返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`);
}
