# 一次性验收镜像：真实 Python 3.12 + Node 20 + 预装 Chromium
# 顺序执行：后端 pytest -> 前端构建/类型检查 -> Vitest -> 对真实 compose 栈跑 Playwright
FROM mcr.microsoft.com/playwright:v1.49.1-noble

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# noble 自带 Python 3.12
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && python3 --version | grep -q "Python 3.12"

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

WORKDIR /app

# 后端依赖（含 pytest/httpx）
COPY api/requirements.txt /app/api/requirements.txt
COPY api/requirements-dev.txt /app/api/requirements-dev.txt
RUN pip install --no-cache-dir -r /app/api/requirements-dev.txt

# 前端依赖（Chromium 已由基础镜像预装）
COPY web/package.json web/package-lock.json* /app/web/
WORKDIR /app/web
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

WORKDIR /app
COPY . /app
COPY verify/run.sh /app/verify/run.sh
RUN chmod +x /app/verify/run.sh

CMD ["/app/verify/run.sh"]
