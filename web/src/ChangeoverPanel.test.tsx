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

type CleaningChoice =
  | { mode: "uncleaned" }
  | { mode: "full" }
  | { mode: "partial"; cleared: TargetName[] };

// 按后端固定规则构造响应：全部清洁清空；局部清洁仅移除指定目标，
// 未清洁时离开残留=进入残留∪直接成分；带入物仅取本批未直接含有的进入残留；
// 来源保留最近批次。
function buildChangeoverResponse(
  batches: { name: string; direct: TargetName[] }[],
  cleaning: CleaningChoice[],
): ChangeoverResponse {
  let incoming: ResidueItem[] = [];
  const allTargets = [...TARGET_ORDER];
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
    const choice = index === 0 ? null : (cleaning[index - 1] ?? { mode: "uncleaned" });
    const report = {
      batch_index: index,
      name: batch.name,
      direct_ingredients: TARGET_ORDER.filter((t) => directSet.has(t)),
      incoming_residue: incoming,
      carried_over: carried,
      outgoing_residue: outgoing,
      cleaned_before: index === 0 ? null : choice?.mode === "full",
    };
    const boundary = cleaning[index];
    if (boundary?.mode === "full") incoming = [];
    else if (boundary?.mode === "partial") {
      const removed = new Set(boundary.cleared);
      incoming = outgoing.filter((item) => !removed.has(item.target as TargetName));
    } else incoming = outgoing;
    return report;
  });
  return {
    batches: reports,
    boundaries: cleaning.map((choice, index) => ({
      boundary_index: index,
      cleaned: choice.mode === "full",
      residue_cleared: choice.mode === "full",
      cleared_targets:
        choice.mode === "full"
          ? allTargets
          : choice.mode === "partial"
            ? TARGET_ORDER.filter((t) => choice.cleared.includes(t))
            : [],
    })),
  };
}

interface RawBoundary {
  cleaned: boolean;
  cleared_targets?: string[];
}

