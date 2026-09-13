import { expect, test } from "@playwright/test";

// 前后方案影响比较的端到端：真实浏览器 -> Web -> 真实 FastAPI，
// 对照与现方案由后端同一裁决函数分别计算。

const ALL_FLAGS_FALSE = {
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

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("新增小麦共线后比较：不含麸质新受阻，现方案结果保留在放行台", async ({ page }) => {
  // 对照：燕麦粉全部干净，正常裁决放行后设为对照
  await page.getByTestId("row-0-name").fill("燕麦粉");
  await page.getByTestId("claim-gluten_free").check();
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("verdict-banner")).toHaveText("可印刷");
  await page.getByTestId("set-baseline").click();
  await expect(page.getByTestId("baseline-hint")).toContainText("已保存对照快照");

  // 现方案：同一表格新增小麦共线接触，点击比较
  await page.getByTestId("row-0-contact-wheat").check();
  await page.getByTestId("compare").click();

  // 页面保留现方案结果，并展示该声明的变化原因
  await expect(page.getByTestId("verdict-banner")).toHaveText(/禁止印刷/);
  const gluten = page.getByTestId("compare-gluten_free");
  await expect(gluten).toContainText("新受阻");
  await expect(gluten).toContainText("对照方案：放行 → 现方案：阻断");
  await expect(page.getByTestId("compare-gluten_free-new-0")).toHaveText(
    "第 1 行「燕麦粉」同组共线接触命中小麦",
  );
});

test("移除牛奶命中后比较：不含牛奶已解除", async ({ page }) => {
  // 对照：直接成分含牛奶，声明被阻断
  await page.getByTestId("row-0-name").fill("全脂奶粉");
  await page.getByTestId("row-0-contains-milk").check();
  await page.getByTestId("claim-milk_free").check();
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("verdict-banner")).toHaveText(/禁止印刷/);
  await page.getByTestId("set-baseline").click();

  // 现方案：移除牛奶命中
  await page.getByTestId("row-0-contains-milk").uncheck();
  await page.getByTestId("compare").click();

  await expect(page.getByTestId("verdict-banner")).toHaveText("可印刷");
  const milk = page.getByTestId("compare-milk_free");
  await expect(milk).toContainText("已解除");
  await expect(page.getByTestId("compare-milk_free-resolved-0")).toHaveText(
    "第 1 行「全脂奶粉」直接成分命中牛奶",
  );
});

test("无关花生改动保持麸质结论：未变化", async ({ page }) => {
  await page.getByTestId("row-0-name").fill("白砂糖");
  await page.getByTestId("claim-gluten_free").check();
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("verdict-banner")).toHaveText("可印刷");
  await page.getByTestId("set-baseline").click();

  // 花生不属于麸质目标集合：新增花生共线不影响“不含麸质”
  await page.getByTestId("row-0-contact-peanut").check();
  await page.getByTestId("compare").click();

  const gluten = page.getByTestId("compare-gluten_free");
  await expect(gluten).toContainText("未变化");
  await expect(gluten).toContainText("对照方案：放行 → 现方案：放行");
  await expect(page.getByTestId("verdict-banner")).toHaveText("可印刷");
});

test("未设置对照时比较按钮不可用", async ({ page }) => {
  await expect(page.getByTestId("compare")).toBeDisabled();
  await expect(page.getByTestId("set-baseline")).toBeDisabled();

  // 完成正常裁决后可设对照，设对照后比较按钮才可用
  await page.getByTestId("row-0-name").fill("白砂糖");
  await page.getByTestId("claim-gluten_free").check();
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("verdict-banner")).toHaveText("可印刷");
  await expect(page.getByTestId("compare")).toBeDisabled();
  await page.getByTestId("set-baseline").click();
  await expect(page.getByTestId("compare")).toBeEnabled();
});

test("非法现方案：后端按现方案路径返回 422 且不产生比较结果", async ({ page }) => {
  // 直接构造真实请求验证契约：现方案缺失共线标记
  const response = await page.request.post("/api/compare", {
    data: {
      baseline: {
        ingredients: [{ name: "白砂糖", ...ALL_FLAGS_FALSE }],
        claims: ["gluten_free"],
      },
      current: {
        ingredients: [{ name: "燕麦粉" }],
        claims: ["gluten_free"],
      },
    },
  });
  expect(response.status()).toBe(422);
  const body = await response.json();
  const fields = body.detail.map((err: { loc: (string | number)[] }) =>
    err.loc.slice(1).join("."),
  );
  expect(fields).toEqual(
    expect.arrayContaining([
      "current.ingredients.0.contact_wheat",
      "current.ingredients.0.contains_milk",
    ]),
  );
  expect(body.comparisons).toBeUndefined();

  // 对照方案非法时按对照路径定位
  const badBaseline = await page.request.post("/api/compare", {
    data: {
      baseline: {
        ingredients: [{ name: "白砂糖", ...ALL_FLAGS_FALSE }],
        claims: ["gluten_fre"],
      },
      current: {
        ingredients: [{ name: "白砂糖", ...ALL_FLAGS_FALSE }],
        claims: ["gluten_free"],
      },
    },
  });
  expect(badBaseline.status()).toBe(422);
  const baselineBody = await badBaseline.json();
  expect(
    baselineBody.detail.some((err: { loc: (string | number)[] }) =>
      err.loc.slice(0, 2).join(".") === "body.baseline",
    ),
  ).toBeTruthy();
});

test("原有裁决入口及响应结构保持不变", async ({ request }) => {
  const response = await request.post("/api/evaluate", {
    data: {
      ingredients: [{ name: "燕麦粉", ...ALL_FLAGS_FALSE, contact_wheat: true }],
      claims: ["gluten_free"],
    },
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(Object.keys(body).sort()).toEqual(["printable", "rows", "verdicts"]);
  expect(body.printable).toBe(false);
  expect(body.verdicts[0].blocked_by[0]).toEqual({
    row_index: 0,
    ingredient_name: "燕麦粉",
    target: "wheat",
    source: "contact",
  });
});
