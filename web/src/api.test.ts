import { describe, expect, it } from "vitest";
import { ApiError, mapFieldErrors } from "./api";

describe("mapFieldErrors", () => {
  it("去掉 FastAPI loc 中的 body 段并格式化嵌套索引", () => {
    const errors = mapFieldErrors([
      { loc: ["body", "ingredients", 0, "contact_milk"], msg: "Field required", type: "missing" },
      { loc: ["body", "ingredients"], msg: "列表至少需要 1 项", type: "too_short" },
      { loc: ["body", "claims", 0], msg: "非法声明枚举", type: "value_error" },
    ]);
    expect(errors.map((e) => e.field)).toEqual([
      "ingredients[0].contact_milk",
      "ingredients",
      "claims[0]",
    ]);
    expect(errors[0].message).toBe("Field required");
  });

  it("空定位回退到 form", () => {
    expect(mapFieldErrors([{ loc: ["body"], msg: "bad", type: "value_error" }])[0].field).toBe(
      "form",
    );
  });

  it("ApiError 保留字段错误与状态码", () => {
    const error = new ApiError([{ field: "claims", message: "非法" }], 422);
    expect(error.status).toBe(422);
    expect(error.fieldErrors).toHaveLength(1);
  });
});
