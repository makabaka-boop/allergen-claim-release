import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangeoverPanel } from "./components/ChangeoverPanel";
import type { ChangeoverResponse, ResidueItem } from "./types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const TARGET_ORDER = ["milk", "peanut", "wheat", "barley", "rye"] as const;
type TargetName = (typeof TARGET_ORDER)[number];

// 按后端固定规则构造响应：未清洁时离开残留=进入残留∪直接成分，
// 经验证清洁清空；带入物仅取本批未直接含有的进入残留；来源保留最近批次。
function buildChangeoverResponse(
  batches: { name: string; direct: TargetName[] }[],
  cleaned: boolean[],
): ChangeoverResponse {
  let incoming: ResidueItem[] = [];
  const reports = batches.map((batch, index) => {
    const directSet = new Set(batch.direct);
    const carried = incoming.filter((item) => !directSet.has(item.target as TargetName));
    const outgoing = [...incoming];
    for (const target of batch.direct) {
      const existing = outgoing.findIndex((item) => item.target === target);
      const fresh: ResidueItem = {
        target,
        source_batch_index: index,
        source_batch_name: batch.name,
      };
      if (existing >= 0) outgoing[existing] = fresh;
      else outgoing.push(fresh);
    }
    outgoing.sort(
      (a, b) => TARGET_ORDER.indexOf(a.target as TargetName) - TARGET_ORDER.indexOf(b.target as TargetName),
    );
    const report = {
      batch_index: index,
      name: batch.name,
      direct_ingredients: TARGET_ORDER.filter((t) => directSet.has(t)),
      incoming_residue: incoming,
      carried_over: carried,
      outgoing_residue: outgoing,
      cleaned_before: index === 0 ? null : cleaned[index - 1],
    };
    incoming = cleaned[index] ? [] : outgoing;
    return report;
  });
  return {
    batches: reports,
    boundaries: cleaned.map((flag, index) => ({
      boundary_index: index,
      cleaned: flag,
      residue_cleared: flag,
    })),
  };
}

