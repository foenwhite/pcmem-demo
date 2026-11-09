# PC-Mem 期中演示 · Web UI

一个**独立的、只在本机跑**的演示界面，用来在期中检查里展示 PC-Mem 的
文件空间知识图谱：文件树、真实版本链、项目归属、图谱抽取、带引用的回答。

它**不是** GeneralAgent 的替代品，也**没有**引入任何 Agent 框架。界面背后的
建库、抽取、检索和回答都调用 `../personal-agent` 仓库里已有的
`ingest_entries` / `extract_graph` / `classify_documents` / `build_mentions` /
`build_communities` / `Retriever` / `AnswerEngine` 路径——和评测脚本走的是同一套代码。
本目录不修改仓库的任何文件。

```
浏览器  ──HTTP──▶  demo server (stdlib)  ──Python 调用──▶  personal-agent/src/sci_rag
  │                     │                                    │
  │                     └── .state/secrets.json (0600)       └── PostgreSQL + pgvector
  └── 图谱 / 问答 / 版本链 / 构建进度                          (demo 专用实例，端口 5544)
```

## 目录结构（每个文件夹做什么）

| 路径 | 作用 |
| --- | --- |
| `run.sh` | 启动入口：先起 demo 专用 PostgreSQL（端口 5544），再起 stdlib HTTP 服务（`127.0.0.1:8770`），使用 `../personal-agent/.venv`。 |
| `pcmem_demo/` | Python 后端。`paths.py` 指向同级仓库；`secrets.py` 管理 0600 密钥；`config.py` 构造 `sci_rag.Settings`；`pipeline.py` 跑 ingest → 版本重放 → 项目归属 → 引用 → 图谱抽取 → 可选社区 → 回答；`views.py` 读库投影；`server.py` 提供 API/SSE；`runtime.py` 持有唯一 asyncio loop；`jobs.py` 记录构建任务。 |
| `web/` | Live UI：资料树、Canvas 力导图、节点/边卡片、时间线、社区摘要、问答面板、检索轨迹、构建面板、模型设置。 |
| `sample_corpus/` | 固定合成语料：14 个当前文档、7 种格式、4 个顶层目录、1 条 3 修订版本链。`manifest.json` 是元数据，`project_rules.yaml` 是有序 glob 归属规则，`_history/` 是被真实 ingest 路径重放的旧修订。 |
| `tests/` | 离线自测：语料、本体、项目规则、密钥存储、静态资源、白底主题；不连数据库、不调模型。 |
| `tools/` | `make_ontology.py` 从 `../personal-agent/domain-personal/domain.yaml` 生成 `pcmem_demo/ontology.json`；`package_bundle.sh` 打包可搬运的 demo + 精简仓库源码。 |
| `recordings/` | `pcmem-demo-live.mp4`（34 秒、1440×900、H.264、无音轨）和封面帧；录的是 live 页面上的节点/边卡片与真实模型预算问答。 |
| `pcmem-static-demo/` | 静态预录站点：固定快照 + 写死的问答动画，无后端、无模型、无 API Key；页面顶部有 STATIC 横幅，新增「▶ 播放预录演示」按钮。它有自己的 README。 |
| `pcmem-static-demo.zip` | 可直接分发的静态站点压缩包（64 KB），解压后 `python3 -m http.server` 即可看。 |
| `.state/` | 运行时目录：`secrets.json`（0600 密钥）、`pgdata/`（demo PostgreSQL）、`build_report.json`。**不要 ship**。 |
| `dist/` | `tools/package_bundle.sh` 生成的便携包（`pcmem-demo-bundle/` + `.tar.gz`），包含 demo 和精简版 `personal-agent`。 |
| `readme.md` / `readme_ZH.md` | 英文/中文说明，也就是本文件和目录表。 |
| `../personal-agent/` | 同级依赖，不在本目录内：提供 `src/sci_rag`、`domain-personal`、`scripts/local_postgres.py`、`pyproject.toml`、`uv.lock` 和 venv。 |

## 静态预录版（无后端 / 无模型 / 无 Key）

静态版现在也在本目录内：`pcmem-static-demo/`。它是当前 UI 的一次性数据快照
（146 节点 / 202 关系 / 6 社区）加一段预录动画；版头明确标着
「静态预录演示 · 固定快照 · 不调用模型 · 无需 API Key」，live-only 的
重建、模型设置、提问按钮都已禁用/锁定。

```bash
cd pcmem-static-demo
python3 -m http.server 8780 --bind 127.0.0.1
# http://127.0.0.1:8780/
```

新增的「▶ 播放预录演示」按钮会播放：固定问题 → 预录四层轨迹 → 逐字回答
`48 万元 [1]` → 引用/来源 → 图谱高亮 → 「预录结束」。没有 `/api/*` 请求，
没有模型端点，不需要 Key。分发时也可以直接用 `pcmem-static-demo.zip`。

