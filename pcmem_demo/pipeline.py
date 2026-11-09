"""The demo's orchestration: the repository's own ingest, extract, classify,
mention, retrieve and answer paths, driven from a fixed corpus.

Nothing here re-implements chunking, versioning, ontology validation, RRF
fusion, permission scoping or citation post-processing. Those are imported from
``sci_rag``; this module only decides the order the demo calls them in.
"""

from __future__ import annotations

import asyncio
import json
import math
import re
import shutil
import time
from dataclasses import asdict
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from .config import build_settings
from .paths import (
    BUILD_REPORT,
    EMBEDDING_DIM,
    REPO_DIR,
    SAMPLE_DIR,
    STATE_DIR,
    WORK_DIR,
)
from .secrets import load_api, redact

MANIFEST = SAMPLE_DIR / "manifest.json"
RULES = SAMPLE_DIR / "project_rules.yaml"
SOURCE = "pcmem-demo"


class BuildError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Schema and corpus
# ---------------------------------------------------------------------------


async def ensure_schema() -> None:
    from sqlalchemy import text

    from sci_rag.db import Base, get_engine

    engine = get_engine()
    async with engine.begin() as connection:
        await connection.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        exists = await connection.scalar(text("SELECT to_regclass('public.documents')"))
        if exists is None:
            await connection.run_sync(Base.metadata.create_all)


async def reset_schema() -> None:
    from sqlalchemy import text

    from sci_rag.db import Base, get_engine

    engine = get_engine()
    async with engine.begin() as connection:
        await connection.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await connection.run_sync(Base.metadata.drop_all)
        await connection.run_sync(Base.metadata.create_all)


def load_manifest() -> dict[str, Any]:
    payload = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("documents"), list):
        raise BuildError("manifest.json 格式不正确")
    return payload


def copy_corpus() -> dict[str, Any]:
    if WORK_DIR.exists():
        shutil.rmtree(WORK_DIR)
    WORK_DIR.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(
        SAMPLE_DIR,
        WORK_DIR,
        ignore=shutil.ignore_patterns("manifest.json", "project_rules.yaml"),
    )
    manifest = load_manifest()
    for row in manifest["documents"]:
        if not (WORK_DIR / row["path"]).exists():
            raise BuildError(f"语料缺少文件：{row['path']}")
        history = row.get("history") or []
        if history:
            initial = history[0]
            if not (WORK_DIR / initial["path"]).exists():
                raise BuildError(f"版本历史缺少文件：{initial['path']}")
            shutil.copy2(WORK_DIR / initial["path"], WORK_DIR / row["path"])
    return manifest


def _entry(row: dict[str, Any], *, title: str | None = None, path: str | None = None):
    from sci_rag.ingest import CorpusEntry

    return CorpusEntry(
        path=(WORK_DIR / (path or row["path"])).resolve(),
        title=title or row["title"],
        authors=row.get("authors", []),
        license_class=row.get("license", "unknown"),
        source=SOURCE,
    )


async def _set_document_date(document_id: str | None, iso: str) -> None:
    if not document_id:
        return
    from sci_rag.db import Document, get_session_factory

    factory = get_session_factory()
    async with factory() as session:
        document = await session.get(Document, document_id)
        if document is None:
            return
        document.doc_date = date.fromisoformat(iso)
        document.doc_date_source = "doc_property"
        await session.commit()


async def _assign_manual_projects(rows: list[dict[str, Any]], project_names: set[str]) -> int:
    from sqlalchemy import select

    from sci_rag.db import Document, get_session_factory
    from sci_rag.projects import assign_project, create_project

    factory = get_session_factory()
    projects = {}
    for name in sorted(project_names):
        projects[name] = await create_project(factory, name)
    assigned = 0
    for row in rows:
        name = row.get("project")
        if not name:
            continue
        path = str((WORK_DIR / row["path"]).resolve())
        async with factory() as session:
            document = await session.scalar(
                select(Document).where(
                    Document.source_ref == path, Document.is_current.is_(True)
                )
            )
        if document is None:
            continue
        await assign_project(factory, document.id, projects[name].id)
        assigned += 1
    return assigned


