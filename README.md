# 包装放行台（Release Desk）

面向包装印刷放行环节的真实联调系统。解决的问题：**配方原料成分与同组共线接触信息
常被分开核对**，复核员可能只看到原料里没有目标物，就放过一条实际不成立的“不含”声明。
本系统要求浏览器把每行原料的「直接成分勾选」与「同组共线接触标记」一并提交，由后端
按固定规则联合裁决。

在放行台旁还并排设有两个**独立模块**：换线残留推演（生产批次序列与清洁边界）与
**批次用料追溯台**（物料批次及其投料关系图，供应商通报某原料批次过敏原污染后，
快速追溯所有直接使用与间接影响的中间料/成品批次）。三个模块各自管理状态、互不共享。

- 后端：Python 3.12 · FastAPI · Pydantic
- 前端：TypeScript · React 18 · Vite
- 测试：pytest（裁决、比较、换线与追溯及 HTTP）、Vitest + Testing Library（组件与状态流）、
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
- 出现未定义的额外字段（如原料行的 `contains_gluten`，或请求/方案层的 `snapshot_id`；
  各层模型均 `extra=forbid`）。

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

### 前后方案影响比较 `POST /api/compare`

复核员替换原料或调整共线信息后，可比较改动对拟印刷声明的影响。页面先完成一次
正常裁决并把当前配方与声明**设为对照**（快照深拷贝保存，后续编辑不会反向污染；
未设对照时“比较改动”按钮不可用），编辑同一表格后点击“比较改动”：请求同时提交
对照方案与现方案，后端对两侧**分别复用同一校验与裁决函数**，再按声明对比。

```json
{
  "baseline": { "ingredients": [/* 对照方案配方行 */], "claims": ["gluten_free"] },
  "current": { "ingredients": [/* 现方案配方行 */], "claims": ["gluten_free"] }
}
```

响应（HTTP 200）：

```json
{
  "baseline": { "printable": true, "rows": [], "verdicts": [] },
  "current": { "printable": false, "rows": [], "verdicts": [] },
  "comparisons": [
    {
      "claim": "gluten_free",
      "status": "newly_blocked",
      "baseline_allowed": true,
      "current_allowed": false,
      "new_blockers": [
        { "row_index": 0, "ingredient_name": "燕麦粉", "target": "wheat", "source": "contact" }
      ],
      "resolved_blockers": []
    }
  ]
}
```

- `baseline` / `current`：两侧各自的完整裁决结果（结构与 `/api/evaluate` 响应一致）。
- `comparisons`：只包含**两侧都选择**的声明（按对照方案顺序），逐条给出三态之一——
  `newly_blocked`（新受阻）、`resolved`（已解除）、`unchanged`（未变化）。仅一侧选择
  的声明不参与三态对比：取消一条声明不等于该声明“放行”，原本受阻的声明取消勾选后
  不会被报成“已解除”。
- `new_blockers` / `resolved_blockers` 为只存在于一侧的阻断证据：先按原料名做最长公共
  子序列对齐两侧原料行，再在配对行之间按目标项 + 来源求差集。因此在前面插入/删除无关
  原料（行号整体平移）不会让同一证据同时显示为新增与解除，原料改名也不产生伪差异。
- 任一方案字段非法时同样返回 422 字段级错误（方案层、请求层与原料行均
  `extra=forbid`，未定义字段如 `baseline.snapshot_id` 也会被拒绝），`loc` 以
  `baseline` / `current` 前缀定位到对应方案
  （如 `body.current.ingredients.0.contact_wheat`），且不产生任何比较结果；前端连接
  失败时保留对照快照与编辑内容，可直接重试。

### 换线残留推演 `POST /api/changeover`

多款产品共用生产线时，复核员在排产前识别**上一批残留会否带入后续产品**。以
“生产批次序列”为核心对象：用户按生产顺序录入**至少两个**批次的名称和五类过敏原
直接成分，并在每对相邻批次之间选择清洁方式——**未清洁**、**全部清洁**或**局部清洁**
（指定已验证清除的目标）。提交后逐批查看进入残留、前序批次带入物与离开残留；
调整批次顺序（上移/下移）后可重新推演。

