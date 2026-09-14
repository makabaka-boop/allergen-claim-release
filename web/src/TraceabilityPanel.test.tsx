import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TraceabilityPanel } from "./components/TraceabilityPanel";
import type {
  TraceRelationInput,
  TraceabilityResponse,
  TracedBatch,
} from "./types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// 与后端一致的稳定 BFS：邻接按关系录入顺序，同层级选关系序号字典序最小路径
function buildTraceResponse(
  batches: { code: string; material_name: string; batch_type: string }[],
  relations: TraceRelationInput[],
  sourceCode: string,
): TraceabilityResponse {
  const byCode = new Map<string, { code: string; material_name: string; batch_type: string }>();
  batches.forEach((batch) => byCode.set(batch.code, batch));
  const adjacency = new Map<string, { to: string; index: number }[]>();
  relations.forEach((relation, index) => {
    const edges = adjacency.get(relation.from_code) ?? [];
    edges.push({ to: relation.to_code, index });
    adjacency.set(relation.from_code, edges);
  });

  const best = new Map<string, { level: number; path: number[] }>();
  const order: string[] = [];
  best.set(sourceCode, { level: 0, path: [] });
  const queue = [sourceCode];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const currentBest = best.get(current) as { level: number; path: number[] };
    for (const edge of adjacency.get(current) ?? []) {
      const candidate = { level: currentBest.level + 1, path: [...currentBest.path, edge.index] };
      const previous = best.get(edge.to);
      if (!previous) {
        best.set(edge.to, candidate);
        order.push(edge.to);
        queue.push(edge.to);
      } else if (
        candidate.level < previous.level ||
        (candidate.level === previous.level &&
          JSON.stringify(candidate.path) < JSON.stringify(previous.path))
      ) {
        best.set(edge.to, candidate);
      }
    }
  }

  const source = byCode.get(sourceCode) as {
    code: string;
    material_name: string;
    batch_type: string;
  };
  const toReport = (code: string): TracedBatch => {
    const found = best.get(code) as { level: number; path: number[] };
    const batch = byCode.get(code) as {
      code: string;
      material_name: string;
      batch_type: string;
    };
    const pathCodes = [sourceCode];
    let cursor = sourceCode;
    const steps = found.path.map((relationIndex) => {
      const relation = relations[relationIndex];
      cursor = relation.to_code;
      pathCodes.push(cursor);
      return {
        relation_index: relationIndex,
        from_code: relation.from_code,
        to_code: relation.to_code,
      };
    });
    return {
      code,
      material_name: batch.material_name,
      batch_type: batch.batch_type as TracedBatch["batch_type"],
      level: found.level,
      path_codes: pathCodes,
      path_relation_indices: found.path,
      path_steps: steps,
    };
  };

  const affected = order
    .filter((code) => (best.get(code) as { level: number }).level > 0)
    .map(toReport);
  const levels = [...new Set(affected.map((batch) => batch.level))].map((level) => ({
    level,
    batches: affected.filter((batch) => batch.level === level),
  }));
  return {
    source_code: source.code,
    source_material_name: source.material_name,
    source_batch_type: source.batch_type as TraceabilityResponse["source_batch_type"],
    affected_count: affected.length,
    levels,
    affected_batches: affected,
  };
}

interface RawPayload {
  batches: { code: string; material_name: string; batch_type: string }[];
  relations: { from_code: string; to_code: string }[];
  source_code: string;
}

