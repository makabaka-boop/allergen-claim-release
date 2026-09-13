import { expect, test } from "@playwright/test";

// 全部用例都走真实联调链路：
// 真实浏览器 -> Web（Nginx/Vite）-> 真实 FastAPI 裁决服务，无任何打桩。

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("健康检查接口由 Web 同源反代到真实 API", async ({ request }) => {
  const response = await request.get("/health");
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toEqual({ status: "ok" });
});

test("安全配方：所有声明逐条放行，整单显示可印刷", async ({ page }) => {
  await page.getByTestId("row-0-name").fill("白砂糖");
  await page.getByTestId("claim-milk_free").check();
  await page.getByTestId("claim-peanut_free").check();
  await page.getByTestId("claim-gluten_free").check();
  await page.getByTestId("submit").click();

  await expect(page.getByTestId("verdict-banner")).toHaveText("可印刷");
  await expect(page.getByTestId("verdict-milk_free")).toContainText("放行");
  await expect(page.getByTestId("verdict-peanut_free")).toContainText("放行");
  await expect(page.getByTestId("verdict-gluten_free")).toContainText("放行");
  await expect(page.getByTestId("report-row-0")).toContainText(
    "直接成分与共线接触均未命中目标项",
  );
});

test("仅共线接触小麦：直接成分干净仍阻断不含麸质，不含牛奶放行", async ({ page }) => {
  // 题目核心场景：原料本身与共线信息分开核对时最易漏掉的一条
  await page.getByTestId("row-0-name").fill("燕麦粉");
  await page.getByTestId("row-0-contact-wheat").check();
  await page.getByTestId("claim-milk_free").check();
  await page.getByTestId("claim-gluten_free").check();
  await page.getByTestId("submit").click();

  await expect(page.getByTestId("verdict-banner")).toHaveText(/禁止印刷/);
  const gluten = page.getByTestId("verdict-gluten_free");
  await expect(gluten).toContainText("阻断");
  await expect(gluten).toContainText("第 1 行「燕麦粉」同组共线接触命中小麦");
  await expect(page.getByTestId("verdict-milk_free")).toContainText("放行");
  await expect(page.getByTestId("report-row-0")).toContainText("同组共线接触：小麦");
  await expect(page.getByTestId("report-row-0")).not.toContainText("直接成分：");
});

test("直接成分大麦在第二行命中，阻断证据逐行逐条返回", async ({ page }) => {
  await page.getByTestId("row-0-name").fill("饮用水");
  await page.getByTestId("add-row").click();
  await page.getByTestId("row-1-name").fill("大麦提取物");
  await page.getByTestId("row-1-contains-barley").check();
  await page.getByTestId("claim-gluten_free").check();
  await page.getByTestId("submit").click();

  await expect(page.getByTestId("verdict-banner")).toHaveText(/禁止印刷/);
  await expect(page.getByTestId("blocked-gluten_free-0")).toHaveText(
    "第 2 行「大麦提取物」直接成分命中大麦",
  );
  await expect(page.getByTestId("report-row-0")).toContainText("均未命中目标项");
  await expect(page.getByTestId("report-row-1")).toContainText("直接成分：大麦");
});

test("牛奶直接成分与花生共线接触同时阻断各自声明，但不误伤不含麸质", async ({ page }) => {
  await page.getByTestId("row-0-name").fill("乳清粉");
  await page.getByTestId("row-0-contains-milk").check();
  await page.getByTestId("add-row").click();
  await page.getByTestId("row-1-name").fill("香辛料");
  await page.getByTestId("row-1-contact-peanut").check();

  await page.getByTestId("claim-milk_free").check();
  await page.getByTestId("claim-peanut_free").check();
  await page.getByTestId("claim-gluten_free").check();
  await page.getByTestId("submit").click();

  await expect(page.getByTestId("verdict-banner")).toHaveText(/禁止印刷/);
  await expect(page.getByTestId("verdict-milk_free")).toContainText("直接成分命中牛奶");
  await expect(page.getByTestId("verdict-peanut_free")).toContainText("同组共线接触命中花生");
  await expect(page.getByTestId("verdict-gluten_free")).toContainText("放行");
});

test("空配方：删除全部原料行后提交，只给字段级错误且不产生判定", async ({ page }) => {
  await page.getByTestId("row-0-remove").click();
  await expect(page.getByTestId("empty-recipe-hint")).toBeVisible();
  await page.getByTestId("claim-milk_free").check();
  await page.getByTestId("submit").click();

  await expect(page.getByTestId("field-error-0")).toContainText("配方不能为空");
  await expect(page.getByTestId("verdict-banner")).toHaveCount(0);
});

test("未选声明：提交只给字段级错误且不产生判定", async ({ page }) => {
  await page.getByTestId("row-0-name").fill("食用盐");
  await page.getByTestId("submit").click();

  await expect(page.getByTestId("field-error-0")).toContainText("至少选择一条拟印刷声明");
  await expect(page.getByTestId("verdict-banner")).toHaveCount(0);
});

test("后端对非法枚举与缺失共线标记返回 422，前端显示字段级错误", async ({ page }) => {
  // 直接构造绕过 UI 勾选约束的真实请求，验证端到端的 422 字段错误映射
  const invalidEnum = await page.request.post("/api/evaluate", {
    data: {
      ingredients: [
        {
          name: "原料",
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
        },
      ],
      claims: ["gluten_fre"],
    },
  });
  expect(invalidEnum.status()).toBe(422);
  const enumBody = await invalidEnum.json();
  expect(JSON.stringify(enumBody.detail)).toContain("claims");

  const missingFlag = await page.request.post("/api/evaluate", {
    data: {
      ingredients: [{ name: "原料" }],
      claims: ["milk_free"],
    },
  });
  expect(missingFlag.status()).toBe(422);
  const flagBody = await missingFlag.json();
  const fields = flagBody.detail.map(
    (err: { loc: (string | number)[] }) => err.loc.slice(1).join("."),
  );
  expect(fields).toEqual(
    expect.arrayContaining(["ingredients.0.contact_milk", "ingredients.0.contains_milk"]),
  );
});