```json
{
  "batches": [
    {
      "name": "花生酱批次A",
      "contains_milk": false,
      "contains_peanut": true,
      "contains_wheat": false,
      "contains_barley": false,
      "contains_rye": false
    },
    {
      "name": "燕麦批次B",
      "contains_milk": false,
      "contains_peanut": false,
      "contains_wheat": false,
      "contains_barley": false,
      "contains_rye": false
    }
  ],
  "boundaries": [{ "cleaned": false }]
}
```

- `batches`：按生产顺序排列的批次，**至少两个**；每批只有五类**必填布尔**直接成分
  标记（无共线接触标记），名称去空白后非空且序列内不得重复。
- `boundaries`：相邻批次间的清洁标记，长度固定为 `len(batches) - 1`，
  `boundaries[i]` 位于第 `i+1` 批与第 `i+2` 批之间。每条边界三选一：
  - **未清洁**：`{"cleaned": false}`，上一批离开残留原样成为下一批进入残留；
  - **全部清洁**：`{"cleaned": true}`，下一批开始前清空全部残留；
  - **局部清洁**：`{"cleaned": false, "cleared_targets": ["peanut"]}`，
    进入下一批前**仅移除** `cleared_targets` 中列出的已验证清除目标，保留项继续
    携带最近来源批次。该字段缺省时，仅有 `cleaned` 布尔的旧请求保持原有
    全清/不清语义（向后兼容）。

推演规则（固定，代码即规则）：

- **全部清洁**（`cleaned=true`）在下一批开始前清空全部残留，下一批进入残留为空；
  **未清洁**时上一批离开残留原样成为下一批进入残留；**局部清洁**
  （`cleaned=false` + `cleared_targets`）仅移除指定目标，其余目标继续携带。
- **离开残留 = 进入残留 ∪ 本批直接成分**（按目标项求并集）。
- **前序批次带入物仅取本批未直接含有的进入残留**：进入残留中与本批直接成分同目标的
  项不计入带入，直接成分不会误报为“前序带入”；但离开残留中该目标项的**最近来源
  批次**会刷新为本批。
- 每个残留项都携带 `source_batch_index` / `source_batch_name`，始终指向**最近来源
  批次**（目标项在某批直接成分中再次出现即刷新）。

响应（HTTP 200）：

```json
{
  "batches": [
    {
      "batch_index": 0,
      "name": "花生酱批次A",
      "direct_ingredients": ["peanut"],
      "incoming_residue": [],
      "carried_over": [],
      "outgoing_residue": [
        { "target": "peanut", "source_batch_index": 0, "source_batch_name": "花生酱批次A" }
      ],
      "cleaned_before": null
    },
    {
      "batch_index": 1,
      "name": "燕麦批次B",
      "direct_ingredients": [],
      "incoming_residue": [
        { "target": "peanut", "source_batch_index": 0, "source_batch_name": "花生酱批次A" }
      ],
      "carried_over": [
        { "target": "peanut", "source_batch_index": 0, "source_batch_name": "花生酱批次A" }
      ],
      "outgoing_residue": [
        { "target": "peanut", "source_batch_index": 0, "source_batch_name": "花生酱批次A" }
      ],
      "cleaned_before": false
    }
  ],
  "boundaries": [
    {
      "boundary_index": 0,
      "cleaned": false,
      "residue_cleared": false,
      "cleared_targets": []
    }
  ]
}
```

边界结果中的 `cleared_targets` 用于**确认该边界实际执行的清除项**（固定目标顺序）：

- 未清洁：`[]`，`residue_cleared=false`；
- 全部清洁：五类全列 `["milk","peanut","wheat","barley","rye"]`，`residue_cleared=true`；
- 局部清洁：按顺序回显指定的已清除目标（即使某项目标不在上一批离开残留中，
  清洁验证仍被确认），`residue_cleared=false`。