// 默认按真实追溯语义生成响应的 fetch 打桩，可按用例覆盖（如首次 422）
function mockTrace(override?: (payload: RawPayload) => Response) {
  const calls: RawPayload[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    expect(url).toBe("/api/trace");
    const payload = JSON.parse(String(init?.body)) as RawPayload;
    calls.push(payload);
    if (override) return override(payload);
    return jsonResponse(
      buildTraceResponse(payload.batches, payload.relations, payload.source_code),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

async function fillBatch(
  user: ReturnType<typeof userEvent.setup>,
  index: number,
  code: string,
  material: string,
  type: "raw_material" | "intermediate" | "finished_good",
) {
  await user.clear(screen.getByTestId(`tr-batch-${index}-code`));
  await user.type(screen.getByTestId(`tr-batch-${index}-code`), code);
  await user.clear(screen.getByTestId(`tr-batch-${index}-material`));
  await user.type(screen.getByTestId(`tr-batch-${index}-material`), material);
  await user.selectOptions(screen.getByTestId(`tr-batch-${index}-type`), type);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("批次用料追溯：层级与最短投料路径", () => {
  it("原料污染源经中间料追到成品：按层级展示并还原路径解释", async () => {
    const { calls } = mockTrace();
    const user = userEvent.setup();
    render(<TraceabilityPanel />);

    // 默认 1 个批次、1 条关系；扩展为 3 个批次、2 条关系
    await user.click(screen.getByTestId("tr-add-batch"));
    await user.click(screen.getByTestId("tr-add-batch"));
    await user.click(screen.getByTestId("tr-add-relation"));

    await fillBatch(user, 0, "RAW-1", "花生原料", "raw_material");
    await fillBatch(user, 1, "INT-1", "花生酱中间料", "intermediate");
    await fillBatch(user, 2, "FG-1", "花生酥成品", "finished_good");

    await user.clear(screen.getByTestId("tr-relation-0-from"));
    await user.type(screen.getByTestId("tr-relation-0-from"), "RAW-1");
    await user.clear(screen.getByTestId("tr-relation-0-to"));
    await user.type(screen.getByTestId("tr-relation-0-to"), "INT-1");
    await user.clear(screen.getByTestId("tr-relation-1-from"));
    await user.type(screen.getByTestId("tr-relation-1-from"), "INT-1");
    await user.clear(screen.getByTestId("tr-relation-1-to"));
    await user.type(screen.getByTestId("tr-relation-1-to"), "FG-1");

    await user.type(screen.getByTestId("tr-source"), "RAW-1");
    await user.click(screen.getByTestId("tr-submit"));

    await waitFor(() => expect(screen.getByTestId("tr-result")).toBeInTheDocument());
    expect(screen.getByTestId("tr-summary")).toHaveTextContent("共影响 2 个下游批次");

    // 第 1 层：中间料（直接使用）
    expect(screen.getByTestId("tr-level-1")).toHaveTextContent("直接使用");
    expect(screen.getByTestId("tr-affected-INT-1")).toHaveTextContent("花生酱中间料");
    expect(screen.getByTestId("tr-affected-INT-1-route")).toHaveTextContent("RAW-1 → INT-1");
    expect(screen.getByTestId("tr-path-INT-1-hop-0")).toHaveTextContent("RAW-1 → INT-1");
    expect(screen.getByTestId("tr-path-INT-1-hop-0")).toHaveTextContent("投料关系 #1");

    // 第 2 层：成品（间接影响），路径还原为两跳
    expect(screen.getByTestId("tr-level-2")).toHaveTextContent("间接影响");
    expect(screen.getByTestId("tr-affected-FG-1-route")).toHaveTextContent(
      "RAW-1 → INT-1 → FG-1",
    );
    expect(screen.getByTestId("tr-path-FG-1-hop-0")).toHaveTextContent("投料关系 #1");
    expect(screen.getByTestId("tr-path-FG-1-hop-1")).toHaveTextContent("投料关系 #2");

    // 真实请求体：trim 后的编号与完整关系图
    const payload = calls[0];
    expect(payload.batches.map((batch) => batch.code)).toEqual(["RAW-1", "INT-1", "FG-1"]);
    expect(payload.relations).toEqual([
      { from_code: "RAW-1", to_code: "INT-1" },
      { from_code: "INT-1", to_code: "FG-1" },
    ]);
    expect(payload.source_code).toBe("RAW-1");
  });

  it("多层汇聚：同一成品经两条等长路径到达，按关系序号字典序取最短路径", async () => {
    mockTrace();
    const user = userEvent.setup();
    render(<TraceabilityPanel />);

    // 菱形：R -> I1, R -> I2, I1 -> F, I2 -> F（4 批次 4 关系）
    for (let i = 0; i < 3; i += 1) await user.click(screen.getByTestId("tr-add-batch"));
    for (let i = 0; i < 3; i += 1) await user.click(screen.getByTestId("tr-add-relation"));

    await fillBatch(user, 0, "R", "污染原料", "raw_material");
    await fillBatch(user, 1, "I1", "中间料一", "intermediate");
    await fillBatch(user, 2, "I2", "中间料二", "intermediate");
    await fillBatch(user, 3, "F", "成品", "finished_good");

    const edges: [string, string][] = [
      ["R", "I1"],
      ["R", "I2"],
      ["I1", "F"],
      ["I2", "F"],
    ];
    for (let i = 0; i < edges.length; i += 1) {
      await user.clear(screen.getByTestId(`tr-relation-${i}-from`));
      await user.type(screen.getByTestId(`tr-relation-${i}-from`), edges[i][0]);
      await user.clear(screen.getByTestId(`tr-relation-${i}-to`));
      await user.type(screen.getByTestId(`tr-relation-${i}-to`), edges[i][1]);
    }
    await user.type(screen.getByTestId("tr-source"), "R");
    await user.click(screen.getByTestId("tr-submit"));

    await waitFor(() => expect(screen.getByTestId("tr-result")).toBeInTheDocument());
    // 汇聚点 F 等长两路径 [0,2] 与 [1,3]，字典序更小的 [0,2]（经 I1）胜出
    expect(screen.getByTestId("tr-affected-F-route")).toHaveTextContent("R → I1 → F");
    expect(screen.getByTestId("tr-level-2")).toBeInTheDocument();
    expect(screen.getByTestId("tr-level-1")).toHaveTextContent("I1");
    expect(screen.getByTestId("tr-level-1")).toHaveTextContent("I2");
  });

  it("不可达批次不返回：与污染源无关的中间料不出现，空影响给出空态", async () => {
    mockTrace();
    const user = userEvent.setup();
    render(<TraceabilityPanel />);

    await user.click(screen.getByTestId("tr-add-batch"));
    await fillBatch(user, 0, "R", "原料", "raw_material");
    await fillBatch(user, 1, "I", "中间料", "intermediate");
    // 唯一一条关系的来源/目标都是 R（自引用会被前端拦截），改成合法但无下游：
    // 关系填成 I -> R 时，以 R 为污染源不可达 I
    await user.clear(screen.getByTestId("tr-relation-0-from"));
    await user.type(screen.getByTestId("tr-relation-0-from"), "I");
    await user.clear(screen.getByTestId("tr-relation-0-to"));
    await user.type(screen.getByTestId("tr-relation-0-to"), "R");
    await user.type(screen.getByTestId("tr-source"), "R");
    await user.click(screen.getByTestId("tr-submit"));

    await waitFor(() => expect(screen.getByTestId("tr-result")).toBeInTheDocument());
    expect(screen.getByTestId("tr-summary")).toHaveTextContent("共影响 0 个下游批次");
    expect(screen.queryByTestId("tr-affected-I")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tr-level-1")).not.toBeInTheDocument();
  });
});

describe("批次用料追溯：修正失败输入后重试", () => {
  it("前端校验失败（缺失端点）不发请求，草稿保留；补齐端点后追溯成功", async () => {
    const { calls, fetchMock } = mockTrace();
    const user = userEvent.setup();
    render(<TraceabilityPanel />);

    await fillBatch(user, 0, "RAW-1", "花生原料", "raw_material");
    // 关系来源误填为台账中不存在的编号
    await user.type(screen.getByTestId("tr-relation-0-from"), "RAW-9");
    await user.type(screen.getByTestId("tr-relation-0-to"), "RAW-1");
    await user.type(screen.getByTestId("tr-source"), "RAW-1");
    await user.click(screen.getByTestId("tr-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("tr-field-error-0")).toHaveTextContent("第 1 条投料关系的来源批次"),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("tr-result")).not.toBeInTheDocument();
    // 草稿保留
    expect(screen.getByTestId("tr-relation-0-from")).toHaveValue("RAW-9");
    expect(screen.getByTestId("tr-batch-0-code")).toHaveValue("RAW-1");

    // 新增中间料批次并把关系修正为 RAW-1 -> INT-1
    await user.click(screen.getByTestId("tr-add-batch"));
    await fillBatch(user, 1, "INT-1", "中间料", "intermediate");
    await user.clear(screen.getByTestId("tr-relation-0-from"));
    await user.type(screen.getByTestId("tr-relation-0-from"), "RAW-1");
    await user.clear(screen.getByTestId("tr-relation-0-to"));
    await user.type(screen.getByTestId("tr-relation-0-to"), "INT-1");
    await user.click(screen.getByTestId("tr-submit"));

    await waitFor(() => expect(screen.getByTestId("tr-result")).toBeInTheDocument());
    expect(screen.queryByTestId("tr-field-error-0")).not.toBeInTheDocument();
    expect(screen.getByTestId("tr-affected-INT-1")).toBeInTheDocument();
    expect(calls).toHaveLength(1);
  });

  it("非法成环被前端拦截并定位到关系；删除成环关系后重试成功", async () => {
    const { calls, fetchMock } = mockTrace();
    const user = userEvent.setup();
    render(<TraceabilityPanel />);

    await user.click(screen.getByTestId("tr-add-batch"));
    await fillBatch(user, 0, "A", "中间料A", "intermediate");
    await fillBatch(user, 1, "B", "中间料B", "intermediate");
    await user.click(screen.getByTestId("tr-add-relation"));
    await user.type(screen.getByTestId("tr-relation-0-from"), "A");
    await user.type(screen.getByTestId("tr-relation-0-to"), "B");
    await user.type(screen.getByTestId("tr-relation-1-from"), "B");
    await user.type(screen.getByTestId("tr-relation-1-to"), "A");
    await user.type(screen.getByTestId("tr-source"), "A");
    await user.click(screen.getByTestId("tr-submit"));

    // 两条在环上的关系都被定位
    await waitFor(() =>
      expect(screen.getByTestId("tr-field-error-0")).toHaveTextContent("第 1 条投料关系的目标批次"),
    );
    expect(screen.getByTestId("tr-field-error-0")).toHaveTextContent("成环");
    expect(screen.getByTestId("tr-field-error-1")).toHaveTextContent("成环");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("tr-result")).not.toBeInTheDocument();

    // 删除第二条关系打破环后重试
    await user.click(screen.getByTestId("tr-relation-1-remove"));
    await user.click(screen.getByTestId("tr-submit"));
    await waitFor(() => expect(screen.getByTestId("tr-result")).toBeInTheDocument());
    expect(screen.getByTestId("tr-affected-B")).toBeInTheDocument();
    expect(calls).toHaveLength(1);
  });

  it("自引用、未选类型与未知污染源：分别定位，修正后同一草稿重试成功", async () => {
    const { calls, fetchMock } = mockTrace();
    const user = userEvent.setup();
    render(<TraceabilityPanel />);

    // 批次 X 存在但类型未选；关系两端同为 X（自引用）；污染源未知
    await user.type(screen.getByTestId("tr-batch-0-code"), "X");
    await user.type(screen.getByTestId("tr-batch-0-material"), "花生原料");
    await user.type(screen.getByTestId("tr-relation-0-from"), "X");
    await user.type(screen.getByTestId("tr-relation-0-to"), "X");
    await user.type(screen.getByTestId("tr-source"), "SRC");
    await user.click(screen.getByTestId("tr-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("tr-field-error-0")).toHaveTextContent("第 1 个批次类型"),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    const errorText = document.body.textContent ?? "";
    expect(errorText).toContain("关系自引用");
    expect(errorText).toContain("污染源批次编号「SRC」在批次台账中不存在");

    // 全部修正后在同一草稿上重试
    await user.selectOptions(screen.getByTestId("tr-batch-0-type"), "raw_material");
    await user.click(screen.getByTestId("tr-add-batch"));
    await fillBatch(user, 1, "Y", "中间料", "intermediate");
    await user.clear(screen.getByTestId("tr-relation-0-to"));
    await user.type(screen.getByTestId("tr-relation-0-to"), "Y");
    await user.clear(screen.getByTestId("tr-source"));
    await user.type(screen.getByTestId("tr-source"), "X");
    await user.click(screen.getByTestId("tr-submit"));

    await waitFor(() => expect(screen.getByTestId("tr-result")).toBeInTheDocument());
    expect(screen.getByTestId("tr-affected-Y-route")).toHaveTextContent("X → Y");
    expect(calls).toHaveLength(1);
  });

  it("后端 422（端点引用缺失）：保留完整草稿与字段提示，直接重试成功", async () => {
    let attempts = 0;
    const { calls } = mockTrace((payload) => {
      attempts += 1;
      if (attempts === 1) {
        // 前端校验通过的无环单边，后端独立判定目标端台账缺失（如两侧台账尚未同步）
        return jsonResponse({
          detail: [
            {
              loc: ["body", "relations", 0, "to_code"],
              msg: "关系的目标批次编号「INT-2」在批次台账中不存在：投料关系两端必须都已录入。",
              type: "value_error",
            },
          ],
        }, 422);
      }
      return jsonResponse(
        buildTraceResponse(payload.batches, payload.relations, payload.source_code),
      );
    });
    const user = userEvent.setup();
    render(<TraceabilityPanel />);

    await fillBatch(user, 0, "RAW-1", "花生原料", "raw_material");
    await user.click(screen.getByTestId("tr-add-batch"));
    await fillBatch(user, 1, "INT-2", "中间料", "intermediate");
    await user.type(screen.getByTestId("tr-relation-0-from"), "RAW-1");
    await user.type(screen.getByTestId("tr-relation-0-to"), "INT-2");
    await user.type(screen.getByTestId("tr-source"), "RAW-1");
    await user.click(screen.getByTestId("tr-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("tr-field-error-0")).toHaveTextContent(
        "第 1 条投料关系的目标批次",
      ),
    );
    expect(screen.getByTestId("tr-field-error-0")).toHaveTextContent("不存在");
    expect(screen.queryByTestId("tr-result")).not.toBeInTheDocument();
    // 草稿完整保留：批次台账、关系与污染源都还在
    expect(screen.getByTestId("tr-relation-0-to")).toHaveValue("INT-2");
    expect(screen.getByTestId("tr-batch-1-code")).toHaveValue("INT-2");
    expect(screen.getByTestId("tr-source")).toHaveValue("RAW-1");

    // 不改动输入直接重试（第二次打桩走真实语义：RAW-1 -> INT-2）
    await user.click(screen.getByTestId("tr-submit"));
    await waitFor(() => expect(screen.getByTestId("tr-result")).toBeInTheDocument());
    expect(screen.queryByTestId("tr-field-error-0")).not.toBeInTheDocument();
    expect(screen.getByTestId("tr-affected-INT-2-route")).toHaveTextContent("RAW-1 → INT-2");
    expect(calls).toHaveLength(2);
  });
});

describe("批次用料追溯：旧结果随编辑失效", () => {
  it("成功追溯后修改关系会立即清除与当前输入不一致的旧结果", async () => {
    mockTrace();
    const user = userEvent.setup();
    render(<TraceabilityPanel />);

    await fillBatch(user, 0, "RAW-1", "花生原料", "raw_material");
    await user.click(screen.getByTestId("tr-add-batch"));
    await fillBatch(user, 1, "INT-1", "中间料", "intermediate");
    await user.type(screen.getByTestId("tr-relation-0-from"), "RAW-1");
    await user.type(screen.getByTestId("tr-relation-0-to"), "INT-1");
    await user.type(screen.getByTestId("tr-source"), "RAW-1");
    await user.click(screen.getByTestId("tr-submit"));
    await waitFor(() => expect(screen.getByTestId("tr-affected-INT-1")).toBeInTheDocument());

    // 改污染源：旧结果立即清除，等待重新追溯
    await user.clear(screen.getByTestId("tr-source"));
    await user.type(screen.getByTestId("tr-source"), "INT-1");
    expect(screen.queryByTestId("tr-result")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("tr-submit"));
    await waitFor(() => expect(screen.getByTestId("tr-result")).toBeInTheDocument());
    expect(screen.getByTestId("tr-summary")).toHaveTextContent("共影响 0 个下游批次");
    expect(screen.queryByTestId("tr-affected-INT-1")).not.toBeInTheDocument();
  });

  it("追溯请求未返回时编辑台账，旧输入对应的响应返回后不再显示", async () => {
    let resolveFirst: ((response: Response) => void) | null = null;
    const firstRequest = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => firstRequest)
      .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)) as RawPayload;
        expect(String(input)).toBe("/api/trace");
        return jsonResponse(
          buildTraceResponse(payload.batches, payload.relations, payload.source_code),
        );
      });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TraceabilityPanel />);

    await fillBatch(user, 0, "RAW-1", "花生原料", "raw_material");
    await user.type(screen.getByTestId("tr-relation-0-from"), "RAW-1");
    await user.type(screen.getByTestId("tr-relation-0-to"), "RAW-1"); // 稍后会改
    await user.type(screen.getByTestId("tr-source"), "RAW-1");

    // 直接构造一个会被前端接受的请求（补一个目标批次）
    await user.click(screen.getByTestId("tr-add-batch"));
    await fillBatch(user, 1, "INT-1", "中间料", "intermediate");
    await user.clear(screen.getByTestId("tr-relation-0-to"));
    await user.type(screen.getByTestId("tr-relation-0-to"), "INT-1");
    await user.click(screen.getByTestId("tr-submit"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // 响应未返回时修改物料名称：旧响应作废
    await user.type(screen.getByTestId("tr-batch-0-material"), "改名");
    resolveFirst!(
      jsonResponse(
        buildTraceResponse(
          [
            { code: "RAW-1", material_name: "花生原料", batch_type: "raw_material" },
            { code: "INT-1", material_name: "中间料", batch_type: "intermediate" },
          ],
          [{ from_code: "RAW-1", to_code: "INT-1" }],
          "RAW-1",
        ),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("tr-result")).not.toBeInTheDocument();

    // 重新追溯显示与当前输入一致的名称
    await user.click(screen.getByTestId("tr-submit"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("tr-result")).toBeInTheDocument());
    expect(screen.getByTestId("tr-affected-INT-1")).toBeInTheDocument();
  });
});
