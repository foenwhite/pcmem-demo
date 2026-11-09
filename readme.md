# PC-Mem Midterm Demo

A standalone local demo of PC-Mem's personal-file knowledge graph: a document
tree, real version chains, project ownership, an extracted concept graph, and
cited answers. It is **not** an agent framework and it does **not** modify the
`personal-agent` repository; it calls the same `sci_rag` ingest, graph, retrieval
and answer paths that the project's evaluation scripts use.

The Chinese edition is [readme_ZH.md](readme_ZH.md).

## Fast demo (no build, no API key)

If you only need something on screen quickly, use one of these:

1. **Watch the recording** — `recordings/pcmem-demo-live.mp4` (34 s, 1440×900,
   H.264, no audio). It shows the live page: node card, edge cards, a preset
   budget question, the real retrieval trace, the streamed answer with citations,
   and the source cards.
2. **Open the static pre-recorded site** — `pcmem-static-demo/` or
   `pcmem-static-demo.zip`:

   ```bash
   # macOS / Linux / WSL
   cd pcmem-static-demo
   python3 -m http.server 8780 --bind 127.0.0.1
   # http://127.0.0.1:8780/
   ```

   ```powershell
   # native Windows
   cd pcmem-static-demo
   py -m http.server 8780 --bind 127.0.0.1
   ```

   Double-clicking `pcmem-static-demo/index.html` also works (`file://`); the
   snapshot is local. It needs **no PostgreSQL, no model, no API key**. Its
   header says **STATIC · 静态预录演示 · 固定快照 · 不调用模型 · 无需 API Key**;
   the new **▶ 播放预录演示** button plays a scripted question/retrieval/answer.

The static version and the recording are the safe choice for a venue without a
model key or with a short time slot. The live build below is only needed when
you want to rebuild the graph or ask new questions against the real model.

## Where `personal-agent` must live

The live demo imports the engine from a **sibling** repository. It must be the
project root, not a copy of `src` and not nested inside the demo:

```text
workspace/
├── personal-agent/        ← the project repository root
│   ├── src/sci_rag/
│   ├── domain-personal/
│   ├── scripts/local_postgres.py
│   ├── pyproject.toml
│   └── .venv/             ← created by `uv sync`
└── pcmem-demo/            ← this repository
    ├── pcmem_demo/
    ├── web/
    └── ...
```

**Put `personal-agent` next to `pcmem-demo`, never inside `pcmem-demo`.**
The defaults are:

- `pcmem_demo/paths.py` → `../personal-agent/src`
- `run.sh` → `../personal-agent/.venv/bin/python`
- `pcmem_demo/cli.py` → `../personal-agent/scripts/local_postgres.py`
- domain ontology and prompts → `../personal-agent/domain-personal/`

If you cannot use the sibling layout, set both paths before launching:

```bash
# macOS / Linux / WSL
export PCMEM_DEMO_REPO=/absolute/path/to/personal-agent
export PCMEM_DEMO_PY=/absolute/path/to/personal-agent/.venv/bin/python
```

```powershell
# native Windows PowerShell
$env:PCMEM_DEMO_REPO = "C:\work\personal-agent"
$env:PCMEM_DEMO_PY   = "C:\work\personal-agent\.venv\Scripts\python.exe"
```

The portable bundle produced by `tools/package_bundle.sh` already places the
two trees as siblings; keep that layout when you unzip it.

## Folder map

| Path | What it does |
| --- | --- |
| `run.sh` | Launches the demo-local PostgreSQL (port 5544) and the HTTP server (port 8770) with the sibling venv. Bash only. |
| `pcmem_demo/` | Backend: paths, 0600 secret store, `sci_rag.Settings`, ingest → version replay → ownership → mentions → graph → optional communities → answers, DB views, stdlib HTTP/SSE, one asyncio loop, build jobs. |
| `web/` | Live UI: document tree, Canvas graph, node/edge cards, timeline, communities, ask panel, retrieval trace, build modal, settings. |
| `sample_corpus/` | Fixed synthetic corpus: 14 current documents, 7 formats, 4 folders, one real 3-revision chain; manifest and ordered project rules. |
| `tests/` | 14 offline tests; no DB or model. |
| `tools/` | `make_ontology.py` (sync ontology) and `package_bundle.sh` (portable bundle from a committed repo revision). |
| `recordings/` | Live demo MP4 + poster; no audio. |
| `pcmem-static-demo/` | Static snapshot fork with the scripted playback; no backend, model or key. Has its own README. |
| `pcmem-static-demo.zip` | Shippable static site. |
| `.state/` | Runtime only: API key (0600), demo PostgreSQL, build report. Not shipped. |
| `dist/` | Generated portable bundle. Not shipped. |
| `readme.md`, `readme_ZH.md` | This folder map and build guides, in English and Chinese. |
| `../personal-agent/` | Sibling engine repository; see the section above. |

