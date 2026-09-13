// 与后端 api/app/rules.py 的枚举严格对应
export const TARGETS = ["milk", "peanut", "wheat", "barley", "rye"] as const;
export type Target = (typeof TARGETS)[number];

export const CLAIMS = ["milk_free", "peanut_free", "gluten_free"] as const;
export type Claim = (typeof CLAIMS)[number];

export const TARGET_LABELS: Record<Target, string> = {
  milk: "牛奶",
  peanut: "花生",
  wheat: "小麦",
  barley: "大麦",
  rye: "黑麦",
};

export const CLAIM_LABELS: Record<Claim, string> = {
  milk_free: "不含牛奶",
  peanut_free: "不含花生",
  gluten_free: "不含麸质",
};

// 一条声明需要“全部未命中”的目标项；麸质严格等于小麦、大麦、黑麦
export const CLAIM_TARGETS: Record<Claim, readonly Target[]> = {
  milk_free: ["milk"],
  peanut_free: ["peanut"],
  gluten_free: ["wheat", "barley", "rye"],
};

export interface IngredientRow {
  name: string;
  contains_milk: boolean;
  contains_peanut: boolean;
  contains_wheat: boolean;
  contains_barley: boolean;
  contains_rye: boolean;
  contact_milk: boolean;
  contact_peanut: boolean;
  contact_wheat: boolean;
  contact_barley: boolean;
  contact_rye: boolean;
}

export interface Evidence {
  row_index: number;
  ingredient_name: string;
  target: Target;
  source: "direct" | "contact";
}

export interface RowReport {
  row_index: number;
  name: string;
  direct_hits: Target[];
  contact_hits: Target[];
}

export interface ClaimVerdict {
  claim: Claim;
  allowed: boolean;
  blocked_by: Evidence[];
}

export interface ReleaseResponse {
  printable: boolean;
  rows: RowReport[];
  verdicts: ClaimVerdict[];
}

export interface FieldError {
  // 去掉 FastAPI 定位中的 "body" 段后的字段路径，如 ingredients[0].contact_milk
  field: string;
  message: string;
}

export const DIRECT_FLAGS = [
  "contains_milk",
  "contains_peanut",
  "contains_wheat",
  "contains_barley",
  "contains_rye",
] as const satisfies readonly (keyof IngredientRow)[];

export const CONTACT_FLAGS = [
  "contact_milk",
  "contact_peanut",
  "contact_wheat",
  "contact_barley",
  "contact_rye",
] as const satisfies readonly (keyof IngredientRow)[];

export function emptyRow(name = ""): IngredientRow {
  return {
    name,
    contains_milk: false,
    contains_peanut: false,
    contains_wheat: false,
    contains_barley: false,
    contains_rye: false,
    contact_milk: false,
    contact_peanut: false,
    contact_wheat: false,
    contact_barley: false,
    contact_rye: false,
  };
}