async def _replay_versions(
    rows: list[dict[str, Any]], progress
) -> int:
    from sci_rag.db import get_session_factory
    from sci_rag.embed import LocalHashEmbedder
    from sci_rag.ingest import ingest_entries

    factory = get_session_factory()
    embedder = LocalHashEmbedder(EMBEDDING_DIM)
    replayed = 0
    versioned = [row for row in rows if row.get("history")]
    for index, row in enumerate(versioned):
        revisions = list(row["history"][1:]) + [
            {"path": row["path"], "title": row["title"], "date": row["date"], "current": True}
        ]
        for revision in revisions:
            if revision.get("current"):
                source = SAMPLE_DIR / row["path"]
            else:
                source = WORK_DIR / revision["path"]
            shutil.copy2(source, WORK_DIR / row["path"])
            report = await ingest_entries(
                [_entry(row, title=revision["title"])],
                embedder=embedder,
                session_factory=factory,
            )
            outcome = report.outcomes[0]
            if outcome.status == "failed":
                raise BuildError(f"版本 {revision['title']} 入库失败：{outcome.detail}")
            await _set_document_date(outcome.document_id, revision["date"])
            replayed += 1
            progress(
                "版本链",
                f"{row['title']} → {revision['title']}",
                36 + int(10 * (index + 1) / max(1, len(versioned))),
            )
    return replayed


async def _counts() -> dict[str, int]:
    from sqlalchemy import func, select

    from sci_rag.db import (
        Chunk,
        Document,
        DocumentCitation,
        KgCommunity,
        KgEntity,
        KgRelationship,
        get_session_factory,
    )
    from sci_rag.db.models import Project

    factory = get_session_factory()
    async with factory() as session:
        count = lambda model, *where: session.scalar(  # noqa: E731
            select(func.count()).select_from(model).where(*where)
        )
        return {
            "documents": await count(Document, Document.is_current.is_(True)) or 0,
            "versions": await count(Document) or 0,
            "chunks": await count(Chunk) or 0,
            "entities": await count(KgEntity) or 0,
            "relationships": await count(KgRelationship) or 0,
            "communities": await count(KgCommunity) or 0,
            "mentions": await count(DocumentCitation, DocumentCitation.source == "mention") or 0,
            "projects": await count(Project) or 0,
            "restricted": await count(Document, Document.is_current.is_(True),
                                   Document.license_class == "restricted") or 0,
        }