## 快速开始


要求：

- Python 3.11+；`personal-agent/.venv` 已经建好（`uv sync --extra openai`，
  需要 `openai` 包来访问 OpenAI 兼容端点；docx/xlsx 解析依赖 dev 组）。
- PostgreSQL 16–18 + pgvector。macOS 可以用：

  ```bash
  brew install postgresql@17 pgvector
  ```

  `run.sh` 会自动在 `PATH` 里找 Homebrew / Postgres.app 的 `initdb`、`pg_ctl`。
  Linux 上只要 `initdb`、`pg_ctl`、`psql` 在 `PATH` 里即可。
- 一个 OpenAI 兼容的模型端点（DeepSeek、SiliconFlow、OpenAI、自建 vLLM 等）。

启动：

```bash
./run.sh
# PC-Mem demo: http://127.0.0.1:8770/
```

第一次启动时，演示会在 `.state/pgdata/` 建一个**独立的** PostgreSQL 实例
（127.0.0.1:5544，库名 `pcmem_demo`），不会碰仓库默认的 5433。随后打开浏览器：

1. 右上角「模型设置」：填 Base URL、API Key、回答模型、抽取模型；点
   「保存并测试连接」。
2. 如果 `.state/` 里已经有构建好的演示数据库（本机交付时通常有），直接看图谱、
   提问题即可。
3. 想现场重建：点「重建图谱」，面板会显示真实的 ingest、版本链、项目归属、
   引用、抽取阶段。全量约 2–3 分钟，取决于模型速度。社区摘要默认跳过
   （勾选后每个社区一次模型调用，最多再等 120 秒）。

停止：`Ctrl-C`。只停 Web 服务、保留数据库可以；彻底停数据库：

```bash
../personal-agent/.venv/bin/python -m pcmem_demo.cli pg-stop
```

## 演示语料

`sample_corpus/` 是一个固定的、仿 Victoria_Subset 的目录树：**14 个当前文档、
7 种格式、4 个顶层目录、3 个修订版本**。人名、单位、数据均为虚构，文本以
CC0 释放；邮件和检查点表标为 `restricted`，专门用来演示外发权限门。

```
sample_corpus/
├── 远山项目/
│   ├── 立项书.md                ← 现行 v2；同一路径还重放了 2 个历史修订
│   ├── 中期评审报告.docx
│   ├── 检查点精度表.xlsx        (restricted)
│   ├── 点云拼接工具.py
│   ├── 测量数据集-v3-说明.md
│   └── 技术路线变更决定.md
├── 河图项目/
│   ├── 立项书.md
│   ├── 古籍地图索引说明.md
│   └── OCR试点抽样.csv
├── 会议/
│   ├── 2026-03-12 远山中期评审纪要.txt
│   ├── 2026-04-02 双周会纪要.md
│   └── 2026-03-18 远山矿业预算确认.eml   (restricted)
├── 个人/
│   ├── 周岚工作记录.md
│   └── 林舟简介.md
├── _history/                    ← 版本重放用的旧文本，不直接入库
│   ├── 立项书-v0.md
│   └── 立项书-v1.md
├── manifest.json                ← 标题、日期、许可、人工项目、版本历史
└── project_rules.yaml           ← 有序 glob 规则（规则归属）
```

**版本链是真的。** 建库时把 `_history/立项书-v0.md` 复制到
`远山项目/立项书.md` 入库，再依次换成 v1、v2 入库。三次都走
`sci_rag.ingest.ingest_entries` 的同路径修订逻辑，所以数据库里是
`version_seq = 1, 2, 3` 的一条链，`is_current` 只有最后一条。旧版本保留全文，
但向量、关键词、图谱、社区、引用、读取、导出全部排除——演示里问「最早的
测绘合作方」会拒答，点「在已失效版本中查找」才看到北辰测绘。