局部清洁示例：批次 A 同时含牛奶与花生，边界 `{"cleaned": false,
"cleared_targets": ["peanut"]}` 后，批次 B 的进入残留只含牛奶（来源仍为 A），
边界结果回显 `cleared_targets=["peanut"]`。

非法输入同样返回 FastAPI 标准 422 `detail` 列表、**不产生任何推演结果**，`loc`
定位到具体批次或边界：

- 批次数量不足：`body.batches`；
- 名称空白：`body.batches.0.name`；名称重复：每个重复批次各自定位到其 `name`；
- 清洁边界缺失或长度不等于批次数减一：`body.boundaries`；
- 某条边界的 `cleaned` 缺失/为 `null`/非布尔：`body.boundaries.0.cleaned`；
- 局部清洁的 `cleared_targets` 为空列表：`body.boundaries.0.cleared_targets`；
- `cleared_targets` 含重复项，或与 `cleaned=true` 冲突（全部清洁不得再指定目标）：
  `body.boundaries.0.cleared_targets`；取值超出五类范围/非字符串：
  Pydantic 定位到具体项 `body.boundaries.0.cleared_targets.0`；
- 成分标记缺失/为 `null`/非布尔：如 `body.batches.1.contains_milk`；
- 未定义的额外字段（批次层/边界层/请求层均 `extra=forbid`）按字段定位拒绝。

前端在放行台旁以**独立模块**呈现，模块自管批次序列与清洁边界状态，不与放行台的
配方/裁决/对照快照共享状态；每条边界以未清洁/全部清洁/局部清洁单选呈现，局部清洁
时勾选已验证清除目标并在边界结果中确认实际清除项；422 或前端即时校验失败时保留
全部批次与清洁选择并就地提示，修正后可直接再次提交。

### 批次用料追溯 `POST /api/trace`

供应商通报某原料批次存在过敏原污染后，质量人员需要迅速找出所有使用它的中间料和
成品批次。追溯台以**物料批次及其投料关系**为核心对象：用户在批次台账中录入每个批次的
批次编号、物料名称与批次类型（`raw_material` 原料 / `intermediate` 中间料 /
`finished_good` 成品），再录入若干条“来源批次投入目标批次”的投料关系（方向固定
`from_code → to_code`，关系按**录入顺序**获得稳定的关系序号 0、1、2…），最后选定一个
污染源批次编号发起追溯。

```json
{
  "batches": [
    {"code": "RAW-1", "material_name": "花生原料", "batch_type": "raw_material"},
    {"code": "INT-1", "material_name": "花生酱中间料", "batch_type": "intermediate"},
    {"code": "FG-1", "material_name": "花生酥成品", "batch_type": "finished_good"}
  ],
  "relations": [
    {"from_code": "RAW-1", "to_code": "INT-1"},
    {"from_code": "INT-1", "to_code": "FG-1"}
  ],
  "source_code": "RAW-1"
}
```

追溯规则（固定，代码即规则）：

- 后端接收**完整关系图与污染源**，先校验引用与成环，再以**录入顺序稳定遍历**
  （邻接按关系录入序号排列的 BFS），**只返回可从污染源沿投料方向到达的批次**；
  与污染源不连通、或只在其上游的批次一律不返回，污染源本身层级为 0 且不计入结果。
- 结果按**传播层级**分组：第 1 层为直接使用污染源的批次，第 2 层及以后为间接影响
  批次（无空层级）；同层按首次到达顺序（即关系录入顺序）稳定排列。
- 为每个受影响批次还原**最短投料路径**。同一批次经多条路径到达时，选择**层级最少
  （跳数最少）且关系序号序列字典序最小**的路径——例如菱形汇聚 `R→I1, R→I2, I1→F,
  I2→F` 中成品 F 的两条等长路径关系序列为 `[0,2]` 与 `[1,3]`，取字典序更小的
  `[0,2]`（经 I1）。路径逐跳回显 `relation_index` 与 `from_code/to_code`。

响应（HTTP 200）：

