# 包装放行台（Release Desk）

面向包装印刷放行环节的真实联调系统。解决的问题：**配方原料成分与同组共线接触信息
常被分开核对**，复核员可能只看到原料里没有目标物，就放过一条实际不成立的“不含”声明。
本系统要求浏览器把每行原料的「直接成分勾选」与「同组共线接触标记」一并提交，由后端
按固定规则联合裁决。

- 后端：Python 3.12 · FastAPI · Pydantic
- 前端：TypeScript · React 18 · Vite
- 测试：pytest（裁决与 HTTP）、Vitest + Testing Library（组件与状态流）、
  Playwright（浏览器对真实 Web+API 栈的端到端）
- 编排：Docker Compose（Web / API / 一次性 `verify` 验收服务）

## 裁决规则（固定，代码即规则）

对每条被选中的声明，只有当**所有原料行的直接成分与同组共线标记都未命中相关目标项**
时才放行；任一命中即阻断该声明，并逐条返回直接成分与共线证据。

| 声明（枚举值） | 界面文案 | 需要全部未命中的目标项 |
| --- | --- | --- |
| `milk_free` | 不含牛奶 | 牛奶 milk |
| `peanut_free` | 不含花生 | 花生 peanut |
| `gluten_free` | 不含麸质 | **严格等于**小麦 wheat、大麦 barley、黑麦 rye |

- 麸质命中集合**严格等于 {小麦, 大麦, 黑麦}**；牛奶、花生不属于麸质，其命中不得误伤
  “不含麸质”。
- 共线接触与直接成分效力相同：仅共线命中（直接成分全干净）同样阻断对应声明。
- 所有请求声明均放行时 `printable = true`（界面显示“可印刷”），否则禁止印刷。

## 数据约定

### 请求 `POST /api/evaluate`

```json
{
  "ingredients": [
    {
      "name": "燕麦粉",
      "contains_milk": false,
      "contains_peanut": false,
      "contains_wheat": false,
      "contains_barley": false,
      "contains_rye": false,
      "contact_milk": false,
      "contact_peanut": false,
      "contact_wheat": true,
      "contact_barley": false,
      "contact_rye": false
    }
  ],
  "claims": ["gluten_free"]
}
```

- `ingredients`：结构化配方表，每行 10 个**必填布尔**标记。
  - `contains_*`：该行直接成分是否含有目标物（界面勾选）。
  - `contact_*`：该行同组共线接触标记（同产线/同组线接触到目标物）。
- `claims`：拟印刷声明，仅允许 `milk_free` / `peanut_free` / `gluten_free`。

### 非法输入：字段级错误且不产生判定（HTTP 422）

以下情况一律由 Pydantic 拒绝，返回 FastAPI 标准 `detail` 列表（`loc` 精确定位到
字段，如 `body.ingredients.0.contact_milk`），**不会返回任何裁决结果**：

- 非法声明枚举（如 `gluten_fre`）；
- 空配方（`ingredients` 缺失或为空数组）、空声明列表；
- 任一直接成分/共线标记缺失或为 `null`、非布尔值；
- 原料名称为空白；
- 出现目标集合之外的额外字段（如 `contains_gluten`，模型 `extra=forbid`）。

### 响应（合法请求，HTTP 200）

```json
{
  "printable": false,
  "rows": [
    {
      "row_index": 0,
      "name": "燕麦粉",
      "direct_hits": [],
      "contact_hits": ["wheat"]
    }
  ],
  "verdicts": [
    {
      "claim": "gluten_free",
      "allowed": false,
      "blocked_by": [
        { "row_index": 0, "ingredient_name": "燕麦粉", "target": "wheat", "source": "contact" }
      ]
    }
  ]
}
```

- `rows`：逐行返回该行的直接成分命中与共线接触命中。
- `verdicts`：逐条声明给出 `allowed` 与阻断证据清单（行号、原料名、目标项、
  `source` 为 `direct` 直接成分或 `contact` 共线接触）。

另有 `GET /health` 返回 `{"status":"ok"}`，供健康检查与验收使用。

## 用 Docker Compose 启动（推荐）

```bash
docker compose up --build
```

- Web：<http://localhost:8080>（Nginx 托管构建产物，并把 `/api`、`/health` 同源反代到 API）
- API 文档：<http://localhost:8000/docs>

### 端口覆盖

宿主端口分别由 `WEB_PORT`、`API_PORT` 覆盖（默认 8080 / 8000）：

```bash
WEB_PORT=9090 API_PORT=9000 docker compose up --build
```

或复制 `cp .env.example .env` 后修改。容器内端口固定为 Web 80 / API 8000。

### 一次性验收服务 `verify`

`verify` 是一个**运行一次即退出**的服务：它构建独立镜像（Python 3.12 + Node 20 +
预装 Chromium），在真实启动 Web 与 API 容器后依次执行：

1. 后端 `pytest`（裁决规则与 422 字段级错误）；
2. 前端 TypeScript 类型检查与生产构建；
3. `Vitest` 组件/状态流测试；
4. `Playwright` 端到端测试（容器内浏览器访问同栈真实 Web，经 Nginx 打到真实 FastAPI）。

```bash
docker compose --profile verify run --build --rm verify
```

退出码 0 表示全部验收通过。Compose 会依据 `depends_on: condition: service_healthy`
先拉起并等待 Web/API 健康后再执行验收；该服务配置了 `restart: "no"`，不会常驻。

## 本地开发（不使用 Docker）

后端：

```bash
cd api
python3.12 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 8000
```

前端：

```bash
cd web
npm install
API_PORT=8000 npm run dev      # Vite 把 /api、/health 代理到 http://localhost:8000
```

打开 Vite 输出的本地地址（默认 <http://localhost:5173>，可用 `WEB_PORT` 覆盖）。

## 测试

```bash
# 后端
cd api && pytest -q

# 前端单元/组件
cd web && npm test

# 端到端（需 Web+API 已在运行）
cd web
E2E_BASE_URL=http://localhost:8080 npx playwright test       # compose 栈
E2E_BASE_URL=http://localhost:5173 npx playwright test       # 本地 Vite 开发栈
```

## 目录结构

```
.
├── api/                 # FastAPI 服务
│   ├── app/
│   │   ├── rules.py     # 目标项/声明/麸质集合等固定规则（纯枚举与映射）
│   │   ├── schemas.py   # Pydantic 模型与字段级校验（extra=forbid、枚举白名单）
│   │   ├── evaluate.py  # 联合裁决：直接成分 + 共线接触
│   │   └── main.py      # 路由、CORS、健康检查
│   └── tests/           # pytest：规则矩阵 + HTTP 422 契约
├── web/                 # React + Vite 前端
│   ├── src/
│   │   ├── types.ts            # 与后端一一对应的枚举、类型、空行工厂
│   │   ├── api.ts              # 真实 fetch 调用与 422 字段错误映射
│   │   ├── App.tsx             # 配方表 + 声明选择 + 提交 + 裁决呈现
│   │   └── components/         # 配方表/声明选择/证据面板/字段错误
│   ├── e2e/release.spec.ts     # Playwright 真实联调端到端
│   └── src/**/*.test.ts(x)     # Vitest
├── verify/              # 一次性验收镜像构建与执行脚本
├── docker-compose.yml
└── .env.example
```

系统中不存在假接口、固定响应或未实现占位：前端始终通过 HTTP 调用真实裁决服务，
裁决全部由 `api/app` 中的规则与模型计算得出。
