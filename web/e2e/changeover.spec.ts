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

  // 勾选“全部清洁”后重新推演：第 2 批全部清空
  await page.getByTestId("co-boundary-0-mode-full").check();
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

test("局部清洁：仅验证清除花生，牛奶保留最近来源继续带入后续批次", async ({ page }) => {
  // 第 1 批同时含牛奶与花生；A/B 之间仅完成针对花生的验证清洁
  await page.getByTestId("co-batch-0-name").fill("奶糖A");
  await page.getByTestId("co-batch-0-contains-milk").check();
  await page.getByTestId("co-batch-0-contains-peanut").check();
  await page.getByTestId("co-batch-1-name").fill("中转B");
  await page.getByTestId("co-add-batch").click();
  await page.getByTestId("co-batch-2-name").fill("末批C");

  // 选择局部清洁并只勾选花生（牛奶保持未清除）
  await page.getByTestId("co-boundary-0-mode-partial").check();
  await page.getByTestId("co-boundary-0-target-peanut").check();
  await page.getByTestId("co-submit").click();

  // 第 2 批：进入残留/带入物只有牛奶，花生不再显示；不出现全部清洁徽标
  await expect(page.getByTestId("co-batch-1-incoming-milk")).toContainText(
    "来源：第 1 批「奶糖A」",
  );
  await expect(page.getByTestId("co-batch-1-carried-milk")).toBeVisible();
  await expect(page.getByTestId("co-batch-1-incoming-peanut")).toHaveCount(0);
  await expect(page.getByTestId("co-batch-1")).not.toContainText("本批开始前已完成经验证的全部清洁");
  // 第 2 批离开残留也只有牛奶
  await expect(page.getByTestId("co-batch-1-outgoing-milk")).toBeVisible();
  await expect(page.getByTestId("co-batch-1-outgoing-peanut")).toHaveCount(0);

  // 第 3 批：牛奶继续携带最近来源，花生始终不再出现
  await expect(page.getByTestId("co-batch-2-incoming-milk")).toContainText(
    "来源：第 1 批「奶糖A」",
  );
  await expect(page.getByTestId("co-batch-2")).not.toContainText("花生");

  // 边界结果确认实际清除项：仅花生；第二条未清洁边界无确认清除项
  await expect(page.getByTestId("co-boundary-report-0")).toContainText("局部清洁");
  await expect(page.getByTestId("co-boundary-report-0-target-peanut")).toBeVisible();
  await expect(page.getByTestId("co-boundary-report-0-target-milk")).toHaveCount(0);
  await expect(page.getByTestId("co-boundary-report-1-targets")).toContainText("无确认清除项");
});

test("局部清洁失败重试：后端 422 后保留批次与清洁选择，修正为全部清洁后归零", async ({ page }) => {
  await page.getByTestId("co-batch-0-name").fill("奶糖A");
  await page.getByTestId("co-batch-0-contains-milk").check();
  await page.getByTestId("co-batch-0-contains-peanut").check();
  await page.getByTestId("co-batch-1-name").fill("中转B");
  await page.getByTestId("co-boundary-0-mode-partial").check();
  await page.getByTestId("co-boundary-0-target-peanut").check();

  // 拦截第一次提交，返回“全部清洁与清除目标冲突”的 422（页面选择保持不变）；
  // 第二次提交放行到真实服务
  let attempts = 0;
  await page.route("**/api/changeover", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({
          detail: [
            {
              loc: ["body", "boundaries", 0, "cleared_targets"],
              msg: "清除目标与全部清洁标记冲突：cleaned=true 表示清空全部残留，不应再指定局部清除目标",
              type: "value_error",
            },
          ],
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.getByTestId("co-submit").click();
  await expect(page.getByTestId("co-field-error-0")).toContainText("冲突");
  await expect(page.getByTestId("co-result")).toHaveCount(0);
  // 批次与清洁选择保留
  await expect(page.getByTestId("co-batch-0-name")).toHaveValue("奶糖A");
  await expect(page.getByTestId("co-boundary-0-mode-partial")).toBeChecked();
  await expect(page.getByTestId("co-boundary-0-target-peanut")).toBeChecked();

  // 改选全部清洁后再次提交（放行到真实服务），后续批次归零
  await page.getByTestId("co-boundary-0-mode-full").check();
  await page.getByTestId("co-submit").click();
  await expect(page.getByTestId("co-batch-1-cleaned")).toBeVisible();
  await expect(page.getByTestId("co-batch-1-incoming")).toContainText("无");
  await expect(page.getByTestId("co-batch-1-outgoing")).toContainText("无");
  await expect(page.getByTestId("co-field-error-0")).toHaveCount(0);
  await page.unroute("**/api/changeover");
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

  // 局部清洁：仅清除花生，牛奶继续带入；边界结果确认实际清除项
  const partial = await request.post("/api/changeover", {
    data: {
      batches: [
        batch("A", { contains_milk: true, contains_peanut: true }),
        batch("B"),
      ],
      boundaries: [{ cleaned: false, cleared_targets: ["peanut"] }],
    },
  });
  expect(partial.status()).toBe(200);
  const partialBody = await partial.json();
  expect(partialBody.batches[1].incoming_residue).toEqual([
    { target: "milk", source_batch_index: 0, source_batch_name: "A" },
  ]);
  expect(partialBody.boundaries[0]).toEqual({
    boundary_index: 0,
    cleaned: false,
    residue_cleared: false,
    cleared_targets: ["peanut"],
  });

  // 局部清洁非法输入：为空、重复、越界、与全部清洁冲突均 422 且无结果
  for (const badBoundary of [
    { cleaned: false, cleared_targets: [] },
    { cleaned: false, cleared_targets: ["peanut", "peanut"] },
    { cleaned: false, cleared_targets: ["soy"] },
    { cleaned: true, cleared_targets: ["peanut"] },
  ]) {
    const bad = await request.post("/api/changeover", {
      data: {
        batches: [batch("A"), batch("B")],
        boundaries: [badBoundary],
      },
    });
    expect(bad.status()).toBe(422);
    const badBody = await bad.json();
    expect(badBody.batches).toBeUndefined();
    expect(
      badBody.detail.some(
        (e: { loc: (string | number)[] }) =>
          e.loc[0] === "body" && e.loc[1] === "boundaries" && e.loc[2] === 0,
      ),
    ).toBeTruthy();
  }

  // 旧请求（仅 cleaned 布尔）响应兼容：全清归零、不清保留
  const legacyClean = await request.post("/api/changeover", {
    data: {
      batches: [batch("A", { contains_peanut: true }), batch("B")],
      boundaries: [{ cleaned: true }],
    },
  });
  expect(legacyClean.status()).toBe(200);
  const legacyBody = await legacyClean.json();
  expect(legacyBody.batches[1].incoming_residue).toEqual([]);
  expect(legacyBody.boundaries[0].residue_cleared).toBe(true);
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