// 记录每次请求体的 fetch 打桩，默认按“真实推演语义”生成响应，可按用例覆盖
function mockSimulation(
  override?: (payload: { batches: { name: string }[]; boundaries: RawBoundary[] }) => Response,
) {
  const calls: unknown[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    expect(url).toBe("/api/changeover");
    const payload = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push(payload);
    if (override) return override(payload as never);
    const typed = payload as {
      batches: { name: string; [flag: string]: string | boolean | undefined }[];
      boundaries: RawBoundary[];
    };
    const batches = typed.batches.map((b) => ({
      name: b.name,
      direct: TARGET_ORDER.filter((t) => b[`contains_${t}`] === true),
    }));
    const cleaning: CleaningChoice[] = typed.boundaries.map((boundary) => {
      if (boundary.cleaned) return { mode: "full" };
      if (boundary.cleared_targets && boundary.cleared_targets.length > 0) {
        return { mode: "partial", cleared: boundary.cleared_targets as TargetName[] };
      }
      return { mode: "uncleaned" };
    });
    return jsonResponse(buildChangeoverResponse(batches, cleaning));
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
    // 标记两批之间已完成全部经验证清洁
    await user.click(screen.getByTestId("co-boundary-0-mode-full"));
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

  it("局部清洁：仅清除花生，牛奶保留最近来源继续带入后续批次", async () => {
    const { calls } = mockSimulation();
    const user = userEvent.setup();
    render(<ChangeoverPanel />);

    await user.type(screen.getByTestId("co-batch-0-name"), "奶糖A");
    await user.click(screen.getByTestId("co-batch-0-contains-milk"));
    await user.click(screen.getByTestId("co-batch-0-contains-peanut"));
    await user.type(screen.getByTestId("co-batch-1-name"), "中转B");
    // 边界选择“局部清洁”并只勾选花生
    await user.click(screen.getByTestId("co-boundary-0-mode-partial"));
    expect(screen.getByTestId("co-boundary-0-targets")).toBeInTheDocument();
    await user.click(screen.getByTestId("co-boundary-0-target-peanut"));
    await user.click(screen.getByTestId("co-add-batch"));
    await user.type(screen.getByTestId("co-batch-2-name"), "末批C");
    await user.click(screen.getByTestId("co-submit"));

    await waitFor(() => expect(screen.getByTestId("co-result")).toBeInTheDocument());

    // 第 2 批进入残留只有牛奶，花生已被局部清除
    expect(screen.getByTestId("co-batch-1-incoming-milk")).toHaveTextContent("奶糖A");
    expect(screen.queryByTestId("co-batch-1-incoming-peanut")).not.toBeInTheDocument();
    expect(screen.queryByTestId("co-batch-1-carried-peanut")).not.toBeInTheDocument();
    // 第 2 批不是全部清洁：不显示全部清洁徽标，cleaned_before 为 false
    expect(screen.queryByTestId("co-batch-1-cleaned")).not.toBeInTheDocument();
    // 牛奶继续携带最近来源到第 3 批
    expect(screen.getByTestId("co-batch-2-incoming-milk")).toHaveTextContent(
      "来源：第 1 批「奶糖A」",
    );
    expect(screen.queryByTestId("co-batch-2-incoming-peanut")).not.toBeInTheDocument();

    // 边界结果确认实际清除项仅花生
    expect(screen.getByTestId("co-boundary-report-0")).toHaveTextContent("局部清洁");
    expect(screen.getByTestId("co-boundary-report-0-target-peanut")).toBeInTheDocument();
    expect(
      screen.queryByTestId("co-boundary-report-0-target-milk"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("co-boundary-report-1-targets")).toHaveTextContent("无确认清除项");

    // 请求体：cleaned=false + cleared_targets=['peanut']；第二条边界保持旧语义
    const payload = calls[0] as {
      boundaries: { cleaned: boolean; cleared_targets?: string[] }[];
    };
    expect(payload.boundaries[0]).toEqual({ cleaned: false, cleared_targets: ["peanut"] });
    expect(payload.boundaries[1]).toEqual({ cleaned: false });
  });

  it("局部清洁下被保留目标与本批直接成分求并集，离开残留保留各来源", async () => {
    mockSimulation();
    const user = userEvent.setup();
    render(<ChangeoverPanel />);

    await user.type(screen.getByTestId("co-batch-0-name"), "A批");
    await user.click(screen.getByTestId("co-batch-0-contains-peanut"));
    await user.click(screen.getByTestId("co-batch-0-contains-wheat"));
    await user.type(screen.getByTestId("co-batch-1-name"), "B批");
    await user.click(screen.getByTestId("co-batch-1-contains-milk"));
    await user.click(screen.getByTestId("co-boundary-0-mode-partial"));
    await user.click(screen.getByTestId("co-boundary-0-target-peanut"));
    await user.click(screen.getByTestId("co-submit"));

    await waitFor(() => expect(screen.getByTestId("co-result")).toBeInTheDocument());
    // 花生被清除；小麦保留为带入；牛奶是本批直接成分
    expect(screen.queryByTestId("co-batch-1-incoming-peanut")).not.toBeInTheDocument();
    expect(screen.getByTestId("co-batch-1-incoming-wheat")).toHaveTextContent("A批");
    expect(screen.getByTestId("co-batch-1-outgoing-wheat")).toHaveTextContent("A批");
    expect(screen.getByTestId("co-batch-1-outgoing-milk")).toHaveTextContent("B批");
  });

  it("切换清洁方式会显隐清除目标勾选区，切走局部清洁不携带陈旧清除目标", async () => {
    const { calls } = mockSimulation();
    const user = userEvent.setup();
    render(<ChangeoverPanel />);

    await user.type(screen.getByTestId("co-batch-0-name"), "A批");
    await user.type(screen.getByTestId("co-batch-1-name"), "B批");
    await user.click(screen.getByTestId("co-boundary-0-mode-partial"));
    await user.click(screen.getByTestId("co-boundary-0-target-peanut"));
    // 切到未清洁：勾选区隐藏，提交载荷不含 cleared_targets
    await user.click(screen.getByTestId("co-boundary-0-mode-uncleaned"));
    expect(screen.queryByTestId("co-boundary-0-targets")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("co-submit"));
    await waitFor(() => expect(screen.getByTestId("co-result")).toBeInTheDocument());
    const firstPayload = calls[0] as { boundaries: Record<string, unknown>[] };
    expect(firstPayload.boundaries[0]).toEqual({ cleaned: false });
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

  it("批次名称重复：每个参与重复的批次（含首个）都定位提示，改名后再次提交成功", async () => {
    const { calls, fetchMock } = mockSimulation();
    const user = userEvent.setup();
    render(<ChangeoverPanel />);

    await user.type(screen.getByTestId("co-batch-0-name"), "同名");
    await user.type(screen.getByTestId("co-batch-1-name"), "同名");
    await user.click(screen.getByTestId("co-submit"));

    // 两个批次都参与重复：首个批次同样获得字段提示，不能只标记后者
    await waitFor(() =>
      expect(screen.getByTestId("co-field-error-0")).toHaveTextContent("第 1 批批次名称"),
    );
    expect(screen.getByTestId("co-field-error-0")).toHaveTextContent("与第 2 批重复");
    expect(screen.getByTestId("co-field-error-1")).toHaveTextContent("第 2 批批次名称");
    expect(screen.getByTestId("co-field-error-1")).toHaveTextContent("与第 1 批重复");
    expect(fetchMock).not.toHaveBeenCalled();

    await user.clear(screen.getByTestId("co-batch-1-name"));
    await user.type(screen.getByTestId("co-batch-1-name"), "不同名");
    await user.click(screen.getByTestId("co-submit"));
    await waitFor(() => expect(screen.getByTestId("co-result")).toBeInTheDocument());
    expect(calls).toHaveLength(1);
  });

  it("三个同名批次：首个与后两个一样获得重复名称字段提示", async () => {
    const { fetchMock } = mockSimulation();
    const user = userEvent.setup();
    render(<ChangeoverPanel />);

    await user.click(screen.getByTestId("co-add-batch"));
    await user.type(screen.getByTestId("co-batch-0-name"), "同名");
    await user.type(screen.getByTestId("co-batch-1-name"), "同名");
    await user.type(screen.getByTestId("co-batch-2-name"), "同名");
    await user.click(screen.getByTestId("co-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("co-field-error-0")).toHaveTextContent("第 1 批批次名称"),
    );
    expect(screen.getByTestId("co-field-error-0")).toHaveTextContent("与第 2 批、第 3 批重复");
    expect(screen.getByTestId("co-field-error-1")).toHaveTextContent("与第 1 批重复");
    expect(screen.getByTestId("co-field-error-2")).toHaveTextContent("与第 1 批重复");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("co-result")).not.toBeInTheDocument();
  });

  it("后端 422：按批次/边界定位显示，输入保留，修正后再次提交", async () => {
    let attempts = 0;
    mockSimulation(() => {
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse({
          detail: [
            {
              loc: ["body", "boundaries", 0, "cleared_targets"],
              msg: "清除目标存在重复项：peanut",
              type: "value_error",
            },
          ],
        }, 422);
      }
      return jsonResponse(buildChangeoverResponse(
        [{ name: "A", direct: [] }, { name: "B", direct: [] }],
        [{ mode: "uncleaned" }],
      ));
    });
    const user = userEvent.setup();
    render(<ChangeoverPanel />);
    await user.type(screen.getByTestId("co-batch-0-name"), "A");
    await user.type(screen.getByTestId("co-batch-1-name"), "B");
    await user.click(screen.getByTestId("co-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("co-field-error-0")).toHaveTextContent(
        "局部清洁的清除目标",
      ),
    );
    expect(screen.queryByTestId("co-result")).not.toBeInTheDocument();
    // 输入保留
    expect(screen.getByTestId("co-batch-0-name")).toHaveValue("A");

    // 直接再次提交（第二次打桩返回成功）
    await user.click(screen.getByTestId("co-submit"));
    await waitFor(() => expect(screen.getByTestId("co-result")).toBeInTheDocument());
  });

  it("局部清洁未选任何目标：前端拦截并保留选择，勾选后直接重试成功", async () => {
    const { calls, fetchMock } = mockSimulation();
    const user = userEvent.setup();
    render(<ChangeoverPanel />);

    await user.type(screen.getByTestId("co-batch-0-name"), "奶糖A");
    await user.type(screen.getByTestId("co-batch-1-name"), "B批");
    await user.click(screen.getByTestId("co-boundary-0-mode-partial"));
    // 不勾选任何清除目标直接提交
    await user.click(screen.getByTestId("co-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("co-field-error-0")).toHaveTextContent("局部清洁"),
    );
    expect(screen.getByTestId("co-field-error-0")).toHaveTextContent("清除目标");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("co-result")).not.toBeInTheDocument();
    // 批次与清洁选择（局部清洁单选 + 勾选区）均保留
    expect(screen.getByTestId("co-batch-0-name")).toHaveValue("奶糖A");
    expect(screen.getByTestId("co-boundary-0-mode-partial")).toBeChecked();
    expect(screen.getByTestId("co-boundary-0-targets")).toBeInTheDocument();

    // 勾选花生后直接重试
    await user.click(screen.getByTestId("co-boundary-0-target-peanut"));
    await user.click(screen.getByTestId("co-submit"));
    await waitFor(() => expect(screen.getByTestId("co-result")).toBeInTheDocument());
    expect(screen.queryByTestId("co-field-error-0")).not.toBeInTheDocument();
    expect(calls).toHaveLength(1);
  });

  it("后端拒绝局部清洁请求：保留批次与清洁选择，修正勾选后重试成功", async () => {
    let attempts = 0;
    mockSimulation((payload) => {
      attempts += 1;
      const boundary = (payload as { boundaries: RawBoundary[] }).boundaries[0];
      // 模拟后端对局部清洁边界的字段级拒绝（如清除目标为空/重复），且不产生结果
      if (attempts === 1 && boundary.cleared_targets?.[0] === "peanut") {
        return jsonResponse({
          detail: [
            {
              loc: ["body", "boundaries", 0, "cleared_targets"],
              msg: "清除目标存在重复项：peanut",
              type: "value_error",
            },
          ],
        }, 422);
      }
      return jsonResponse(
        buildChangeoverResponse(
          [{ name: "A", direct: [] }, { name: "B", direct: [] }],
          [{ mode: "partial", cleared: ["wheat"] }],
        ),
      );
    });
    const user = userEvent.setup();
    render(<ChangeoverPanel />);
    await user.type(screen.getByTestId("co-batch-0-name"), "A");
    await user.type(screen.getByTestId("co-batch-1-name"), "B");
    await user.click(screen.getByTestId("co-boundary-0-mode-partial"));
    await user.click(screen.getByTestId("co-boundary-0-target-peanut"));
    await user.click(screen.getByTestId("co-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("co-field-error-0")).toHaveTextContent("清除目标"),
    );
    expect(screen.queryByTestId("co-result")).not.toBeInTheDocument();
    // 批次输入与局部清洁选择（含勾选状态）全部保留，可直接修正
    expect(screen.getByTestId("co-batch-1-name")).toHaveValue("B");
    expect(screen.getByTestId("co-boundary-0-mode-partial")).toBeChecked();
    expect(screen.getByTestId("co-boundary-0-target-peanut")).toBeChecked();

    // 改为只清除小麦后直接重试
    await user.click(screen.getByTestId("co-boundary-0-target-peanut"));
    await user.click(screen.getByTestId("co-boundary-0-target-wheat"));
    await user.click(screen.getByTestId("co-submit"));
    await waitFor(() => expect(screen.getByTestId("co-result")).toBeInTheDocument());
    expect(screen.queryByTestId("co-field-error-0")).not.toBeInTheDocument();
    expect(screen.getByTestId("co-boundary-report-0-target-wheat")).toBeInTheDocument();
  });
});

describe("换线残留推演：调整顺序后重新推演", () => {
  it("交换相邻批次后，针对旧批次关系的局部清洁选择不沿用到新间隙", async () => {
    const { calls } = mockSimulation();
    const user = userEvent.setup();
    render(<ChangeoverPanel />);

    await user.type(screen.getByTestId("co-batch-0-name"), "花生酱A");
    await user.click(screen.getByTestId("co-batch-0-contains-peanut"));
    await user.type(screen.getByTestId("co-batch-1-name"), "燕麦B");
    // 针对旧关系“A → B”设置局部清洁（仅清除花生）
    await user.click(screen.getByTestId("co-boundary-0-mode-partial"));
    await user.click(screen.getByTestId("co-boundary-0-target-peanut"));

    // 交换两批：新间隙是“B → A”，旧局部清洁选择必须被保守重置为未清洁
    await user.click(screen.getByTestId("co-batch-0-down"));
    expect(screen.getByTestId("co-boundary-0-mode-uncleaned")).toBeChecked();
    expect(screen.getByTestId("co-boundary-0-mode-partial")).not.toBeChecked();
    expect(screen.queryByTestId("co-boundary-0-targets")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("co-submit"));
    await waitFor(() => expect(screen.getByTestId("co-result")).toBeInTheDocument());

    // 重新推演按未清洁处理，载荷不得再携带旧的 cleared_targets
    const payload = calls[0] as {
      batches: { name: string }[];
      boundaries: { cleaned: boolean; cleared_targets?: string[] }[];
    };
    expect(payload.batches.map((b) => b.name)).toEqual(["燕麦B", "花生酱A"]);
    expect(payload.boundaries[0]).toEqual({ cleaned: false });
    expect(payload.boundaries[0].cleared_targets).toBeUndefined();
    // 新顺序第 2 批（花生酱A）的花生是本批直接成分，不被旧清洁选择清除
    expect(screen.getByTestId("co-batch-1-direct")).toHaveTextContent("花生");
  });

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
    await user.click(screen.getByTestId("co-boundary-0-mode-full"));
    await user.click(screen.getByTestId("co-boundary-1-mode-full"));
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

    // 标记全部清洁后重新推演
    await user.click(screen.getByTestId("co-boundary-0-mode-full"));
    expect(screen.queryByTestId("co-result")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("co-submit"));
    await waitFor(() => expect(screen.getByTestId("co-result")).toBeInTheDocument());

    expect(screen.getByTestId("co-batch-1-incoming")).toHaveTextContent("无");
    const payload = calls[1] as { boundaries: { cleaned: boolean }[] };
    expect(payload.boundaries[0]).toEqual({ cleaned: true });
  });
});

describe("换线残留推演：异步结果与当前编辑序列一致", () => {
  it("推演请求未返回时修改批次成分，先前输入对应的响应返回后不再显示", async () => {
    // 第一次请求挂起，可由测试控制何时返回
    let resolveFirst: ((response: Response) => void) | null = null;
    const firstRequest = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => firstRequest)
      .mockImplementation(async () =>
        jsonResponse(
          buildChangeoverResponse(
            [
              { name: "燕麦B", direct: [] },
              { name: "花生酱A", direct: ["peanut"] },
            ],
            [{ mode: "uncleaned" }],
          ),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ChangeoverPanel />);

    // 旧输入：花生在第 1 批
    await user.type(screen.getByTestId("co-batch-0-name"), "花生酱A");
    await user.click(screen.getByTestId("co-batch-0-contains-peanut"));
    await user.type(screen.getByTestId("co-batch-1-name"), "燕麦B");
    await user.click(screen.getByTestId("co-submit"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // 响应未返回时交换批次顺序：当前编辑序列变成 燕麦B → 花生酱A
    await user.click(screen.getByTestId("co-batch-0-down"));
    expect(screen.getByTestId("co-batch-0-name")).toHaveValue("燕麦B");
    expect(screen.queryByTestId("co-result")).not.toBeInTheDocument();

    // 先前输入（花生在首批）对应的响应此时才返回：必须被丢弃
    resolveFirst!(
      jsonResponse(
        buildChangeoverResponse(
          [
            { name: "花生酱A", direct: ["peanut"] },
            { name: "燕麦B", direct: [] },
          ],
          [{ mode: "uncleaned" }],
        ),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("co-result")).not.toBeInTheDocument();

    // 按当前编辑序列重新推演，结果与页面一致
    await user.click(screen.getByTestId("co-submit"));
    await waitFor(() => expect(screen.getByTestId("co-result")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 首批是干净的燕麦B：无离开残留；花生只出现在第 2 批自己的直接成分
    expect(screen.getByTestId("co-batch-0-outgoing")).toHaveTextContent("无");
    expect(screen.getByTestId("co-batch-1-direct")).toHaveTextContent("花生");
  });

  it("推演请求未返回时修改批次成分，先前输入对应的 422 响应返回后也不再提示", async () => {
    let resolveFirst: ((response: Response) => void) | null = null;
    const firstRequest = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi.fn(async () => firstRequest);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ChangeoverPanel />);

    await user.type(screen.getByTestId("co-batch-0-name"), "A批");
    await user.type(screen.getByTestId("co-batch-1-name"), "B批");
    await user.click(screen.getByTestId("co-submit"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // 等待期间编辑批次：旧 422 返回时必须作废
    await user.click(screen.getByTestId("co-batch-0-contains-peanut"));
    resolveFirst!(
      jsonResponse(
        {
          detail: [
            {
              loc: ["body", "boundaries", 0, "cleared_targets"],
              msg: "旧输入的字段错误，不应再显示",
              type: "value_error",
            },
          ],
        },
        422,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("co-field-error-0")).not.toBeInTheDocument();
  });
});
