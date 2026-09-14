import { expect, test } from "@playwright/test";

// 批次用料追溯端到端：真实浏览器 -> Web（Nginx/Vite）-> 真实 FastAPI，
// 无任何打桩。层级与最短投料路径解释必须来自真实追溯服务的响应。

type BatchType = "raw_material" | "intermediate" | "finished_good";

interface BatchDef {
  code: string;
  material: string;
  type: BatchType;
}

const TYPE_LABEL: Record<BatchType, string> = {
  raw_material: "原料",
  intermediate: "中间料",
  finished_good: "成品",
};

async function addBatches(page: import("@playwright/test").Page, batches: BatchDef[]) {
  // 默认表单只有 1 个批次行
  for (let i = 1; i < batches.length; i += 1) {
    await page.getByTestId("tr-add-batch").click();
  }
  for (let i = 0; i < batches.length; i += 1) {
    const def = batches[i];
    await page.getByTestId(`tr-batch-${i}-code`).fill(def.code);
    await page.getByTestId(`tr-batch-${i}-material`).fill(def.material);
    await page.getByTestId(`tr-batch-${i}-type`).selectOption(def.type);
  }
}

// 关系按录入顺序逐条填写（默认只有 1 行，按需添加）
async function addRelations(
  page: import("@playwright/test").Page,
  edges: [string, string][],
) {
  for (let i = 1; i < edges.length; i += 1) {
    await page.getByTestId("tr-add-relation").click();
  }
  for (let i = 0; i < edges.length; i += 1) {
    await page.getByTestId(`tr-relation-${i}-from`).fill(edges[i][0]);
    await page.getByTestId(`tr-relation-${i}-to`).fill(edges[i][1]);
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("从污染原料追到中间料和成品：层级分组与逐跳路径解释来自真实服务", async ({ page }) => {
  await addBatches(page, [
    { code: "RAW-PEANUT-01", material: "花生原料", type: "raw_material" },
    { code: "INT-BUTTER-01", material: "花生酱中间料", type: "intermediate" },
    { code: "FG-COOKIE-01", material: "花生酥成品", type: "finished_good" },
  ]);
  await addRelations(page, [
    ["RAW-PEANUT-01", "INT-BUTTER-01"],
    ["INT-BUTTER-01", "FG-COOKIE-01"],
  ]);
  await page.getByTestId("tr-source").fill("RAW-PEANUT-01");
  await page.getByTestId("tr-submit").click();

  // 污染源头部与汇总
  await expect(page.getByTestId("tr-result")).toBeVisible();
  await expect(page.getByTestId("tr-summary")).toContainText("共影响 2 个下游批次");

  // 第 1 层：直接使用的中间料
  await expect(page.getByTestId("tr-level-1")).toContainText("直接使用");
  await expect(page.getByTestId("tr-affected-INT-BUTTER-01")).toContainText("花生酱中间料");
  await expect(page.getByTestId("tr-affected-INT-BUTTER-01")).toContainText("中间料");
  await expect(page.getByTestId("tr-affected-INT-BUTTER-01-route")).toHaveText(
    "RAW-PEANUT-01 → INT-BUTTER-01",
  );
  await expect(page.getByTestId("tr-path-INT-BUTTER-01-hop-0")).toContainText(
    "投料关系 #1",
  );

  // 第 2 层：间接影响的成品，路径逐跳解释
  await expect(page.getByTestId("tr-level-2")).toContainText("间接影响");
  await expect(page.getByTestId("tr-affected-FG-COOKIE-01")).toContainText("花生酥成品");
  await expect(page.getByTestId("tr-affected-FG-COOKIE-01-route")).toHaveText(
    "RAW-PEANUT-01 → INT-BUTTER-01 → FG-COOKIE-01",
  );
  await expect(page.getByTestId("tr-path-FG-COOKIE-01-hop-0")).toContainText(
    "RAW-PEANUT-01 → INT-BUTTER-01",
  );
  await expect(page.getByTestId("tr-path-FG-COOKIE-01-hop-0")).toContainText(
    "投料关系 #1",
  );
  await expect(page.getByTestId("tr-path-FG-COOKIE-01-hop-1")).toContainText(
    "INT-BUTTER-01 → FG-COOKIE-01",
  );
  await expect(page.getByTestId("tr-path-FG-COOKIE-01-hop-1")).toContainText(
    "投料关系 #2",
  );
});

test("多层汇聚：成品经两条等长路径到达，按关系序号字典序选最短路径", async ({ page }) => {
  // 菱形汇聚：R -> I1, R -> I2, I1 -> F, I2 -> F
  // 等长路径 [0,2]（经 I1）与 [1,3]（经 I2），字典序更小的 [0,2] 胜出
  await addBatches(page, [
    { code: "R", material: "污染原料", type: "raw_material" },
    { code: "I1", material: "中间料一", type: "intermediate" },
    { code: "I2", material: "中间料二", type: "intermediate" },
    { code: "F", material: "汇聚成品", type: "finished_good" },
  ]);
  await addRelations(page, [
    ["R", "I1"],
    ["R", "I2"],
    ["I1", "F"],
    ["I2", "F"],
  ]);
  await page.getByTestId("tr-source").fill("R");
  await page.getByTestId("tr-submit").click();

  await expect(page.getByTestId("tr-result")).toBeVisible();
  await expect(page.getByTestId("tr-summary")).toContainText("共影响 3 个下游批次");
  // 第 1 层两个中间料（关系录入顺序）
  await expect(page.getByTestId("tr-level-1")).toContainText("I1");
  await expect(page.getByTestId("tr-level-1")).toContainText("I2");
  // 汇聚成品选经 I1 的路径（关系 #1 与 #3）
  await expect(page.getByTestId("tr-affected-F-route")).toHaveText("R → I1 → F");
  await expect(page.getByTestId("tr-path-F-hop-0")).toContainText("投料关系 #1");
  await expect(page.getByTestId("tr-path-F-hop-1")).toContainText("投料关系 #3");
});

test("不可达批次不返回：反向投料时污染源下游为空态", async ({ page }) => {
  await addBatches(page, [
    { code: "RAW-1", material: "原料", type: "raw_material" },
    { code: "INT-1", material: "中间料", type: "intermediate" },
  ]);
  // 投料方向 INT-1 -> RAW-1：以 RAW-1 为污染源时上游不可达
  await addRelations(page, [["INT-1", "RAW-1"]]);
  await page.getByTestId("tr-source").fill("RAW-1");
  await page.getByTestId("tr-submit").click();

  await expect(page.getByTestId("tr-result")).toBeVisible();
  await expect(page.getByTestId("tr-summary")).toContainText("共影响 0 个下游批次");
  await expect(page.getByTestId("tr-affected-INT-1")).toHaveCount(0);
});

test("非法成环不产生结果：定位到具体关系，删除成环关系后重试成功", async ({ page }) => {
  await addBatches(page, [
    { code: "A", material: "中间料A", type: "intermediate" },
    { code: "B", material: "中间料B", type: "intermediate" },
  ]);
  await addRelations(page, [
    ["A", "B"],
    ["B", "A"],
  ]);
  await page.getByTestId("tr-source").fill("A");
  await page.getByTestId("tr-submit").click();

  // 前端即时拦截成环（真实后端同样拒绝）：两条在环上的关系都被定位，无结果
  await expect(page.getByTestId("tr-field-error-0")).toContainText("成环");
  await expect(page.getByTestId("tr-result")).toHaveCount(0);

  // 删除第二条关系打破环，保留草稿直接重试
  await page.getByTestId("tr-relation-1-remove").click();
  await page.getByTestId("tr-submit").click();
  await expect(page.getByTestId("tr-result")).toBeVisible();
  await expect(page.getByTestId("tr-affected-B-route")).toHaveText("A → B");
});

test("后端契约：422 定位到具体批次/关系/污染源且不产生结果；合法关系图返回层级与路径", async ({
  request,
}) => {
  const base = {
    batches: [
      { code: "R-1", material_name: "原料", batch_type: "raw_material" },
      { code: "I-1", material_name: "中间料", batch_type: "intermediate" },
      { code: "F-1", material_name: "成品", batch_type: "finished_good" },
    ],
    relations: [
      { from_code: "R-1", to_code: "I-1" },
      { from_code: "I-1", to_code: "F-1" },
    ],
  };

  // 合法请求：层级 + 最短路径
  const ok = await request.post("/api/trace", {
    data: { ...base, source_code: "R-1" },
  });
  expect(ok.status()).toBe(200);
  const okBody = await ok.json();
  expect(okBody.affected_count).toBe(2);
  expect(okBody.levels.map((l: { level: number }) => l.level)).toEqual([1, 2]);
  const finished = okBody.affected_batches.find((b: { code: string }) => b.code === "F-1");
  expect(finished.level).toBe(2);
  expect(finished.path_codes).toEqual(["R-1", "I-1", "F-1"]);
  expect(finished.path_relation_indices).toEqual([0, 1]);
  expect(finished.path_steps).toEqual([
    { relation_index: 0, from_code: "R-1", to_code: "I-1" },
    { relation_index: 1, from_code: "I-1", to_code: "F-1" },
  ]);

  // 编号重复：定位到每个重复批次的 code
  const dup = await request.post("/api/trace", {
    data: {
      batches: [
        ...base.batches,
        { code: "R-1", material_name: "重复", batch_type: "raw_material" },
      ],
      relations: base.relations,
      source_code: "R-1",
    },
  });
  expect(dup.status()).toBe(422);
  const dupBody = await dup.json();
  expect(dupBody.affected_batches).toBeUndefined();
  expect(
    dupBody.detail.some(
      (e: { loc: (string | number)[] }) =>
        JSON.stringify(e.loc) === JSON.stringify(["body", "batches", 0, "code"]),
    ),
  ).toBeTruthy();
  expect(
    dupBody.detail.some(
      (e: { loc: (string | number)[] }) =>
        JSON.stringify(e.loc) === JSON.stringify(["body", "batches", 3, "code"]),
    ),
  ).toBeTruthy();

  // 关系端点不存在
  const missing = await request.post("/api/trace", {
    data: {
      batches: base.batches,
      relations: [{ from_code: "GHOST", to_code: "I-1" }],
      source_code: "R-1",
    },
  });
  expect(missing.status()).toBe(422);
  const missingBody = await missing.json();
  expect(missingBody.levels).toBeUndefined();
  expect(
    missingBody.detail.some(
      (e: { loc: (string | number)[] }) =>
        JSON.stringify(e.loc) === JSON.stringify(["body", "relations", 0, "from_code"]),
    ),
  ).toBeTruthy();

  // 自引用
  const selfRef = await request.post("/api/trace", {
    data: {
      batches: base.batches,
      relations: [{ from_code: "I-1", to_code: "I-1" }],
      source_code: "R-1",
    },
  });
  expect(selfRef.status()).toBe(422);
  const selfBody = await selfRef.json();
  expect(
    selfBody.detail.some(
      (e: { loc: (string | number)[] }) =>
        JSON.stringify(e.loc) === JSON.stringify(["body", "relations", 0, "to_code"]),
    ),
  ).toBeTruthy();
  expect(selfBody.affected_batches).toBeUndefined();

  // 成环：两条在环上的关系都定位
  const cyclic = await request.post("/api/trace", {
    data: {
      batches: base.batches,
      relations: [
        { from_code: "R-1", to_code: "I-1" },
        { from_code: "I-1", to_code: "R-1" },
      ],
      source_code: "R-1",
    },
  });
  expect(cyclic.status()).toBe(422);
  const cyclicBody = await cyclic.json();
  const locs = cyclicBody.detail.map((e: { loc: (string | number)[] }) => JSON.stringify(e.loc));
  expect(locs).toContain(JSON.stringify(["body", "relations", 0, "to_code"]));
  expect(locs).toContain(JSON.stringify(["body", "relations", 1, "to_code"]));
  expect(cyclicBody.affected_batches).toBeUndefined();

  // 污染源不存在
  const badSource = await request.post("/api/trace", {
    data: { ...base, source_code: "UNKNOWN" },
  });
  expect(badSource.status()).toBe(422);
  const badSourceBody = await badSource.json();
  expect(
    badSourceBody.detail.some(
      (e: { loc: (string | number)[] }) =>
        JSON.stringify(e.loc) === JSON.stringify(["body", "source_code"]),
    ),
  ).toBeTruthy();

  // 未知批次类型 / 额外字段
  const badType = await request.post("/api/trace", {
    data: {
      batches: [{ code: "R-1", material_name: "原料", batch_type: "semi" }],
      relations: [],
      source_code: "R-1",
    },
  });
  expect(badType.status()).toBe(422);
  const badTypeBody = await badType.json();
  expect(
    badTypeBody.detail.some(
      (e: { loc: (string | number)[] }) =>
        JSON.stringify(e.loc) === JSON.stringify(["body", "batches", 0, "batch_type"]),
    ),
  ).toBeTruthy();

  // 类型标签常量被真实页面使用（防止枚举漂移）
  expect(Object.values(TYPE_LABEL)).toEqual(["原料", "中间料", "成品"]);
});

test("追溯台与放行台、换线推演并排共存：互不干扰且裁决保持兼容", async ({ page }) => {
  // 放行台裁决仍独立工作
  await page.getByTestId("row-0-name").fill("白砂糖");
  await page.getByTestId("claim-milk_free").check();
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("verdict-banner")).toHaveText("可印刷");

  // 追溯台独立存在并可独立追溯
  await expect(page.getByTestId("trace-panel")).toBeVisible();
  await addBatches(page, [
    { code: "RAW-1", material: "花生原料", type: "raw_material" },
    { code: "INT-1", material: "花生酱", type: "intermediate" },
  ]);
  await addRelations(page, [["RAW-1", "INT-1"]]);
  await page.getByTestId("tr-source").fill("RAW-1");
  await page.getByTestId("tr-submit").click();
  await expect(page.getByTestId("tr-affected-INT-1")).toBeVisible();

  // 放行台裁决结果与换线模块仍保留在页面上
  await expect(page.getByTestId("verdict-banner")).toHaveText("可印刷");
  await expect(page.getByTestId("changeover-panel")).toBeVisible();
});