## Live build

Common requirements:

- [uv](https://docs.astral.sh/uv/), Python 3.11–3.12 (uv can install Python).
- PostgreSQL 16–18 with the **pgvector** extension.
- An OpenAI-compatible chat endpoint. The demo uses the repository's offline
  `local-hash` vectors, so **no embedding API key** is needed.
- The `personal-agent` repository as a sibling (see above).

The launcher creates its own PostgreSQL cluster under `.state/pgdata` on port
5544 and does not touch the repository's `.env` or its default 5433 database.
Ports are configurable with `PCMEM_DEMO_PORT` and `PCMEM_DEMO_PG_PORT`.

### macOS (tested)

```bash
brew install uv postgresql@17 pgvector

# Keep the two repositories as siblings.
cd personal-agent
uv sync --extra openai       # dev dependencies include docx/xlsx parsers

cd ../pcmem-demo
./run.sh
# http://127.0.0.1:8770/
```

`run.sh` finds Homebrew's `initdb` and `pg_ctl` automatically. If yours is in a
non-standard place:

```bash
export PATH="$(brew --prefix postgresql@17)/bin:$PATH"
```

### Linux

Install `uv` and a PostgreSQL 16–18 server with pgvector. Package names vary by
distribution; on Ubuntu/Debian with the PGDG repository it is typically:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
sudo apt install postgresql-17 postgresql-17-pgvector
export PATH="/usr/lib/postgresql/17/bin:$PATH"
```

If your distribution does not package pgvector for that PostgreSQL major, use
conda-forge or PGDG:

```bash
# conda-forge example; `pixi` works the same way
conda install -c conda-forge "postgresql>=16,<19" pgvector
```

Make sure all four tools are on `PATH`:

```bash
initdb --version && pg_ctl --version && psql --version && createdb --version
```

Then keep `personal-agent` and `pcmem-demo` as siblings and run:

```bash
cd personal-agent
uv sync --extra openai

cd ../pcmem-demo
./run.sh
```

The demo cluster runs as your user (no `sudo`); only the package installation
needs root. Fedora and Arch package names differ (`postgresql-server`,
`postgresql`, `pgvector`), but the PATH check and launch commands are the same.

> Tested on macOS. The Linux path uses the same repository helper
> (`scripts/local_postgres.py`) and the same `uv sync`; the only likely variable
> is the PostgreSQL package name and the versioned `bin` directory.

### Windows

#### Recommended: WSL2 + Ubuntu

```powershell
wsl --install -d Ubuntu
```

Inside WSL, follow the Linux section. Put the two repositories under the WSL
home directory (for example `~/work/personal-agent` and `~/work/pcmem-demo`);
they must remain siblings. Start the demo from WSL and open
`http://127.0.0.1:8770/` in your Windows browser — WSL2 forwards localhost.

This avoids native pgvector build issues and is the least surprising route.

#### Native Windows (advanced)

`run.sh` is a Bash script, so native Windows uses the Python CLI directly. You
need PostgreSQL 16/17 **with pgvector** installed for that same major version;
the pgvector Windows binaries are the hard part. If they are unavailable, use
WSL2.

1. Install `uv`:

   ```powershell
   winget install --id=astral-sh.uv -e
   ```

2. Install PostgreSQL 16/17 (EDB installer or another distribution) plus
   pgvector. Add the versioned `bin` directory to `PATH`, for example
   `C:\Program Files\PostgreSQL\17\bin`, then verify:

   ```powershell
   initdb --version
   pg_ctl --version
   psql --version
   createdb --version
   ```

3. Put the repositories side by side, for example:

   ```text
   C:\work\personal-agent\
   C:\work\pcmem-demo\
   ```

4. Create the Python environment and run the demo:

   ```powershell
   cd C:\work\personal-agent
   uv sync --extra openai

   cd C:\work\pcmem-demo
   ..\personal-agent\.venv\Scripts\python.exe -m pcmem_demo.cli serve --port 8770
   ```

   Or activate the sibling venv and run the CLI with that interpreter:

   ```powershell
   $env:PCMEM_DEMO_REPO = "C:\work\personal-agent"
   C:\work\personal-agent\.venv\Scripts\Activate.ps1
   python -m pcmem_demo.cli serve --port 8770
   ```

   `PCMEM_DEMO_PY` is only used by the Bash `run.sh`; the Python CLI uses the
   interpreter it is started with.

The CLI runs the same `ensure_postgres()` helper: it finds `initdb`/`pg_ctl` on
`PATH` and creates the cluster under `.state\pgdata` on port 5544. It does not
need Docker. On native Windows the API key file is protected by the account's
NTFS ACL rather than POSIX `0600`; `.state` remains local and gitignored.

The static site and the MP4 work natively on Windows with no extra setup:

```powershell
cd C:\work\pcmem-demo\pcmem-static-demo
py -m http.server 8780 --bind 127.0.0.1
# or double-click index.html
```

### After launch

Open `http://127.0.0.1:8770/`, go to **模型设置**, enter the Base URL, API key,
answer model and extraction model, then **保存并测试连接**. Click **重建图谱**;
the first build takes roughly 2–3 minutes. Community summaries are optional.

## Static preview

```bash
# macOS / Linux / WSL
cd pcmem-static-demo
python3 -m http.server 8780 --bind 127.0.0.1
# http://127.0.0.1:8780/
```

The page makes no `/api/*` calls, no model calls, and contains no key. The
header says **STATIC · 静态预录演示 · 固定快照 · 不调用模型 · 无需 API Key**; the
live-only controls are disabled. The **▶ 播放预录演示** button is new to the
static version and is not in the live UI. See `pcmem-static-demo/README.md`.

## Live vs static

| | Live (`run.sh` → 8770) | Static (`pcmem-static-demo/` → 8780) |
| --- | --- | --- |
| Backend | Python + PostgreSQL + `sci_rag` | none |
| Model | real OpenAI-compatible endpoint | none |
| API key | required for build/ask | **not required** |
| Data | built from `sample_corpus/` | one fixed snapshot in `snapshot.js` |
| Ask | real retrieval and streamed answer | one preset playback |
| Claim | live demo | clearly labelled static, pre-recorded |

## Security

- The API key is stored only in `.state/secrets.json` with mode 0600. It is
  never returned to the browser, never written to logs, and never put in a URL.
- The server binds `127.0.0.1` by default; non-loopback hosts are refused unless
  `--allow-remote` is explicit. It has CSP, no CORS, and an Origin check.
- `pcmem-static-demo/` contains no secret and no backend.
- Do not ship `.state/` (key + local database) or `../personal-agent/.venv/`.

## Portable bundle

```bash
./tools/package_bundle.sh
# dist/pcmem-demo-bundle/
# dist/pcmem-demo-bundle.tar.gz
```

It copies this demo (excluding `.state`, `.git`, `dist`, `recordings`, caches)
and a slim source tree from a committed `personal-agent` revision
(`git archive HEAD`). The recipient still needs `uv`, PostgreSQL + pgvector and
a model key; see the generated `SETUP.md`. The bundle keeps the sibling layout.

## Recording

`recordings/pcmem-demo-live.mp4` is a page-level Chromium recording of the live
demo, encoded with ffmpeg: 34 s, 1440×900, H.264, **no audio**. macOS Screen
Recording permission was not available to the agent, so the recording covers
the page content (no desktop or browser chrome), not a desktop-window capture.
It uses the live backend and a real model; it is not the static mock.

## Tests

```bash
../personal-agent/.venv/bin/python -m unittest discover -s tests -v
```

14 offline tests pass. They do not need PostgreSQL or a model.

## Notes and limits

- The sample corpus is synthetic and is not a benchmark.
- The vector layer is the repository's offline `local-hash` (1024 dimensions),
  not Qwen3; the UI labels it honestly.
- The demo enables the LLM reranker for answer quality and leaves HyDE off by
  default (the switch is in the UI). These are demo choices, not benchmark
  defaults.
- Community summaries are optional and are skipped in the answer path whenever
  a retrieval scope is present, matching the repository's design.
- The live demo needs PostgreSQL; the static folder and the MP4 are the
  zero-dependency quick-demo paths.
