import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ClaimPicker } from "./ClaimPicker";

describe("ClaimPicker", () => {
  it("仅提供三种声明，切换时回报枚举值", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { container } = render(<ClaimPicker selected={[]} onToggle={onToggle} />);

    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(3);
    expect(screen.getByText("不含牛奶")).toBeInTheDocument();
    expect(screen.getByText("不含花生")).toBeInTheDocument();
    expect(screen.getByText("不含麸质")).toBeInTheDocument();

    await user.click(screen.getByTestId("claim-gluten_free"));
    expect(onToggle).toHaveBeenCalledWith("gluten_free");
  });

  it("未选择时给出提示", () => {
    render(<ClaimPicker selected={[]} onToggle={vi.fn()} />);
    expect(screen.getByTestId("empty-claims-hint")).toBeInTheDocument();
  });
});