```json
{
  "source_code": "RAW-1",
  "source_material_name": "花生原料",
  "source_batch_type": "raw_material",
  "affected_count": 2,
  "levels": [
    {"level": 1, "batches": [
      {"code": "INT-1", "material_name": "花生酱中间料", "batch_type": "intermediate",
       "level": 1, "path_codes": ["RAW-1", "INT-1"],
       "path_relation_indices": [0],
       "path_steps": [{"relation_index": 0, "from_code": "RAW-1", "to_code": "INT-1"}]}
    ]},
    {"level": 2, "batches": [
      {"code": "FG-1", "material_name": "花生酥成品", "batch_type": "finished_good",
       "level": 2, "path_codes": ["RAW-1", "INT-1", "FG-1"],
       "path_relation_indices": [0, 1],
       "path_steps": [
         {"relation_index": 0, "from_code": "RAW-1", "to_code": "INT-1"},
         {"relation_index": 1, "from_code": "INT-1", "to_code": "FG-1"}]}
    ]}
  ],
  "affected_batches": [/* 与 levels 内容一致的扁平列表，按层级、层内首次到达顺序 */]
}
```

非法输入同样返回 FastAPI 标准 422 `detail` 列表、**不产生任何追溯结果**，`loc`
精确定位到具体批次或关系：

- 批次台账为空：`body.batches`；
- 批次编号/物料名称空白：`body.batches.0.code` / `body.batches.0.material_name`；
- 未知批次类型：`body.batches.0.batch_type`（仅允许三类枚举）；
- 批次编号重复：每个参与重复的批次（含首次出现者）各自定位到其 `code`；
- 关系端点在台账中不存在：`body.relations.0.from_code` / `body.relations.0.to_code`；
- 自引用（来源与目标为同一批次）：定位到 `body.relations.0.to_code`；
- 关系成环：每条处于有向环上的关系各自定位到其 `to_code`（即使环与污染源不连通，
  整张图仍被拒绝，不产生结果）；环的“出口”关系不在环上、不被标记；
- 污染源编号在台账中不存在：`body.source_code`；
- 未定义的额外字段（批次层/关系层/请求层均 `extra=forbid`）按字段定位拒绝。

前端追溯台在放行台旁以**独立模块**呈现，模块自管批次台账、投料关系与污染源状态，
不与放行台/比较/换线模块共享。422 或前端即时校验失败时**保留全部草稿**（台账、
关系、污染源）并就地提示，修正后可直接再次发起；任何编辑都会立即清除与当前输入
不一致的旧结果（在途响应即使成功或返回 422 也会被作废），等待重新追溯。

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

1. 后端 `pytest`（裁决规则、方案比较、换线推演与批次追溯及 422 字段级错误）；
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
│   │   ├── compare.py   # 前后方案比较：复用 evaluate，按声明三态对比证据差集
│   │   ├── changeover.py # 换线残留推演：批次序列、清洁归零、并集与最近来源
│   │   ├── traceability.py # 批次用料追溯：引用/成环校验、稳定遍历、最短投料路径
│   │   └── main.py      # 路由、CORS、健康检查
│   └── tests/           # pytest：规则矩阵 + HTTP 422 契约 + 方案比较 + 残留推演 + 批次追溯
├── web/                 # React + Vite 前端
│   ├── src/
│   │   ├── types.ts            # 与后端一一对应的枚举、类型、空行工厂
│   │   ├── api.ts              # 真实 fetch 调用与 422 字段错误映射
│   │   ├── App.tsx             # 放行台 + 换线推演 + 批次追溯三个并排独立模块
│   │   └── components/         # 配方表/声明选择/证据面板/比较面板/换线模块/追溯模块/字段错误
│   ├── e2e/*.spec.ts           # Playwright 真实联调端到端（裁决 + 比较 + 残留推演 + 批次追溯）
│   └── src/**/*.test.ts(x)     # Vitest
├── verify/              # 一次性验收镜像构建与执行脚本
├── docker-compose.yml
└── .env.example
```

系统中不存在假接口、固定响应或未实现占位：前端始终通过 HTTP 调用真实裁决服务，
裁决全部由 `api/app` 中的规则与模型计算得出。
