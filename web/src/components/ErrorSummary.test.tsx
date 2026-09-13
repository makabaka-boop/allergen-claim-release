import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ErrorSummary } from "./ErrorSummary";

describe("ErrorSummary", () => {
  it("无错误不渲染", () => {
    const { container } = render(<ErrorSummary errors={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("把字段路径翻译为中文字段名并展示消息", () => {
    render(
      <ErrorSummary
        errors={[
          { field: "ingredients[1].contact_milk", message: "Field required" },
          { field: "ingredients", message: "列表至少需要 1 项" },
          { field: "claims[0]", message: "非法声明枚举" },
        ]}
      />,
    );
    expect(screen.getByTestId("field-error-0")).toHaveTextContent(
      "第 2 行共线接触标记（milk）",
    );
    expect(screen.getByTestId("field-error-1")).toHaveTextContent("配方");
    expect(screen.getByTestId("field-error-2")).toHaveTextContent("声明");
  });
});
