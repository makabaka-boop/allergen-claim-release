from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .changeover import simulate
from .compare import compare
from .evaluate import evaluate
from .schemas import (
    ChangeoverRequest,
    ChangeoverResponse,
    CompareRequest,
    CompareResponse,
    ReleaseRequest,
    ReleaseResponse,
    TraceabilityRequest,
    TraceabilityResponse,
)
from .traceability import trace

app = FastAPI(
    title="包装放行台 API",
    description="基于直接成分与同组共线接触的“不含”声明放行裁决服务",
    version="1.2.0",
)

# 本地 Vite 开发服务器联调需要跨域；生产由 Nginx 同源反代
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/evaluate", response_model=ReleaseResponse)
def release(request: ReleaseRequest) -> ReleaseResponse:
    """对结构化配方与声明做真实裁决。非法请求返回 422 字段级错误，不产生判定。"""
    return evaluate(request)


@app.post("/api/compare", response_model=CompareResponse)
def compare_plans(request: CompareRequest) -> CompareResponse:
    """前后方案影响比较：对照与现方案分别复用同一裁决，再按声明对比。

    任一侧字段非法时返回 422，loc 以 baseline/current 前缀定位到对应方案，
    且不产生任何比较结果。
    """
    return compare(request)


@app.post("/api/changeover", response_model=ChangeoverResponse)
def changeover(request: ChangeoverRequest) -> ChangeoverResponse:
    """换线残留推演：按生产批次序列逐批给出进入残留、前序带入与离开残留。

    边界支持未清洁、全部清洁或指定已清除目标的局部清洁；局部清洁仅移除
    指定目标，保留项继续携带最近来源。批次数量不足、名称空白或重复、
    清洁边界缺失/长度不符、成分标记非布尔、清除目标为空/重复/越界/
    与全部清洁冲突均返回 422 字段级错误，loc 定位到具体批次或边界，
    且不产生推演结果。
    """
    return simulate(request)


@app.post("/api/trace", response_model=TraceabilityResponse)
def trace_batches(request: TraceabilityRequest) -> TraceabilityResponse:
    """批次用料追溯：在完整关系图上从污染源沿投料方向稳定遍历。

    只返回可从污染源到达的下游批次，按传播层级分组并为每个批次还原
    层级最少、关系序号字典序最小的最短投料路径。批次编号空白/重复、
    关系端点不存在、自引用、关系成环或污染源不存在均返回 422 字段级
    错误，loc 定位到具体批次或关系，且不产生追溯结果。
    """
    return trace(request)