// 记录每次请求体的 fetch 打桩，默认按“真实推演语义”生成响应，可按用例覆盖
function mockSimulation(
  override?: (payload: { batches: { name: string }[]; boundaries: { cleaned: boolean }[] }) => Response,
) {
  const calls: unknown[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    expect(url).toBe("/api/changeover");
    const payload = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push(payload);
    if (override) return override(payload as never);
    const typed = payload as {
      batches: { name: string; contains_peanut?: boolean; contains_wheat?: boolean }[];
      boundaries: { cleaned: boolean }[];
    };
    const batches = typed.batches.map((b) => ({
      name: b.name,
      direct: [
        ...(b.contains_peanut ? (["peanut"] as TargetName[]) : []),
        ...(b.contains_wheat ? (["wheat"] as TargetName[]) : []),
      ],
    }));
    return jsonResponse(buildChangeoverResponse(batches, typed.boundaries.map((x) => x.cleaned)));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("换线残留推演：提交与逐批结果", () => {
  it("连续带入：花生经未清洁边界连续带入两批，来源解释来自真实响应", async () => {
    const { calls } = mockSimulation();
    const user = userEvent.setup();
    render(<ChangeoverPanel />);

    await user.type(screen.getByTestId("co-batch-0-name"), "花生酱A");
    await user.click(screen.getByTestId("co-batch-0-contains-peanut"));
    await user.type(screen.getByTestId("co-batch-1-name"), "燕麦B");
    await user.click(screen.getByTestId("co-submit"));

    // 逐批查看进入残留、带入物、离开残留
    await waitFor(() => expect(screen.getByTestId("co-result")).toBeInTheDocument());
    expect(screen.getByTestId("co-batch-1-incoming-peanut")).toHaveTextContent(
      "花生（来源：第 1 批「花生酱A」）",
    );
    expect(screen.getByTestId("co-batch-1-carried-peanut")).toHaveTextContent("花生酱A");
    expect(screen.getByTestId("co-batch-1-outgoing-peanut")).toHaveTextContent("花生酱A");
    // 首批无进入残留
    expect(screen.getByTestId("co-batch-0-incoming")).toHaveTextContent("无");

    // 真实请求体：边界默认未清洁
    const payload = calls[0] as { batches: unknown[]; boundaries: { cleaned: boolean }[] };
    expect(payload.batches).toHaveLength(2);
    expect(payload.boundaries).toEqual([{ cleaned: false }]);
  });

  it("直接成分不误报：本批直接含有的目标项不出现在带入物，但刷新最近来源", async () => {
    const { calls } = mockSimulation();
    const user = userEvent.setup();
    render(<ChangeoverPanel />);

    await user.type(screen.getByTestId("co-batch-0-name"), "花生酱A");
    await user.click(screen.getByTestId("co-batch-0-contains-peanut"));
    await user.type(screen.getByTestId("co-batch-1-name"), "花生酥B");
    await user.click(screen.getByTestId("co-batch-1-contains-peanut"));
    await user.click(screen.getByTestId("co-add-batch"));
    await user.type(screen.getByTestId("co-batch-2-name"), "燕麦C");
    await user.click(screen.getByTestId("co-submit"));

    await waitFor(() => expect(screen.getByTestId("co-result")).toBeInTheDocument());
    // B 批直接含花生：进入残留有花生，但带入物中不出现花生
    expect(screen.getByTestId("co-batch-1-incoming-peanut")).toBeInTheDocument();
    expect(screen.getByTestId("co-batch-1-direct")).toHaveTextContent("花生");
    expect(screen.queryByTestId("co-batch-1-carried-peanut")).not.toBeInTheDocument();
    expect(screen.getByTestId("co-batch-1-carried")).toHaveTextContent("无");
    // 最近来源刷新为第 2 批
    expect(screen.getByTestId("co-batch-2-incoming-peanut")).toHaveTextContent("花生酥B");

    const payload = calls[0] as { batches: { name: string; contains_peanut: boolean }[] };
    expect(payload.batches[1].contains_peanut).toBe(true);
  });

  it("清洁归零：经验证清洁后后续批次不再显示任何残留", async () => {
    mockSimulation();
    const user = userEvent.setup();
    render(<ChangeoverPanel />);

    await user.type(screen.getByTestId("co-batch-0-name"), "花生酱A");
    await user.click(screen.getByTestId("co-batch-0-contains-peanut"));
    await user.click(screen.getByTestId("co-batch-0-contains-wheat"));
    await user.type(screen.getByTestId("co-batch-1-name"), "清洁后B");
    // 标记两批之间已完成经验证清洁
    await user.click(screen.getByTestId("co-boundary-0-cleaned"));
    await user.click(screen.getByTestId("co-submit"));

    await waitFor(() => expect(screen.getByTestId("co-result")).toBeInTheDocument());
    expect(screen.getByTestId("co-batch-1-cleaned")).toBeInTheDocument();
    expect(screen.getByTestId("co-batch-1-incoming")).toHaveTextContent("无");
    expect(screen.getByTestId("co-batch-1-carried")).toHaveTextContent("无");
    expect(screen.getByTestId("co-batch-1-outgoing")).toHaveTextContent("无");
    // A 批离开残留仍然如实显示
    expect(screen.getByTestId("co-batch-0-outgoing-peanut")).toBeInTheDocument();
    expect(screen.getByTestId("co-batch-0-outgoing-wheat")).toBeInTheDocument();
  });

  it("请求体按生产顺序携带五个布尔直接成分字段", async () => {
    const { calls } = mockSimulation();
    const user = userEvent.setup();
    render(<ChangeoverPanel />);

    await user.type(screen.getByTestId("co-batch-0-name"), "A批");
    await user.click(screen.getByTestId("co-batch-0-contains-barley"));
    await user.type(screen.getByTestId("co-batch-1-name"), "B批");
    await user.click(screen.getByTestId("co-submit"));

    await waitFor(() => expect(screen.getByTestId("co-result")).toBeInTheDocument());
    const payload = calls[0] as { batches: Record<string, unknown>[] };
    expect(payload.batches[0]).toEqual({
      name: "A批",
      contains_milk: false,
      contains_peanut: false,
      contains_wheat: false,
      contains_barley: true,
      contains_rye: false,
    });
  });
});

describe("换线残留推演：字段错误保留输入并可修正后再次提交", () => {
  it("批次名称空白：就地提示、保留输入、不发请求；补填后再次提交成功", async () => {
    const { calls, fetchMock } = mockSimulation();
    const user = userEvent.setup();
    render(<ChangeoverPanel />);

    await user.type(screen.getByTestId("co-batch-0-name"), "花生酱A");
    // 第二批名称留空
    await user.click(screen.getByTestId("co-batch-0-contains-peanut"));
    await user.click(screen.getByTestId("co-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("co-field-error-0")).toHaveTextContent("第 2 批批次名称"),
    );
    expect(screen.queryByTestId("co-result")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    // 页面保留输入
    expect(screen.getByTestId("co-batch-0-name")).toHaveValue("花生酱A");
    expect(screen.getByTestId("co-batch-0-contains-peanut")).toBeChecked();

    // 修正后可再次提交
    await user.type(screen.getByTestId("co-batch-1-name"), "燕麦B");
    await user.click(screen.getByTestId("co-submit"));
    await waitFor(() => expect(screen.getByTestId("co-result")).toBeInTheDocument());
    expect(screen.queryByTestId("co-field-error-0")).not.toBeInTheDocument();
    expect(calls).toHaveLength(1);
  });

  it("批次数量不足：删除到仅剩一批时提示，重新添加后可提交", async () => {
    const { calls, fetchMock } = mockSimulation();
    const user = userEvent.setup();
    render(<ChangeoverPanel />);

    await user.click(screen.getByTestId("co-batch-1-remove"));
    await user.type(screen.getByTestId("co-batch-0-name"), "只有一批");
    await user.click(screen.getByTestId("co-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("co-field-error-0")).toHaveTextContent("至少需要 2 个批次"),
    );
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("co-add-batch"));
    expect(screen.queryByTestId("co-field-error-0")).not.toBeInTheDocument();
    await user.type(screen.getByTestId("co-batch-1-name"), "第二批");
    await user.click(screen.getByTestId("co-submit"));
    await waitFor(() => expect(screen.getByTestId("co-result")).toBeInTheDocument());
    expect(calls).toHaveLength(1);
  });

  it("批次名称重复：定位到具体批次，改名后再次提交成功", async () => {
    const { calls, fetchMock } = mockSimulation();
    const user = userEvent.setup();
    render(<ChangeoverPanel />);

    await user.type(screen.getByTestId("co-batch-0-name"), "同名");
    await user.type(screen.getByTestId("co-batch-1-name"), "同名");
    await user.click(screen.getByTestId("co-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("co-field-error-0")).toHaveTextContent("与第 1 批重复"),
    );
    expect(fetchMock).not.toHaveBeenCalled();

    await user.clear(screen.getByTestId("co-batch-1-name"));
    await user.type(screen.getByTestId("co-batch-1-name"), "不同名");
    await user.click(screen.getByTestId("co-submit"));
    await waitFor(() => expect(screen.getByTestId("co-result")).toBeInTheDocument());
    expect(calls).toHaveLength(1);
  });

  it("后端 422：按批次/边界定位显示，输入保留，修正后再次提交", async () => {    let attempts = 0;
    mockSimulation(() => {
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse({
          detail: [
            {
              loc: ["body", "boundaries", 0, "cleaned"],
              msg: "Input should be a valid boolean",
              type: "bool_type",
            },
          ],
        }, 422);
      }
      return jsonResponse(buildChangeoverResponse(
        [{ name: "A", direct: [] }, { name: "B", direct: [] }],
        [true],
      ));
    });
    const user = userEvent.setup();
    render(<ChangeoverPanel />);
    await user.type(screen.getByTestId("co-batch-0-name"), "A");
    await user.type(screen.getByTestId("co-batch-1-name"), "B");
    await user.click(screen.getByTestId("co-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("co-field-error-0")).toHaveTextContent(
        "第 1 批与第 2 批之间的经验证清洁标记",
      ),
    );
    expect(screen.queryByTestId("co-result")).not.toBeInTheDocument();
    // 输入保留
    expect(screen.getByTestId("co-batch-0-name")).toHaveValue("A");

    // 直接再次提交（第二次打桩返回成功）
    await user.click(screen.getByTestId("co-submit"));
    await waitFor(() => expect(screen.getByTestId("co-result")).toBeInTheDocument());
  });
});

describe("换线残留推演：调整顺序后重新推演", () => {
  it("下移批次会使上一轮结果失效，重新提交按新顺序推演", async () => {
    const { calls } = mockSimulation();
    const user = userEvent.setup();
    render(<ChangeoverPanel />);

    await user.type(screen.getByTestId("co-batch-0-name"), "花生酱A");
    await user.click(screen.getByTestId("co-batch-0-contains-peanut"));
    await user.type(screen.getByTestId("co-batch-1-name"), "燕麦B");
    await user.click(screen.getByTestId("co-submit"));
    await waitFor(() => expect(screen.getByTestId("co-result")).toBeInTheDocument());

    // 调整顺序：把第 1 批下移（与第 2 批互换）
    await user.click(screen.getByTestId("co-batch-0-down"));
    // 旧结果立即失效，等待重新推演
    expect(screen.queryByTestId("co-result")).not.toBeInTheDocument();
    expect(screen.getByTestId("co-batch-0-name")).toHaveValue("燕麦B");
    expect(screen.getByTestId("co-batch-1-name")).toHaveValue("花生酱A");

    await user.click(screen.getByTestId("co-submit"));
    await waitFor(() => expect(screen.getByTestId("co-result")).toBeInTheDocument());

    const payload = calls[1] as { batches: { name: string; contains_peanut: boolean }[] };
    expect(payload.batches.map((b) => b.name)).toEqual(["燕麦B", "花生酱A"]);
    expect(payload.batches[0].contains_peanut).toBe(false);
    expect(payload.batches[1].contains_peanut).toBe(true);

    // 新顺序下首批（燕麦B）不再带花生残留，花生出现在第 2 批自己的离开残留
    expect(screen.getByTestId("co-batch-0-outgoing")).toHaveTextContent("无");
    expect(screen.getByTestId("co-batch-1-outgoing-peanut")).toBeInTheDocument();
  });

  it("删除中间批次后边界数量同步收缩，提交载荷长度始终为批次数减一", async () => {
    const { calls } = mockSimulation();
    const user = userEvent.setup();
    render(<ChangeoverPanel />); // 初始 2 批 1 边界

    await user.click(screen.getByTestId("co-add-batch")); // 3 批 2 边界
    await user.click(screen.getByTestId("co-boundary-0-cleaned"));
    await user.click(screen.getByTestId("co-boundary-1-cleaned"));
    await user.type(screen.getByTestId("co-batch-0-name"), "A");
    await user.type(screen.getByTestId("co-batch-1-name"), "B");
    await user.type(screen.getByTestId("co-batch-2-name"), "C");

    // 删除中间的 B：其前后两条清洁边界合并为一条（保守未清洁）
    await user.click(screen.getByTestId("co-batch-1-remove"));
    await user.click(screen.getByTestId("co-submit"));
    await waitFor(() => expect(screen.getByTestId("co-result")).toBeInTheDocument());

    const payload = calls[0] as { batches: unknown[]; boundaries: unknown[] };
    expect(payload.batches).toHaveLength(2);
    expect(payload.boundaries).toHaveLength(1);
    expect(payload.boundaries[0]).toEqual({ cleaned: false });
  });

  it("勾选清洁边界后重新提交：后续批次残留清空", async () => {
    const { calls } = mockSimulation();
    const user = userEvent.setup();
    render(<ChangeoverPanel />);

    await user.type(screen.getByTestId("co-batch-0-name"), "花生酱A");
    await user.click(screen.getByTestId("co-batch-0-contains-peanut"));
    await user.type(screen.getByTestId("co-batch-1-name"), "燕麦B");
    await user.click(screen.getByTestId("co-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("co-batch-1-incoming-peanut")).toBeInTheDocument(),
    );

    // 标记经验证清洁后重新推演
    await user.click(screen.getByTestId("co-boundary-0-cleaned"));
    expect(screen.queryByTestId("co-result")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("co-submit"));
    await waitFor(() => expect(screen.getByTestId("co-result")).toBeInTheDocument());

    expect(screen.getByTestId("co-batch-1-incoming")).toHaveTextContent("无");
    const payload = calls[1] as { boundaries: { cleaned: boolean }[] };
    expect(payload.boundaries[0]).toEqual({ cleaned: true });
  });
});