**项目归属三级制。** `manifest.json` 里带 `project:` 的文档是人工归属；
`project_rules.yaml` 按路径给「远山项目/**」「河图项目/**」打规则归属；
会议纪要和人物记录没有归属，交给 `classify_documents` 的模型推断（要求给出
≥0.5 的置信度和原文引用）。受限文档不会外发给模型，所以它们会显示
「外发跳过」，这是仓库的默认姿态。

**引用边。** 正文里的 `[[文档标题]]` 由 `sci_rag.relate.mentions` 解析成
`document_citations`（11 条全部落到了当前文档）。时间线页和文档详情里都能看到。

## 页面在展示什么

- **概念图谱**：`kg_entities` / `kg_relationships`，12 类实体、11 类关系，按
  类型着色、按度数定大小。点击节点打开富卡片：类型、项目、连接数、文档数、
  段落数、来源文档、逐条关系、带原文高亮的段落证据。点击**边**（或卡片里的
  关系行）打开边卡片：有向类型、两端实体、置信度、原文证据与来源文档。
  节点命中优先于边，因此节点与边重叠时点到的是节点。
- **提问**：走 `RagService.answer_stream`。检索轨迹显示每一层的候选数、耗时、
  状态；来源卡片标出这一条是被哪几层找到的。回答里的 `[n]` 可以点，落到来源。
- **版本与时间线**：当前文档按日期排列，版本链展开成「修订 1/2/3」，失效修订
  划线。修订序号是入库顺序，不是标题里的 v1/v2。
- **社区摘要**：抽取完成后 `build_communities` 生成的聚合描述（可选，见构建
  面板的勾选框）。注意：回答路径总会带上 `exclude_retracted` 这一范围限制，
  而仓库的社区层在**任何**范围过滤下都会关闭，所以回答轨迹里始终显示
  `社区 跳过`；社区页只用于浏览聚合描述。
- **构建面板**：`POST /api/build` 启动后台任务，轮询状态；日志里能看到真实阶段
  和「丢弃 N 条」这类校验计数。

### 演示问题（界面里的示例）

| 问题 | 期望 |
| --- | --- |
| 远山项目的预算总额是多少？ | 48 万元，引用现行立项书 |
| 河图项目是否使用激光雷达？ | 不使用；引用河图立项书的技术路线 |
| 周岚同时参与了哪些项目？ | 远山 + 河图；引用双周会纪要 |
| 远山项目现在的技术路线是什么？ | GNSS + 激光定位 + SLAM 回环检测 |
| 远山项目最早的测绘合作方是哪家公司？ | 现行资料未提供；点「在已失效版本中查找」看到北辰测绘（v0/v1） |
| 2026 年 3 月远山中期评审的结论是什么？ | 通过中期检查，建议补充回环检测对照实验 |
| 远山矿业预算确认邮件的发件人是谁？ | 勾选「仅外发资料」时拒答（邮件是 restricted）；取消勾选后答张工 |

## 密钥与安全

- 浏览器把 Key 只发到 `127.0.0.1` 的本地服务；服务写入
  `.state/secrets.json`，权限强制 `0600`，目录 `0700`。
- 之后所有 `GET` 只返回 `has_key: true` 和端点/模型名，**不回传任何密钥字符**；
  密钥输入框永远为空，留空保存表示保持原 Key。
- 密钥不写入 URL、不写日志、不放进子进程环境；异常信息用 `redact()` 去掉
  `sk-…` 形态的字符串。
- 不引入任何外部 JS/CSS/字体；有 CSP、`X-Frame-Options: DENY`、`nosniff`；
  只绑定 `127.0.0.1`，除非显式 `--allow-remote`。
- 只接受 JSON POST，并检查 `Origin`；没有 CORS 头，浏览器跨站表单无法触发。
- `.state/` 在 `.gitignore` 里。演示库和密钥都不进版本控制。
- **这不是一个多用户服务**：没有 TLS、没有用户认证、没有速率限制。要暴露到
  局域网/公网，请自己加反向代理、TLS 和认证；不要把演示服务直接暴露。
- 数据库密钥是明文落在 0600 文件里，依赖操作系统账户权限，不是加密存储。

## 复用仓库的哪些路径

| 阶段 | 调用 |
| --- | --- |
| 入库 / 解析 | `sci_rag.ingest.ingest_entries` + `CorpusEntry`（与 `scripts/run_personal_demo.py` 相同） |
| 版本链 | 同路径三次 `ingest_entries`，由 `ingesters` 的 identity/version 逻辑落库 |
| 项目归属 | `sci_rag.projects.load_project_rules` / `assign_project` / `classify_documents` |
| 引用 | `sci_rag.relate.mentions.build_mentions` |
| 图谱抽取 | `sci_rag.graph.extract_graph`（domain-personal 的 12/11 本体） |
| 社区 | `sci_rag.graph.build_communities` |
| 检索 | `sci_rag.retrieve.Retriever`（向量/关键词/图谱/社区/HyDE，RRF 融合） |
| 回答 | `sci_rag.answer.AnswerEngine` / `RagService.answer_stream` |
| 权限 | `RetrievalScope` + `license_classes=['public','open_commercial']`（默认开） |

本 demo 的唯一“调整”：

- **向量层用 `local-hash`**（1024 维，离线）而不是仓库默认的 Qwen3。原因是
  演示不应要求下载 1.2 GB 模型或第二个 embedding key；界面和 README 都明说
  它是词法哈希，不装作语义向量。
- **答案路径打开 LLM 精排（`include_rerank=True`）**，HyDE 默认关（可在界面
  打开）。local-hash 下没有精排时，精确关键词命中会被“多路都沾一点”的候选压下去；
  这是演示里实际观察到的现象，精排把河图技术路线、远山预算这类决定性段落拉回
  第一位。HyDE 保留为开关，打开会多一次模型调用（约 10 秒）。
- 社区摘要可选生成；回答路径按仓库设计始终跳过社区层（它带 retracted
  排除过滤），界面上显示原因。预置数据库里保留了 6 个社区摘要，重建时不勾选
  社区会清空它们。

没有修改 `personal-agent/` 的任何文件。如果以后需要给仓库加 provider/端点，
按项目约定另开一个 git worktree / 分支，不要在这个 demo 里偷偷改仓库。

## 参考架构

- `pcmem_demo/paths.py`：路径、demo 数据库 URL、仓库 `src` 注入。
- `pcmem_demo/secrets.py`：0600 密钥存储、校验、脱敏。
- `pcmem_demo/config.py`：从密钥存储构造 `sci_rag.Settings`，显式覆盖环境变量。
- `pcmem_demo/pipeline.py`：reset → ingest → 版本重放 → 归属 → 引用 → 抽取 →
  社区 → `ask_stream` / 版本诊断。
- `pcmem_demo/views.py`：文档、版本链、图谱、证据的只读投影。
- `pcmem_demo/server.py`：stdlib HTTP、SSE 流式回答、静态资源、CSP。
- `pcmem_demo/runtime.py`：一个专属 asyncio loop（asyncpg 池绑定 loop）。
- `pcmem_demo/jobs.py`：单构建任务的状态与日志。
- `web/`：无框架的 HTML/CSS/JS；Canvas 力导图，无外部依赖。
- `tools/make_ontology.py`：从 `personal-agent/domain-personal/domain.yaml`
  生成 `pcmem_demo/ontology.json`；换本体时重跑。

## 已知限制与诚实声明

- 语料是合成的（14 个文档，6 种格式 + email），**不是**评测集，不能拿这里的
  数字宣称图谱增益。
- `local-hash` 向量是词法的；语义检索能力请以仓库的 Qwen3 配置为准。
- 演示为了回答质量打开了精排；这不是 benchmark 的默认配置。
- 没有上传、OCR、音频/日历解析；文件树是固定的。
- 构建会清空 demo 库并重放；旧版本仍在库里，但不会进入任何读取路径。
- 预置数据库来自一次真实 SiliconFlow 端点的构建（含 6 个社区摘要）；重建时用的
  端点/模型可以在构建报告里看到。不勾选社区会清空已有社区。
- 演示运行后可能在 `.state/` 保存一次端点配置，便于直接演示；在「模型设置」里
  可以替换或「清除密钥」。该目录不会进入版本控制；密钥文件权限为 0600。
- 本页面只演示 PC-Mem 的结构与证据链，不复刻 5 分钟汇报里的全部数字。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `找不到 PostgreSQL 的 initdb/pg_ctl` | 安装 `postgresql@17` + `pgvector`，确认 bin 在 PATH；或装 Postgres.app |
| `端口 5544 被占用` | 设 `PCMEM_DEMO_PG_PORT=5545` 后重启；`.state/pgdata` 会沿用 |
| 模型测试 401/403 | 检查 Base URL 是否以 `/v1` 结尾、模型名是否在该端点可用 |
| 回答很慢 | 关闭 HyDE（默认已关）；精排约 2–3 秒；首次调用还有网络冷启动 |
| 问答里只有公开文档 | 「仅外发资料」默认勾选，受限的邮件/检查点表被排除；取消勾选可看全部 |
| 想清掉演示状态 | 停服务后删 `pcmem-demo/.state/`（会删密钥和 demo 数据库） |

## 自测

不连数据库、不调模型的自测（语料、本体、绝对路径、密钥存储、前端无外链）：

```bash
../personal-agent/.venv/bin/python -m unittest discover -s tests -v
```

14 项全部通过。CLI 也可以直接跑同一套建库/问答路径：

```bash
../personal-agent/.venv/bin/python -m pcmem_demo.cli build --with-communities
../personal-agent/.venv/bin/python -m pcmem_demo.cli ask "远山项目的预算总额是多少？" --external-only
```


## 录屏

`recordings/pcmem-demo-live.mp4`（34 秒，1440×900，H.264，无音轨）是对
运行中的 live demo 的页面级录屏：节点卡片、边卡片、预设预算问题与真实模型回答。
因为 macOS 没有给终端 Screen Recording 权限，系统级 `screencapture`/`ffmpeg`
不可用，这段视频用 Chromium 的 CDP page screencast 录制（画面只有页面内容，
没有浏览器工具栏或桌面）。`pcmem-demo-poster.jpg` 是封面帧。

这不是静态版；静态预录版在同目录的 `pcmem-static-demo/`，页面顶部有明确标识。
