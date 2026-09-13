import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ResultPanel } from "./ResultPanel";
import type { ReleaseResponse } from "../types";

const blockedResponse: ReleaseResponse = {
  printable: false,
  rows: [
    {
      row_index: 0,
      name: "燕麦粉",
      direct_hits: [],
      contact_hits: ["wheat"],
    },
  ],
  verdicts: [
    {
      claim: "gluten_free",
      allowed: false,
      blocked_by: [
        { row_index: 0, ingredient_name: "燕麦粉", target: "wheat", source: "contact" },
      ],
    },
    { claim: "milk_free", allowed: true, blocked_by: [] },
  ],
};

describe("ResultPanel", () => {
  it("阻断时明确展示禁止印刷、逐行证据与对应声明阻断原因", () => {
    render(<ResultPanel result={blockedResponse} />);
    expect(screen.getByTestId("verdict-banner")).toHaveTextContent("禁止印刷");
    expect(screen.getByTestId("report-row-0")).toHaveTextContent("同组共线接触：小麦");
    const verdict = screen.getByTestId("verdict-gluten_free");
    expect(verdict).toHaveTextContent("阻断");
    expect(verdict).toHaveTextContent("第 1 行「燕麦粉」同组共线接触命中小麦");
    expect(screen.getByTestId("verdict-milk_free")).toHaveTextContent("放行");
  });

  it("全部放行时显示可印刷", () => {
    const clean: ReleaseResponse = {
      printable: true,
      rows: [{ row_index: 0, name: "白砂糖", direct_hits: [], contact_hits: [] }],
      verdicts: [{ claim: "milk_free", allowed: true, blocked_by: [] }],
    };
    render(<ResultPanel result={clean} />);
    expect(screen.getByTestId("verdict-banner")).toHaveTextContent("可印刷");
  });
});
