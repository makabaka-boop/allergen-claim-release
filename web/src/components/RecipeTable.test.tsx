import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RecipeTable } from "./RecipeTable";
import { emptyRow } from "../types";

describe("RecipeTable", () => {
  it("渲染直接成分与共线接触两组标记，并可勾选", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RecipeTable rows={[emptyRow("燕麦粉")]} onChange={onChange} onAdd={vi.fn()} onRemove={vi.fn()} />);

    expect(screen.getByLabelText("第 1 行同组共线接触：小麦")).toBeInTheDocument();
    expect((screen.getByTestId("row-0-name") as HTMLInputElement).value).toBe("燕麦粉");

    await user.click(screen.getByTestId("row-0-contact-barley"));
    expect(onChange).toHaveBeenCalledWith(0, expect.objectContaining({ contact_barley: true }));
  });

  it("空配方显示提示且添加/删除按钮可用", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    const onRemove = vi.fn();
    const { rerender } = render(
      <RecipeTable rows={[]} onChange={vi.fn()} onAdd={onAdd} onRemove={onRemove} />,
    );
    expect(screen.getByTestId("empty-recipe-hint")).toBeInTheDocument();
    await user.click(screen.getByTestId("add-row"));
    expect(onAdd).toHaveBeenCalledTimes(1);

    rerender(<RecipeTable rows={[emptyRow("一")]} onChange={vi.fn()} onAdd={onAdd} onRemove={onRemove} />);
    await user.click(screen.getByTestId("row-0-remove"));
    expect(onRemove).toHaveBeenCalledWith(0);
  });
});
