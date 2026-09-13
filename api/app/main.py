from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .evaluate import evaluate
from .schemas import ReleaseRequest, ReleaseResponse

app = FastAPI(
    title="包装放行台 API",
    description="基于直接成分与同组共线接触的“不含”声明放行裁决服务",
    version="1.0.0",
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
