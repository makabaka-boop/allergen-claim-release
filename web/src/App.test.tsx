import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

// 传输层打桩：裁决仍由真实后端语义驱动（返回体按真实 API 契约构造）
function mockFetchOnce(body: unknown, init?: ResponseInit) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
        ...init,
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fillAndSubmit(name: string, claims: string[]) {
  const user = userEvent.setup();
  render(<App />);
  await user.clear(screen.getByTestId("row-0-name"));
  await user.type(screen.getByTestId("row-0-name"), name);
  for (const claim of claims) {
    await user.click(screen.getByTestId(`claim-${claim}`));
  }
  await user.click(screen.getByTestId("submit"));
}

describe("App 联调状态流", () => {
  it("安全配方提交真实请求体并显示可印刷，载荷包含全部直接与共线标记", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          printable: true,
          rows: [{ row_index: 0, name: "白砂糖", direct_hits: [], contact_hits: [] }],
          verdicts: [
            { claim: "milk_free", allowed: true, blocked_by: [] },
            { claim: "peanut_free", allowed: true, blocked_by: [] },
            { claim: "gluten_free", allowed: true, blocked_by: [] },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fillAndSubmit("白砂糖", ["milk_free", "peanut_free", "gluten_free"]);

    await waitFor(() => expect(screen.getByTestId("verdict-banner")).toHaveTextContent("可印刷"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/evaluate");
    const payload = JSON.parse((options as RequestInit).body as string);
    expect(payload.ingredients[0]).toEqual({
      name: "白砂糖",
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
    });
    expect(payload.claims).toEqual(["milk_free", "peanut_free", "gluten_free"]);
  });

  it("仅共线接触小麦的响应阻断麸质声明并整体禁止印刷", async () => {
    mockFetchOnce({
      printable: false,
      rows: [{ row_index: 0, name: "燕麦粉", direct_hits: [], contact_hits: ["wheat"] }],
      verdicts: [
        {
          claim: "gluten_free",
          allowed: false,
          blocked_by: [
            { row_index: 0, ingredient_name: "燕麦粉", target: "wheat", source: "contact" },
          ],
        },
      ],
    });

    await fillAndSubmit("燕麦粉", ["gluten_free"]);

    await waitFor(() => expect(screen.getByTestId("verdict-banner")).toHaveTextContent("禁止印刷"));
    expect(screen.getByTestId("verdict-gluten_free")).toHaveTextContent(
      "同组共线接触命中小麦",
    );
  });

  it("422 字段级错误按字段展示且不显示判定结果", async () => {
    mockFetchOnce(
      {
        detail: [
          {
            loc: ["body", "ingredients", 0, "contact_milk"],
            msg: "Field required",
            type: "missing",
          },
        ],
      },
      { status: 422 },
    );

    await fillAndSubmit("奶粉", ["milk_free"]);

    await waitFor(() =>
      expect(screen.getByTestId("field-error-0")).toHaveTextContent(
        "第 1 行共线接触标记（milk）",
      ),
    );
    expect(screen.queryByTestId("verdict-banner")).not.toBeInTheDocument();
  });

  it("空配方（删除全部行）时不发送请求并提示", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByTestId("row-0-remove"));
    expect(screen.getByTestId("empty-recipe-hint")).toBeInTheDocument();
    await user.click(screen.getByTestId("claim-milk_free"));
    await user.click(screen.getByTestId("submit"));

    expect(screen.getByTestId("field-error-0")).toHaveTextContent("配方不能为空");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("未选声明时不发送请求并提示", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByTestId("row-0-name"), "盐");
    await user.click(screen.getByTestId("submit"));

    expect(screen.getByTestId("field-error-0")).toHaveTextContent("至少选择一条");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("勾选共线大麦后请求体携带 contact_barley=true", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          printable: false,
          rows: [{ row_index: 0, name: "麦茶", direct_hits: [], contact_hits: ["barley"] }],
          verdicts: [
            {
              claim: "gluten_free",
              allowed: false,
              blocked_by: [
                { row_index: 0, ingredient_name: "麦茶", target: "barley", source: "contact" },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByTestId("row-0-name"), "麦茶");
    await user.click(screen.getByTestId("row-0-contact-barley"));
    await user.click(screen.getByTestId("claim-gluten_free"));
    await user.click(screen.getByTestId("submit"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.ingredients[0].contact_barley).toBe(true);
  });
});