def _write_report(payload: dict[str, Any]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    temporary = BUILD_REPORT.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(BUILD_REPORT)


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------


async def run_build(progress, *, with_communities: bool = False) -> dict[str, Any]:
    from sqlalchemy import func, select

    from sci_rag.db import Chunk, Document, get_session_factory
    from sci_rag.domain import load_domain
    from sci_rag.embed import LocalHashEmbedder
    from sci_rag.graph import extract_graph
    from sci_rag.ingest import ingest_entries
    from sci_rag.llm import get_llm
    from sci_rag.projects import classify_documents, load_project_rules
    from sci_rag.relate.mentions import build_mentions

    started = time.monotonic()
    timings: dict[str, float] = {}
    warnings: list[str] = []
    api = load_api()
    settings = build_settings(api) if api else None
    domain = load_domain(settings.domain_dir if settings else REPO_DIR / "domain-personal")
    llm = get_llm(settings, role="extraction") if settings else None
    model_label = llm.describe() if llm else None
    embedder = LocalHashEmbedder(EMBEDDING_DIM)
    factory = get_session_factory()

    progress("准备", "重置演示数据库", 2)
    tick = time.monotonic()
    await reset_schema()
    timings["reset_s"] = round(time.monotonic() - tick, 2)

    tick = time.monotonic()
    progress("语料", "复制固定文件树到工作目录", 5)
    manifest = copy_corpus()
    rows = manifest["documents"]
    progress("语料", f"{len(rows)} 个文档，含 {sum(len(r.get('history') or []) for r in rows)} 个历史修订", 7)
    timings["copy_s"] = round(time.monotonic() - tick, 2)

    # The initial pass ingests every current file, using each versioned file's
    # oldest revision as its first content. This is what creates a real chain.
    initial: list[Any] = []
    initial_dates: list[str] = []
    for row in rows:
        history = row.get("history") or []
        if history:
            initial.append(_entry(row, title=history[0]["title"]))
            initial_dates.append(history[0]["date"])
        else:
            initial.append(_entry(row))
            initial_dates.append(row["date"])

    tick = time.monotonic()
    progress("入库", f"调用真实 ingest 路径，共 {len(initial)} 个文件", 10)
    report = await ingest_entries(initial, embedder=embedder, session_factory=factory)
    failed = [outcome for outcome in report.outcomes if outcome.status == "failed"]
    if failed:
        detail = "; ".join(f"{Path(o.path).name}: {o.detail}" for o in failed[:4])
        raise BuildError(f"{len(failed)} 个文件解析失败：{detail}")
    for outcome, iso in zip(report.outcomes, initial_dates):
        await _set_document_date(outcome.document_id, iso)
    chunks_ingested = sum(outcome.chunk_count for outcome in report.outcomes)
    progress("入库", f"{len(report.outcomes)} 个文件，{chunks_ingested} 个检索段落", 24)
    timings["ingest_s"] = round(time.monotonic() - tick, 2)

    rules = load_project_rules(RULES)
    project_names = {row["project"] for row in rows if row.get("project")}
    project_names.update(rule.project for rule in rules)
    assigned = await _assign_manual_projects(rows, project_names)
    progress("项目归属", f"人工归属 {assigned} 个当前文件；其余交给规则与模型", 30)

    tick = time.monotonic()
    replayed = await _replay_versions(rows, progress)
    timings["versions_s"] = round(time.monotonic() - tick, 2)
    progress("版本链", f"重放 {replayed} 个修订；旧版本仅保留为历史", 46)

    tick = time.monotonic()
    stats = await classify_documents(
        factory=factory,
        domain=domain,
        llm=llm,
        rules=rules,
        infer=llm is not None,
        auto_tags=False,
    )
    timings["projects_s"] = round(time.monotonic() - tick, 2)
    progress(
        "项目归属",
        f"人工 {stats.manual_kept} · 规则 {stats.rules_assigned} · "
        f"模型推断 {stats.inferred_assigned} · 外发跳过 {stats.outbound_skipped}",
        50,
    )

    mentions = await build_mentions(factory, apply=True)
    progress("引用", f"解析 {mentions.get('mentions', 0)} 条字面引用，"
             f"其中 {mentions.get('matched', 0)} 条落到当前文档", 54)

    extraction_stats: dict[str, int] = {}
    if llm is not None:
        async with factory() as session:
            pending = await session.scalar(
                select(func.count(Chunk.id))
                .join(Document, Document.id == Chunk.document_id)
                .where(Document.is_current.is_(True), Chunk.graph_extracted_at.is_(None))
                .where(Document.license_class.in_(("public", "open_commercial")))
            ) or 0
        progress("抽取", f"待抽取 {pending} 个当前版本段落（批大小 6，并发 3）", 56)
        tick = time.monotonic()
        processed = 0
        rounds = 0
        fields = (
            "chunks_processed", "batches_failed", "batches_split", "entities_created",
            "entities_updated", "relationships_created", "entities_dropped",
            "aliases_dropped", "relationships_dropped", "exact_merges", "stale_batches",
        )
        extraction_stats = {field: 0 for field in fields}
        while rounds < 30:
            round_stats = await extract_graph(
                session_factory=factory,
                llm=llm,
                domain=domain,
                batch_size=6,
                concurrency=3,
                max_chunks=12,
                rate_limit_s=0.0,
            )
            rounds += 1
            for field in fields:
                extraction_stats[field] += int(getattr(round_stats, field, 0) or 0)
            processed += round_stats.chunks_processed
            done = min(1.0, processed / pending) if pending else 1.0
            progress(
                "抽取",
                f"第 {rounds} 轮：已处理 {processed}/{pending} 段 · "
                f"新增实体 {extraction_stats['entities_created']} · "
                f"关系 {extraction_stats['relationships_created']} · "
                f"丢弃 {extraction_stats['relationships_dropped'] + extraction_stats['entities_dropped']}",
                56 + int(34 * done),
            )
            if round_stats.chunks_processed == 0:
                break
        timings["extract_s"] = round(time.monotonic() - tick, 2)
        if extraction_stats["batches_failed"]:
            warnings.append(
                f"{extraction_stats['batches_failed']} 个抽取批次失败；图谱可能不完整，可在构建日志后重试"
            )
        if extraction_stats["chunks_processed"] == 0:
            warnings.append("没有段落被抽取：请检查模型密钥、Base URL 与模型名")

        tick = time.monotonic()
        if with_communities:
            progress("社区", "生成社区摘要（每个社区一次模型调用，最多等 120 秒）", 92)
            try:
                from sci_rag.graph import build_communities

                community = await asyncio.wait_for(
                    build_communities(
                        session_factory=factory,
                        llm=llm,
                        embedder=embedder,
                        domain=domain,
                        min_size=3,
                    ),
                    timeout=120,
                )
                progress("社区", f"社区摘要 {community.communities_created} 个", 94)
            except TimeoutError:
                warnings.append("社区摘要超过 120 秒，已跳过；图谱与检索不受影响")
            except Exception as exc:  # community summaries are optional for the demo
                warnings.append(f"社区摘要未完成：{type(exc).__name__}")
        else:
            progress("社区", "跳过社区摘要（重建面板可勾选）", 92)
            warnings.append("社区摘要未运行：重建时可在面板勾选，或用 CLI 的 --with-communities")
        timings["communities_s"] = round(time.monotonic() - tick, 2)
    else:
        warnings.append("尚未配置模型：已建立文件、版本链、规则归属与引用；图谱抽取和模型推断未运行")
        progress("抽取", "跳过：未配置模型", 90)

    counts = await _counts()
    result = {
        "started_at": datetime.fromtimestamp(
            datetime.now(UTC).timestamp() - (time.monotonic() - started), UTC
        ).isoformat(timespec="seconds"),
        "finished_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "seconds": round(time.monotonic() - started, 2),
        "timings": timings,
        "model": model_label,
        "embedding": f"{settings.embedding_provider if settings else 'local-hash'}:{EMBEDDING_DIM}",
        "documents": len(rows),
        "chunks_ingested": chunks_ingested,
        "versions_replayed": replayed,
        "project_stats": asdict(stats),
        "mentions": mentions,
        "extraction": extraction_stats,
        "counts": counts,
        "warnings": warnings,
        "communities_run": with_communities,
        "corpus_note": manifest.get("note", ""),
    }
    _write_report(result)
    progress("完成", f"文档 {counts['documents']} · 实体 {counts['entities']} · "
             f"关系 {counts['relationships']} · 社区 {counts['communities']}", 100)
    return result


# ---------------------------------------------------------------------------
# Answering and diagnostics
# ---------------------------------------------------------------------------


def _serialize_item(item) -> dict[str, Any]:
    content = re.sub(r"\s+", " ", item.content or "").strip()
    return {
        "kind": item.kind,
        "id": item.id,
        "score": round(float(item.score), 5),
        "layers": list(item.layers),
        "title": item.title,
        "document_id": item.document_id,
        "section_path": item.section_path,
        "license_class": item.license_class,
        "is_table": bool(item.is_table),
        "snippet": content[:420],
    }


def _serialize_retrieval(result) -> dict[str, Any]:
    return {
        "profile": result.profile,
        "degraded_stages": result.degraded_stages,
        "traces": [asdict(trace) for trace in result.traces],
        "items": [_serialize_item(item) for item in result.items],
    }


class DemoRetriever:
    """The repository Retriever with the demo's layer choices.

    The demo leaves the LLM reranker on: local-hash vectors are intentionally
    offline, and without reranking an exact keyword hit can lose to chunks that
    merely agree with several weaker layers. HyDE is a switch because it costs
    a provider round trip and the reranker already resolves the demo questions.
    """

    def __new__(cls, *, settings, domain, embedder, session_factory, use_hyde: bool = False):
        from sci_rag.retrieve import Retriever

        class _Retriever(Retriever):
            def __init__(self) -> None:
                super().__init__(
                    settings=settings, domain=domain, embedder=embedder,
                    session_factory=session_factory,
                )

            async def retrieve(self, query, **kwargs):
                kwargs.setdefault("include_rerank", True)
                kwargs.setdefault("include_hyde", use_hyde)
                return await super().retrieve(query, **kwargs)

        return _Retriever()


async def ask_stream(question: str, *, project_id: str | None = None,
                     external_only: bool = False, use_hyde: bool = False):
    api = load_api()
    if api is None:
        yield {
            "type": "error",
            "data": {"code": "no_key",
                     "message": "还没有保存模型 API。打开右上角「设置」填写 Base URL、密钥与模型名。"},
        }
        return
    question = " ".join(question.split())[:1000]
    if not question:
        yield {"type": "error", "data": {"code": "empty_question", "message": "问题不能为空"}}
        return
    from sci_rag.answer import AnswerEngine
    from sci_rag.db import get_session_factory
    from sci_rag.domain import load_domain
    from sci_rag.embed import LocalHashEmbedder
    from sci_rag.server.service import RagService

    settings = build_settings(api)
    domain = load_domain(settings.domain_dir)
    factory = get_session_factory()
    retriever = DemoRetriever(
        settings=settings,
        domain=domain,
        embedder=LocalHashEmbedder(settings.embedding_dim),
        session_factory=factory,
        use_hyde=use_hyde,
    )
    engine = AnswerEngine(settings=settings, retriever=retriever)
    service = RagService(settings=settings, retriever=retriever, answer_engine=engine)
    yield {
        "type": "meta",
        "data": {
            "answer_model": settings.model_spec_for("answer").model,
            "embedding": settings.embedding_provider,
            "profile": "deep",
            "external_only": external_only,
            "use_hyde": use_hyde,
            "rerank": True,
            "project_id": project_id,
        },
    }
    try:
        async for event in service.answer_stream(
            question,
            profile="deep",
            top_k=8,
            projects=[project_id] if project_id else None,
            license_classes=["public", "open_commercial"] if external_only else None,
            include_compression=False,
        ):
            data = dict(event.data)
            if event.type == "retrieval_done":
                result = data.pop("_result", None)
                if result is not None:
                    data.update(_serialize_retrieval(result))
            elif event.type == "compression_done":
                data.pop("_result", None)
            elif event.type == "citations":
                data.pop("_sources", None)
            elif event.type == "error":
                data["message"] = redact(data.get("message", ""), api["key"])
            yield {"type": event.type, "data": data}
    except Exception as exc:
        yield {
            "type": "error",
            "data": {
                "code": "ask_failed",
                "message": redact(f"{type(exc).__name__}: {exc}", api["key"])[:500],
            },
        }


def _tokens(value: str) -> set[str]:
    from sci_rag.keyword_tokens import chinese_search_tokens, contains_han

    words = {word.casefold() for word in re.findall(r"[A-Za-z0-9_]{2,}", value)}
    if contains_han(value):
        words.update(token.casefold() for token in chinese_search_tokens(value))
    return {word for word in words if len(word) > 1}


async def superseded_search(question: str, limit: int = 3) -> dict[str, Any]:
    """Look for a question's words only in revisions that retrieval must not use.

    This is a labelled diagnostic for the demo, not an answer path: it never
    feeds the model and never changes the retrieval scope.
    """
    from sqlalchemy import select

    from sci_rag.db import Chunk, Document, get_session_factory

    query_tokens = _tokens(question)
    empty = {"hits": [], "query_tokens": sorted(query_tokens)[:12]}
    if not query_tokens:
        return empty
    factory = get_session_factory()
    async with factory() as session:
        rows = (
            await session.execute(
                select(Chunk, Document)
                .join(Document, Document.id == Chunk.document_id)
                .where(Document.is_current.is_(False))
                .order_by(Document.doc_date.desc().nullslast(), Chunk.chunk_index)
            )
        ).all()
    scored = []
    for chunk, document in rows:
        chunk_tokens = _tokens(chunk.content)
        overlap = query_tokens & chunk_tokens
        if not overlap:
            continue
        score = len(overlap) / math.sqrt(max(1, len(query_tokens)))
        scored.append((score, overlap, chunk, document))
    scored.sort(key=lambda row: (-row[0], row[3].title))
    hits = []
    for score, overlap, chunk, document in scored[:limit]:
        if score <= 0:
            continue
        hits.append({
            "score": round(score, 3),
            "matched_terms": sorted(overlap)[:8],
            "title": document.title,
            "version_seq": document.version_seq,
            "date": document.doc_date.isoformat() if document.doc_date else None,
            "snippet": re.sub(r"\s+", " ", chunk.content).strip()[:360],
            "note": "已失效版本，不参与检索与回答",
        })
    return {**empty, "hits": hits}


async def test_endpoint(api: dict) -> dict[str, Any]:
    from sci_rag.llm import get_llm

    settings = build_settings(api)
    llm = get_llm(settings, role="answer")
    started = time.monotonic()
    reply = await llm.generate(
        "只回复两个字符：OK", temperature=0.0, max_tokens=24
    )
    return {
        "ok": True,
        "model": llm.describe(),
        "latency_ms": int((time.monotonic() - started) * 1000),
        "reply": (reply or "").strip()[:40],
        "embedding": settings.embedding_provider,
    }
