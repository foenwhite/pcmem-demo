#!/usr/bin/env bash
# Start the demo with the repository's own virtualenv and a demo-local
# PostgreSQL cluster. Nothing is installed and no repository file is edited.
set -euo pipefail
cd "$(dirname "$0")"

REPO="${PCMEM_DEMO_REPO:-../personal-agent}"
PY="${PCMEM_DEMO_PY:-$REPO/.venv/bin/python}"

if [[ ! -x "$PY" ]]; then
  echo "找不到 $PY" >&2
  echo "先在仓库里创建环境：cd $REPO && uv sync --extra openai" >&2
  exit 1
fi

exec "$PY" -m pcmem_demo.cli serve "$@"
