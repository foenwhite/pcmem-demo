"""Path and environment bootstrap for the PC-Mem demo.

Everything that touches ``sci_rag`` must import this module first: it points
the package at the demo database and at the repository's domain profile, and
puts the repository's ``src`` on ``sys.path``. No repository file is modified.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

DEMO_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = Path(os.environ.get("PCMEM_DEMO_REPO", DEMO_DIR.parent / "personal-agent")).resolve()
SAMPLE_DIR = DEMO_DIR / "sample_corpus"
WEB_DIR = DEMO_DIR / "web"
STATE_DIR = Path(os.environ.get("PCMEM_DEMO_STATE", DEMO_DIR / ".state")).resolve()
WORK_DIR = STATE_DIR / "work"
PG_DIR = STATE_DIR / "pgdata"
BUILD_REPORT = STATE_DIR / "build_report.json"
SECRETS_PATH = STATE_DIR / "secrets.json"

PG_PORT = os.environ.get("PCMEM_DEMO_PG_PORT", "5544")
PG_USER = os.environ.get("PCMEM_DEMO_PG_USER", "pcmem")
PG_DB = os.environ.get("PCMEM_DEMO_PG_DB", "pcmem_demo")
DB_URL = os.environ.get(
    "SCI_RAG_DATABASE_URL",
    f"postgresql+asyncpg://{PG_USER}:{PG_USER}@127.0.0.1:{PG_PORT}/{PG_DB}",
)

DEFAULT_HOST = os.environ.get("PCMEM_DEMO_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("PCMEM_DEMO_PORT", "8770"))

#: The repository's own offline embedder. The demo keeps this so a fresh
#: machine needs no 1.2 GB model download and no second provider credential;
#: the UI labels the vector layer as local-hash rather than pretending it is
#: a semantic model.
EMBEDDING_PROVIDER = "local-hash"
EMBEDDING_DIM = 1024


def ensure_runtime_env() -> None:
    """Set the few settings ``sci_rag`` reads at import/session time."""
    os.environ["SCI_RAG_DATABASE_URL"] = DB_URL
    os.environ["SCI_RAG_DOMAIN_DIR"] = str(REPO_DIR / "domain-personal")
    os.environ.setdefault("SCI_RAG_EMBEDDING_PROVIDER", EMBEDDING_PROVIDER)
    os.environ.setdefault("SCI_RAG_EMBEDDING_DIM", str(EMBEDDING_DIM))
    src = str(REPO_DIR / "src")
    if src not in sys.path:
        sys.path.insert(0, src)


ensure_runtime_env()
