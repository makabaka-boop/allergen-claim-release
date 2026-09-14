import type {
  ChangeoverPayload,
  ChangeoverResponse,
  Claim,
  CompareResponse,
  FieldError,
  IngredientRow,
  ReleasePlan,
  ReleaseResponse,
  TraceabilityPayload,
  TraceabilityResponse,
} from "./types";

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

// 统一的 POST 调用：传输失败、422 字段级错误、其他 HTTP 错误的处理一致
async function post<T>(path: string, payload: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (cause) {
    throw new Error(`无法连接裁决服务：${(cause as Error).message}`);
  }

  if (response.ok) {
    return (await response.json()) as T;
  }

  if (response.status === 422) {
    const payload422 = (await response.json()) as { detail: FastApiError[] };
    throw new ApiError(mapFieldErrors(payload422.detail), response.status);
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

export function evaluateRelease(
  ingredients: IngredientRow[],
  claims: Claim[],
): Promise<ReleaseResponse> {
  return post<ReleaseResponse>("/api/evaluate", { ingredients, claims });
}

// 前后方案影响比较：同时提交对照方案与现方案，后端分别裁决后按声明对比
export function compareRelease(
  baseline: ReleasePlan,
  current: ReleasePlan,
): Promise<CompareResponse> {
  return post<CompareResponse>("/api/compare", { baseline, current });
}

// 换线残留推演：提交生产批次序列与相邻批次清洁边界，逐批返回残留与来源
export function simulateChangeover(payload: ChangeoverPayload): Promise<ChangeoverResponse> {
  return post<ChangeoverResponse>("/api/changeover", payload);
}

// 批次用料追溯：提交完整关系图（批次台账 + 投料关系）与污染源，
// 后端校验引用/自引用/成环后按录入顺序稳定遍历，返回按层级组织的
// 可到达批次及每个批次的最短投料路径
export function traceBatches(payload: TraceabilityPayload): Promise<TraceabilityResponse> {
  return post<TraceabilityResponse>("/api/trace", payload);
}
