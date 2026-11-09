#!/usr/bin/env bash
# Assemble a portable demo bundle: the demo plus a slim personal-agent source
# tree taken from a committed revision (never the dirty working tree).
#
# Usage:
#   ./tools/package_bundle.sh            # writes dist/pcmem-demo-bundle(.tar.gz)
#   ./tools/package_bundle.sh /tmp/out   # choose the dist directory
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${PCMEM_DEMO_REPO:-$DEMO_DIR/../personal-agent}"
REPO="$(cd "$REPO" && pwd)"
DIST="${1:-$DEMO_DIR/dist}"
STAGE="$DIST/pcmem-demo-bundle"
COMMIT="$(git -C "$REPO" rev-parse --short HEAD)"

if [[ -n "$(git -C "$REPO" status --porcelain)" ]]; then
  echo "警告：personal-agent 工作区有未提交改动。"
  echo "bundle 使用 HEAD ($COMMIT)，不会带上这些改动。"
fi

rm -rf "$STAGE"
mkdir -p "$STAGE/pcmem-demo" "$STAGE/personal-agent"

# The demo itself: exclude runtime state, the API key, caches, and artifacts.
rsync -a \
  --exclude '.state/' \
  --exclude 'dist/' \
  --exclude 'recordings/' \
  --exclude '__pycache__/' \
  --exclude '.ruff_cache/' \
  --exclude '.DS_Store' \
  "$DEMO_DIR/" "$STAGE/pcmem-demo/"

# Only what the demo imports or executes. No .git, .venv, tests, docs, data,
# eval results, or the repository's own .env.
git -C "$REPO" archive --format=tar HEAD \
  src \
  domain \
  domain-personal \
  scripts/local_postgres.py \
  pyproject.toml \
  uv.lock \
  .python-version \
  LICENSE \
  THIRD-PARTY-NOTICES.md \
  AUTHORS.md \
  README.md \
  | tar -x -C "$STAGE/personal-agent"

cat > "$STAGE/SETUP.md" <<EOF
# PC-Mem demo bundle

This folder contains:

- \`pcmem-demo/\` — the live web UI, fixed sample corpus, tests, launcher, and the static pre-recorded site in pcmem-static-demo/.
- \`personal-agent/\` — a slim copy of the retrieval engine source at commit
  \`$COMMIT\`: \`src/sci_rag\`, the domain profile, the PostgreSQL helper, the
  lockfile, and the licenses. There is no \`.git\`, \`.venv\`, docs, tests, or data.

The demo imports \`sci_rag\` from \`personal-agent/src\` and starts its own
PostgreSQL cluster under \`pcmem-demo/.state/pgdata\`. It does not use the
repository's \`.env\` or its default database.

## Requirements

- macOS or Linux (the launcher is bash).
- [uv](https://docs.astral.sh/uv/) and Python 3.11–3.12 (uv can install Python).
- PostgreSQL 16–18 with the pgvector extension.
  - macOS: \`brew install postgresql@17 pgvector\`
  - Linux: install PostgreSQL 16+ and pgvector from your distribution or
    conda-forge, and make sure \`initdb\`, \`pg_ctl\`, \`psql\`, and \`createdb\`
    are on \`PATH\`.
- An OpenAI-compatible model endpoint. The demo's vector layer is the
  repository's offline \`local-hash\`, so no embedding key is required.

## Run

\`\`\`bash
cd personal-agent
uv sync --extra openai        # dev dependencies include docx/xlsx parsers

cd ../pcmem-demo
./run.sh
\`\`\`

Open <http://127.0.0.1:8770/>. In **模型设置**, enter the Base URL, API key,
answer model, and extraction model, then **保存并测试连接**. Click **重建图谱**
to build the demo corpus; the first build takes roughly 2–3 minutes, and
community summaries are optional (slower).

The demo writes only to \`pcmem-demo/.state/\`:

- \`secrets.json\` — the API key, mode 0600; never committed or returned to the
  browser.
- \`pgdata/\` — the demo's PostgreSQL cluster, port 5544.
- \`build_report.json\` — the last build stats.

No key or database is included in this bundle.

## Static preview (no model, no key)

The static, pre-recorded site is included:

```bash
cd pcmem-demo/pcmem-static-demo
python3 -m http.server 8780 --bind 127.0.0.1
# http://127.0.0.1:8780/
```

It makes no `/api/*` calls and needs no API key. The header labels it as a
static snapshot; the live-only controls are disabled there.

## Ports and troubleshooting

\`\`\`bash
PCMEM_DEMO_PORT=8771 PCMEM_DEMO_PG_PORT=5545 ./run.sh
\`\`\`

- \`找不到 PostgreSQL 的 initdb/pg_ctl\`: install PostgreSQL + pgvector, or add
  its \`bin\` directory to \`PATH\`.
- If \`uv\` is missing: \`brew install uv\` (macOS) or
  \`curl -LsSf https://astral.sh/uv/install.sh | sh\`.
- Stop the demo database: \`cd pcmem-demo && ../personal-agent/.venv/bin/python -m pcmem_demo.cli pg-stop\`.
- Remove all local state (key + demo DB): stop the service, then delete
  \`pcmem-demo/.state/\`.

## Provenance

\`personal-agent\` is the project repository at commit \`$COMMIT\`. The demo is
an independent UI outside that repository and does not modify it. See
\`personal-agent/LICENSE\` and \`personal-agent/THIRD-PARTY-NOTICES.md\`.
EOF

tar -C "$DIST" -czf "$DIST/pcmem-demo-bundle.tar.gz" pcmem-demo-bundle
echo "bundle: $STAGE"
echo "archive: $DIST/pcmem-demo-bundle.tar.gz"
du -sh "$STAGE" "$DIST/pcmem-demo-bundle.tar.gz"
