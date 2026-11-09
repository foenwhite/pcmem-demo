"""Build a ``sci_rag`` Settings object for one stored endpoint.

The demo never edits the repository's ``.env`` or environment for a key.
Each build/ask constructs Settings explicitly from the secret store, so a key
change takes effect on the next request and nothing secret is exported to a
child process.
"""

from __future__ import annotations

from .paths import DB_URL, EMBEDDING_DIM, EMBEDDING_PROVIDER, REPO_DIR

DEFAULT_BASE_URL = "https://api.deepseek.com/v1"
DEFAULT_ANSWER_MODEL = "deepseek-flash"
DEFAULT_EXTRACTION_MODEL = "deepseek-flash"


def build_settings(api: dict):
    from sci_rag.config import Settings

    return Settings(
        database_url=DB_URL,
        domain_dir=REPO_DIR / "domain-personal",
        embedding_provider=EMBEDDING_PROVIDER,
        embedding_dim=EMBEDDING_DIM,
        embedding_model="local-hash",
        llm_provider="openai-compatible",
        openai_base_url=api["base_url"],
        openai_api_key=api["key"],
        llm_model=api["answer_model"],
        extraction_model=api["extraction_model"],
        judge_model=None,
        # Do not let an ambient shell credential leak into a demo request.
        deepseek_api_key=None,
        google_api_key=None,
        anthropic_api_key=None,
        gcp_project=None,
        provider_call_timeout_s=180.0,
        interactive_stage_timeout_s=20.0,
        deep_stage_timeout_s=60.0,
    )


def describe_settings(settings) -> dict:
    spec = settings.model_spec_for("answer")
    extraction = settings.model_spec_for("extraction")
    return {
        "provider": spec.provider,
        "answer_model": spec.model,
        "extraction_model": extraction.model,
        "embedding": settings.embedding_provider,
        "embedding_dim": settings.embedding_dim,
    }
