import { expect, test } from "@playwright/test";

// 换线残留推演端到端：真实浏览器 -> Web（Nginx/Vite）-> 真实 FastAPI，
// 无任何打桩。来源解释必须来自真实推演服务的响应。

const DIRECT_FLAGS = [
  "contains_milk",
  "contains_peanut",
  "contains_wheat",
  "contains_barley",
  "contains_rye",
] as const;

function batch(name: string, flags: Partial<Record<(typeof DIRECT_FLAGS)[number], boolean>> = {}) {
  const payload: Record<string, unknown> = { name };
  for (const flag of DIRECT_FLAGS) payload[flag] = flags[flag] ?? false;
  return payload;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("录入未清洁序列：花生连续带入后续批次，来源解释来自真实服务", async ({ page }) => {
  // 三批：花生酱A(花生) -> 中转B(干净) -> 燕麦C(干净)，两个边界均不清洁
  await page.getByTestId("co-batch-0-name").fill("花生酱A");
  await page.getByTestId("co-batch-0-contains-peanut").check();
  await page.getByTestId("co-batch-1-name").fill("中转B");
  await page.getByTestId("co-add-batch").click();
  await page.getByTestId("co-batch-2-name").fill("燕麦C");
  await page.getByTestId("co-submit").click();

  // 第 2 批：进入残留与带入物都有花生，来源解释指向第 1 批
  await expect(page.getByTestId("co-batch-1-incoming-peanut")).toContainText("花生");
  await expect(page.getByTestId("co-batch-1-incoming-peanut")).toContainText("来源：第 1 批「花生酱A」");
  await expect(page.getByTestId("co-batch-1-carried-peanut")).toContainText("花生酱A");
  await expect(page.getByTestId("co-batch-1-outgoing-peanut")).toContainText("花生酱A");

  // 第 3 批：连续带入，最近来源仍是第 1 批
  await expect(page.getByTestId("co-batch-2-incoming-peanut")).toContainText(
    "来源：第 1 批「花生酱A」",
  );
  await expect(page.getByTestId("co-batch-2-carried-peanut")).toContainText("花生酱A");

  // 首批无进入残留
  await expect(page.getByTestId("co-batch-0-incoming")).toContainText("无");
});

test("直接成分不误报：本批直接含花生不计入带入物，但来源刷新为本批", async ({ page }) => {
  await page.getByTestId("co-batch-0-name").fill("花生酱A");
  await page.getByTestId("co-batch-0-contains-peanut").check();
  await page.getByTestId("co-batch-1-name").fill("花生酥B");
  await page.getByTestId("co-batch-1-contains-peanut").check();
  await page.getByTestId("co-add-batch").click();
  await page.getByTestId("co-batch-2-name").fill("燕麦C");
  await page.getByTestId("co-submit").click();

  // B 批进入残留有花生，但带入物列表为空（花生是本批直接成分）
  await expect(page.getByTestId("co-batch-1-incoming-peanut")).toContainText("花生酱A");
  await expect(page.getByTestId("co-batch-1-direct")).toContainText("花生");
  await expect(page.getByTestId("co-batch-1-carried")).toContainText("无");
  // 离开残留花生的最近来源刷新为 B
  await expect(page.getByTestId("co-batch-1-outgoing-peanut")).toContainText("花生酥B");
  // 第 3 批看到的来源是第 2 批 B
  await expect(page.getByTestId("co-batch-2-incoming-peanut")).toContainText("花生酥B");
});

test("标记经验证清洁：清洁后后续批次不再显示残留，清洁后新引入的残留独立传递", async ({ page }) => {
  await page.getByTestId("co-batch-0-name").fill("花生酱A");
  await page.getByTestId("co-batch-0-contains-peanut").check();
  await page.getByTestId("co-batch-0-contains-wheat").check();
  await page.getByTestId("co-batch-1-name").fill("清洁后B");
  await page.getByTestId("co-submit").click();

  // 未清洁：第 2 批有带入
  await expect(page.getByTestId("co-batch-1-incoming-peanut")).toBeVisible();

  // 勾选“已完成经验证清洁”后重新推演：第 2 批全部清空
  await page.getByTestId("co-boundary-0-cleaned").check();
  await page.getByTestId("co-submit").click();
  await expect(page.getByTestId("co-batch-1-cleaned")).toBeVisible();
  await expect(page.getByTestId("co-batch-1-incoming")).toContainText("无");
  await expect(page.getByTestId("co-batch-1-carried")).toContainText("无");
  await expect(page.getByTestId("co-batch-1-outgoing")).toContainText("无");
  // 清洁不影响第 1 批自身的离开残留
  await expect(page.getByTestId("co-batch-0-outgoing-peanut")).toBeVisible();
  await expect(page.getByTestId("co-batch-0-outgoing-wheat")).toBeVisible();

  // 清洁边界后再引入牛奶：第 3 批只看到第 2 批的牛奶，看不到 A 的花生/小麦
  await page.getByTestId("co-add-batch").click();
  await page.getByTestId("co-batch-2-name").fill("牛奶糖C");
  await page.getByTestId("co-batch-2-contains-milk").check();
  await page.getByTestId("co-submit").click();
  await expect(page.getByTestId("co-batch-2-incoming")).toContainText("无");
  await expect(page.getByTestId("co-batch-2-outgoing-milk")).toContainText("牛奶糖C");
  await page.getByTestId("co-add-batch").click();
  await page.getByTestId("co-batch-3-name").fill("末批D");
  await page.getByTestId("co-submit").click();
  await expect(page.getByTestId("co-batch-3-incoming-milk")).toContainText(
    "来源：第 3 批「牛奶糖C」",
  );
  await expect(page.getByTestId("co-batch-3")).not.toContainText("花生酱A");
});

test("调整顺序后重新推演：上移/下移改变带入方向", async ({ page }) => {
  await page.getByTestId("co-batch-0-name").fill("花生酱A");
  await page.getByTestId("co-batch-0-contains-peanut").check();
  await page.getByTestId("co-batch-1-name").fill("燕麦B");
  await page.getByTestId("co-submit").click();
  await expect(page.getByTestId("co-batch-1-incoming-peanut")).toBeVisible();

  // 把干净的燕麦B 上移到第 1 位（花生酱A 变成第 2 批）
  await page.getByTestId("co-batch-1-up").click();
  await expect(page.getByTestId("co-batch-0-name")).toHaveValue("燕麦B");
  await expect(page.getByTestId("co-result")).toHaveCount(0);

  await page.getByTestId("co-submit").click();
  // 新首批是干净批次，无进入/离开残留；花生成为第 2 批自己的直接成分
  await expect(page.getByTestId("co-batch-0-outgoing")).toContainText("无");
  await expect(page.getByTestId("co-batch-1-direct")).toContainText("花生");
  await expect(page.getByTestId("co-batch-1-carried")).toContainText("无");
});

test("字段错误保留输入就地提示：空白名称修正后可再次提交", async ({ page }) => {
  await page.getByTestId("co-batch-0-name").fill("花生酱A");
  await page.getByTestId("co-batch-0-contains-peanut").check();
  // 第 2 批名称留空提交
  await page.getByTestId("co-submit").click();

  await expect(page.getByTestId("co-field-error-0")).toContainText("第 2 批批次名称");
  await expect(page.getByTestId("co-result")).toHaveCount(0);
  // 输入保留
  await expect(page.getByTestId("co-batch-0-name")).toHaveValue("花生酱A");
  await expect(page.getByTestId("co-batch-0-contains-peanut")).toBeChecked();

  // 修正后再次提交成功
  await page.getByTestId("co-batch-1-name").fill("燕麦B");
  await page.getByTestId("co-submit").click();
  await expect(page.getByTestId("co-result")).toBeVisible();
  await expect(page.getByTestId("co-batch-1-carried-peanut")).toContainText("花生酱A");
});

test("后端契约：422 定位到具体批次或边界且不产生结果", async ({ request }) => {
  // 批次数量不足
  const tooFew = await request.post("/api/changeover", {
    data: { batches: [batch("A")], boundaries: [] },
  });
  expect(tooFew.status()).toBe(422);
  const tooFewBody = await tooFew.json();
  expect(tooFewBody.detail.map((e: { loc: (string | number)[] }) => e.loc)).toEqual(
    expect.arrayContaining([["body", "batches"]]),
  );
  expect(tooFewBody.batches).toBeUndefined();

  // 重名：定位到第 2 批 name
  const duplicate = await request.post("/api/changeover", {
    data: {
      batches: [batch("同名"), batch("同名")],
      boundaries: [{ cleaned: false }],
    },
  });
  expect(duplicate.status()).toBe(422);
  const dupBody = await duplicate.json();
  expect(
    dupBody.detail.some(
      (e: { loc: (string | number)[] }) =>
        JSON.stringify(e.loc) === JSON.stringify(["body", "batches", 1, "name"]),
    ),
  ).toBeTruthy();

  // 边界数量缺失：只给批次不给 boundaries
  const missingBoundaries = await request.post("/api/changeover", {
    data: { batches: [batch("A"), batch("B")] },
  });
  expect(missingBoundaries.status()).toBe(422);
  const missingBody = await missingBoundaries.json();
  expect(missingBody.detail.map((e: { loc: (string | number)[] }) => e.loc)).toEqual(
    expect.arrayContaining([["body", "boundaries"]]),
  );

  // 成分标记非布尔：定位到具体批次的具体字段
  const nonBoolean = await request.post("/api/changeover", {
    data: {
      batches: [batch("A"), batch("B", { contains_milk: "yes" })],
      boundaries: [{ cleaned: false }],
    },
  });
  expect(nonBoolean.status()).toBe(422);
  const nonBoolBody = await nonBoolean.json();
  expect(
    nonBoolBody.detail.some(
      (e: { loc: (string | number)[] }) =>
        JSON.stringify(e.loc) === JSON.stringify(["body", "batches", 1, "contains_milk"]),
    ),
  ).toBeTruthy();
});

test("换线模块与放行台并排共存：裁决/比较接口与页面状态保持兼容", async ({ page }) => {
  // 放行台仍可独立完成裁决，换线模块同时存在且互不干扰
  await page.getByTestId("row-0-name").fill("白砂糖");
  await page.getByTestId("claim-milk_free").check();
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("verdict-banner")).toHaveText("可印刷");

  // 换线模块独立存在并可独立推演
  await expect(page.getByTestId("changeover-panel")).toBeVisible();
  await page.getByTestId("co-batch-0-name").fill("A批");
  await page.getByTestId("co-batch-0-contains-peanut").check();
  await page.getByTestId("co-batch-1-name").fill("B批");
  await page.getByTestId("co-submit").click();
  await expect(page.getByTestId("co-batch-1-incoming-peanut")).toBeVisible();

  // 放行台裁决结果仍保留在页面上
  await expect(page.getByTestId("verdict-banner")).toHaveText("可印刷");
});
