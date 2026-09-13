import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { CompareResponse, ReleaseResponse } from "./types";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// 按 URL 分发的 fetch 打桩，并记录每次请求体供断言
function mockFetchRouter(handlers: Record<string, (payload: never) => Response>) {
  const calls: { url: string; payload: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const payload = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, payload });
    const handler = handlers[url];
    if (!handler) throw new Error(`未打桩的请求：${url}`);
    return handler(payload as never);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

const CLEAN_ROW = {
  row_index: 0,
  name: "燕麦粉",
  direct_hits: [],
  contact_hits: [],
};

function evaluateBody(overrides?: Partial<ReleaseResponse>): ReleaseResponse {
  return {
    printable: true,
    rows: [{ ...CLEAN_ROW }],
    verdicts: [{ claim: "gluten_free", allowed: true, blocked_by: [] }],
    ...overrides,
  };
}

// 完成一次正常裁决并把当前配方与声明设为对照
async function submitAndSetBaseline(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  claims: string[],
) {
  await user.type(screen.getByTestId("row-0-name"), name);
  for (const claim of claims) {
    await user.click(screen.getByTestId(`claim-${claim}`));
  }
  await user.click(screen.getByTestId("submit"));
  await waitFor(() => expect(screen.getByTestId("verdict-banner")).toBeInTheDocument());
  await user.click(screen.getByTestId("set-baseline"));
  await waitFor(() => expect(screen.getByTestId("compare")).toBeEnabled());
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

describe("前后方案影响比较", () => {
  it("新增小麦共线后比较：不含麸质新受阻，现方案结果保留，快照不被编辑污染", async () => {
    const compareBody: CompareResponse = {
      baseline: evaluateBody(),
      current: evaluateBody({
        printable: false,
        rows: [{ ...CLEAN_ROW, contact_hits: ["wheat"] }],
        verdicts: [
          {
            claim: "gluten_free",
            allowed: false,
            blocked_by: [
              { row_index: 0, ingredient_name: "燕麦粉", target: "wheat", source: "contact" },
            ],
          },
        ],
      }),
      comparisons: [
        {
          claim: "gluten_free",
          status: "newly_blocked",
          baseline_allowed: true,
          current_allowed: false,
          new_blockers: [
            { row_index: 0, ingredient_name: "燕麦粉", target: "wheat", source: "contact" },
          ],
          resolved_blockers: [],
        },
      ],
    };
    const { calls } = mockFetchRouter({
      "/api/evaluate": () => jsonResponse(evaluateBody()),
      "/api/compare": () => jsonResponse(compareBody),
    });

    const user = userEvent.setup();
    render(<App />);
    await submitAndSetBaseline(user, "燕麦粉", ["gluten_free"]);

    // 设对照后编辑同一表格：新增小麦共线接触
    await user.click(screen.getByTestId("row-0-contact-wheat"));
    await user.click(screen.getByTestId("compare"));

    // 比较面板展示变化原因；现方案结果保留在放行台
    await waitFor(() =>
      expect(screen.getByTestId("compare-gluten_free")).toHaveTextContent("新受阻"),
    );
    expect(screen.getByTestId("compare-gluten_free-new-0")).toHaveTextContent(
      "第 1 行「燕麦粉」同组共线接触命中小麦",
    );
    expect(screen.getByTestId("verdict-banner")).toHaveTextContent("禁止印刷");

    // 比较请求同时提交对照与现方案；编辑不反向污染已保存快照
    const compareCall = calls.find((call) => call.url === "/api/compare");
    const payload = compareCall?.payload as {
      baseline: { ingredients: { contact_wheat: boolean }[]; claims: string[] };
      current: { ingredients: { contact_wheat: boolean }[]; claims: string[] };
    };
    expect(payload.baseline.ingredients[0].contact_wheat).toBe(false);
    expect(payload.current.ingredients[0].contact_wheat).toBe(true);
    expect(payload.baseline.claims).toEqual(["gluten_free"]);
    expect(payload.current.claims).toEqual(["gluten_free"]);
  });

  it("移除牛奶命中后比较：不含牛奶已解除", async () => {
    const compareBody: CompareResponse = {
      baseline: evaluateBody({
        printable: false,
        rows: [{ ...CLEAN_ROW, name: "全脂奶粉", direct_hits: ["milk"] }],
        verdicts: [
          {
            claim: "milk_free",
            allowed: false,
            blocked_by: [
              { row_index: 0, ingredient_name: "全脂奶粉", target: "milk", source: "direct" },
            ],
          },
        ],
      }),
      current: evaluateBody({
        rows: [{ ...CLEAN_ROW, name: "全脂奶粉" }],
        verdicts: [{ claim: "milk_free", allowed: true, blocked_by: [] }],
      }),
      comparisons: [
        {
          claim: "milk_free",
          status: "resolved",
          baseline_allowed: false,
          current_allowed: true,
          new_blockers: [],
          resolved_blockers: [
            { row_index: 0, ingredient_name: "全脂奶粉", target: "milk", source: "direct" },
          ],
        },
      ],
    };
    mockFetchRouter({
      "/api/evaluate": () =>
        jsonResponse(
          evaluateBody({
            printable: false,
            rows: [{ ...CLEAN_ROW, name: "全脂奶粉", direct_hits: ["milk"] }],
            verdicts: [
              {
                claim: "milk_free",
                allowed: false,
                blocked_by: [
                  {
                    row_index: 0,
                    ingredient_name: "全脂奶粉",
                    target: "milk",
                    source: "direct",
                  },
                ],
              },
            ],
          }),
        ),
      "/api/compare": () => jsonResponse(compareBody),
    });

    const user = userEvent.setup();
    render(<App />);
    // 对照：直接成分含牛奶
    await user.click(screen.getByTestId("row-0-contains-milk"));
    await submitAndSetBaseline(user, "全脂奶粉", ["milk_free"]);

    // 现方案：移除牛奶命中
    await user.click(screen.getByTestId("row-0-contains-milk"));
    await user.click(screen.getByTestId("compare"));

    await waitFor(() =>
      expect(screen.getByTestId("compare-milk_free")).toHaveTextContent("已解除"),
    );
    expect(screen.getByTestId("compare-milk_free-resolved-0")).toHaveTextContent(
      "第 1 行「全脂奶粉」直接成分命中牛奶",
    );
    expect(screen.getByTestId("verdict-banner")).toHaveTextContent("可印刷");
  });

  it("无关花生改动保持麸质结论：未变化", async () => {
    const compareBody: CompareResponse = {
      baseline: evaluateBody(),
      current: evaluateBody(),
      comparisons: [
        {
          claim: "gluten_free",
          status: "unchanged",
          baseline_allowed: true,
          current_allowed: true,
          new_blockers: [],
          resolved_blockers: [],
        },
      ],
    };
    mockFetchRouter({
      "/api/evaluate": () => jsonResponse(evaluateBody()),
      "/api/compare": () => jsonResponse(compareBody),
    });

    const user = userEvent.setup();
    render(<App />);
    await submitAndSetBaseline(user, "白砂糖", ["gluten_free"]);

    // 花生不属于麸质目标集合：共线新增花生不影响“不含麸质”
    await user.click(screen.getByTestId("row-0-contact-peanut"));
    await user.click(screen.getByTestId("compare"));

    await waitFor(() =>
      expect(screen.getByTestId("compare-gluten_free")).toHaveTextContent("未变化"),
    );
    expect(screen.getByTestId("compare-gluten_free")).toHaveTextContent(
      "对照方案：放行 → 现方案：放行",
    );
  });

  it("未设置对照时比较按钮不可用", async () => {
    mockFetchRouter({
      "/api/evaluate": () => jsonResponse(evaluateBody()),
    });
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByTestId("compare")).toBeDisabled();
    // 完成正常裁决后、未设对照前，比较按钮仍不可用
    await user.type(screen.getByTestId("row-0-name"), "白砂糖");
    await user.click(screen.getByTestId("claim-gluten_free"));
    await user.click(screen.getByTestId("submit"));
    await waitFor(() => expect(screen.getByTestId("verdict-banner")).toBeInTheDocument());
    expect(screen.getByTestId("compare")).toBeDisabled();
    // 设对照后可用
    await user.click(screen.getByTestId("set-baseline"));
    expect(screen.getByTestId("compare")).toBeEnabled();
  });

  it("非法现方案：按现方案路径显示字段错误且不产生比较结果", async () => {
    mockFetchRouter({
      "/api/evaluate": () => jsonResponse(evaluateBody()),
      "/api/compare": () =>
        jsonResponse(
          {
            detail: [
              {
                loc: ["body", "current", "ingredients", 0, "contact_wheat"],
                msg: "Field required",
                type: "missing",
              },
            ],
          },
          422,
        ),
    });

    const user = userEvent.setup();
    render(<App />);
    await submitAndSetBaseline(user, "燕麦粉", ["gluten_free"]);
    await user.click(screen.getByTestId("compare"));

    await waitFor(() =>
      expect(screen.getByTestId("field-error-0")).toHaveTextContent(
        "现方案·第 1 行共线接触标记（wheat）",
      ),
    );
    expect(screen.queryByTestId("compare-panel")).not.toBeInTheDocument();
  });

  it("比较连接失败：保留对照快照与编辑内容以便重试", async () => {
    let compareAttempts = 0;
    const compareBody: CompareResponse = {
      baseline: evaluateBody(),
      current: evaluateBody(),
      comparisons: [
        {
          claim: "gluten_free",
          status: "unchanged",
          baseline_allowed: true,
          current_allowed: true,
          new_blockers: [],
          resolved_blockers: [],
        },
      ],
    };
    mockFetchRouter({
      "/api/evaluate": () => jsonResponse(evaluateBody()),
      "/api/compare": () => {
        compareAttempts += 1;
        if (compareAttempts === 1) throw new TypeError("Failed to fetch");
        return jsonResponse(compareBody);
      },
    });

    const user = userEvent.setup();
    render(<App />);
    await submitAndSetBaseline(user, "燕麦粉", ["gluten_free"]);
    await user.click(screen.getByTestId("row-0-contact-wheat"));
    await user.click(screen.getByTestId("compare"));

    // 连接失败：提示传输错误，快照与编辑内容保留
    await waitFor(() =>
      expect(screen.getByTestId("transport-error")).toHaveTextContent("无法连接裁决服务"),
    );
    expect(screen.getByTestId("compare")).toBeEnabled();
    expect(screen.getByTestId("baseline-hint")).toBeInTheDocument();
    expect(screen.getByTestId("row-0-name")).toHaveValue("燕麦粉");
    expect(screen.getByTestId("row-0-contact-wheat")).toBeChecked();

    // 直接重试即可成功
    await user.click(screen.getByTestId("compare"));
    await waitFor(() =>
      expect(screen.getByTestId("compare-gluten_free")).toHaveTextContent("未变化"),
    );
    expect(screen.queryByTestId("transport-error")).not.toBeInTheDocument();
  });
});
