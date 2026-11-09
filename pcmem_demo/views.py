"""Read-only projections of the database for the browser."""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from .paths import BUILD_REPORT, SAMPLE_DIR, WORK_DIR
from .pipeline import _counts
from .secrets import file_permissions, public_view


def _relative(path: Any) -> str:
    if not isinstance(path, str) or not path:
        return ""
    try:
        return str(Path(path).relative_to(WORK_DIR))
    except ValueError:
        return Path(path).name


def _suffix(path: str) -> str:
    return Path(path).suffix.lower().lstrip(".") or "file"


def _project_map(projects) -> dict[str, dict[str, Any]]:
    return {project.id: {"id": project.id, "name": project.name, "slug": project.slug}
            for project in projects}


def _document_row(document, projects: dict[str, dict[str, Any]]) -> dict[str, Any]:
    extra = document.extra or {}
    project = projects.get(document.project_id or "")
    return {
        "id": document.id,
        "title": document.title,
        "path": _relative(extra.get("path")),
        "format": _suffix(extra.get("path") or document.title),
        "authors": list(document.authors or []),
        "license": document.license_class,
        "date": document.doc_date.isoformat() if document.doc_date else None,
        "project": project,
        "project_source": document.project_source,
        "project_confidence": extra.get("project_confidence"),
        "project_evidence": extra.get("project_evidence"),
        "version_seq": document.version_seq,
        "is_current": document.is_current,
        "version_of": document.version_of,
        "identity_key": document.identity_key,
        "chunk_count": document.chunk_count,
        "tags": list(document.tags or []),
    }


def load_build_report() -> dict[str, Any] | None:
    if not BUILD_REPORT.exists():
        return None
    try:
        payload = json.loads(BUILD_REPORT.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


async def state() -> dict[str, Any]:
    from sqlalchemy import select

    from sci_rag.db import get_session_factory
    from sci_rag.db.models import Project

    factory = get_session_factory()
    async with factory() as session:
        projects = list((await session.scalars(select(Project).order_by(Project.name))).all())
    counts = await _counts()
    report = load_build_report()
    return {
        "api": public_view(),
        "secret_file": file_permissions(),
        "counts": counts,
        "projects": [{"id": p.id, "name": p.name, "slug": p.slug} for p in projects],
        "build": report,
        "embedding": (report or {}).get("embedding", "local-hash:1024"),
        "sample": {
            "name": "PC-Mem 期中演示语料",
            "path": str(SAMPLE_DIR),
            "note": (report or {}).get("corpus_note", ""),
        },
    }


async def documents() -> dict[str, Any]:
    from sqlalchemy import select

    from sci_rag.db import Document, DocumentCitation, get_session_factory
    from sci_rag.db.models import Project

    factory = get_session_factory()
    async with factory() as session:
        projects = _project_map(list((await session.scalars(select(Project))).all()))
        rows = list(
            (
                await session.scalars(
                    select(Document).order_by(
                        Document.doc_date.desc().nullslast(), Document.title, Document.version_seq
                    )
                )
            ).all()
        )
        citations = list(
            (
                await session.scalars(
                    select(DocumentCitation).where(DocumentCitation.source == "mention")
                )
            ).all()
        )
    documents_out = [_document_row(document, projects) for document in rows]
    doc_map = {row["id"]: row for row in documents_out}
    for row in documents_out:
        row["citations_out"] = []
        row["citations_in"] = []
    for citation in citations:
        source = doc_map.get(citation.citing_document_id)
        target = doc_map.get(citation.cited_document_id or "")
        if source is not None:
            source["citations_out"].append({
                "title": target["title"] if target else citation.cited_key,
                "document_id": citation.cited_document_id,
                "key": citation.cited_key,
                "resolved": target is not None,
            })
        if target is not None:
            target["citations_in"].append({
                "title": source["title"],
                "document_id": source["id"],
                "key": citation.cited_key,
            })

    chains: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in documents_out:
        chains[row["identity_key"]].append(row)
    version_chains = []
    for identity, revisions in chains.items():
        revisions.sort(key=lambda item: item["version_seq"])
        if len(revisions) < 2:
            continue
        version_chains.append({
            "identity_key": identity,
            "title": revisions[-1]["title"],
            "project": revisions[-1]["project"],
            "revisions": revisions,
            "current": next((item for item in revisions if item["is_current"]), None),
        })
    version_chains.sort(key=lambda item: item["title"])
    return {
        "documents": documents_out,
        "version_chains": version_chains,
        "current_count": sum(1 for row in documents_out if row["is_current"]),
        "count": len(documents_out),
    }


async def document_detail(document_id: str) -> dict[str, Any] | None:
    from sqlalchemy import select

    from sci_rag.db import Chunk, Document, get_session_factory
    from sci_rag.db.models import Project

    factory = get_session_factory()
    async with factory() as session:
        document = await session.get(Document, document_id)
        if document is None:
            return None
        project = (
            await session.get(Project, document.project_id)
            if document.project_id
            else None
        )
        chunks = list(
            (
                await session.scalars(
                    select(Chunk)
                    .where(Chunk.document_id == document.id)
                    .order_by(Chunk.chunk_index)
                )
            ).all()
        )
        revisions = list(
            (
                await session.scalars(
                    select(Document)
                    .where(Document.identity_key == document.identity_key)
                    .order_by(Document.version_seq)
                )
            ).all()
        )
    row = _document_row(document, {project.id: {"id": project.id, "name": project.name,
                                                 "slug": project.slug}} if project else {})
    row["project"] = {"id": project.id, "name": project.name} if project else None
    row["chunks"] = [
        {
            "id": chunk.id,
            "index": chunk.chunk_index,
            "section_path": chunk.section_path,
            "content": chunk.content,
            "is_table": chunk.is_table,
        }
        for chunk in chunks
    ]
    row["revisions"] = [
        {
            "id": revision.id,
            "title": revision.title,
            "version_seq": revision.version_seq,
            "is_current": revision.is_current,
            "date": revision.doc_date.isoformat() if revision.doc_date else None,
        }
        for revision in revisions
    ]
    return row


async def evidence(chunk_ids: list[str]) -> list[dict[str, Any]]:
    from sqlalchemy import select

    from sci_rag.db import Chunk, Document, get_session_factory

    ids = [value for value in chunk_ids if isinstance(value, str)][:30]
    if not ids:
        return []
    factory = get_session_factory()
    async with factory() as session:
        rows = (
            await session.execute(
                select(Chunk, Document)
                .join(Document, Document.id == Chunk.document_id)
                .where(Chunk.id.in_(ids))
            )
        ).all()
    by_id = {chunk.id: (chunk, document) for chunk, document in rows}
    result = []
    for chunk_id in ids:
        found = by_id.get(chunk_id)
        if found is None:
            continue
        chunk, document = found
        result.append({
            "id": chunk.id,
            "document_id": document.id,
            "title": document.title,
            "path": _relative((document.extra or {}).get("path")),
            "version_seq": document.version_seq,
            "is_current": document.is_current,
            "section_path": chunk.section_path,
            "is_table": chunk.is_table,
            "content": chunk.content,
        })
    return result


async def graph() -> dict[str, Any]:
    from sqlalchemy import select

    from sci_rag.db import (
        Document,
        KgCommunity,
        KgEntity,
        KgRelationship,
        get_session_factory,
    )
    from sci_rag.db.models import Project

    factory = get_session_factory()
    async with factory() as session:
        projects = _project_map(list((await session.scalars(select(Project))).all()))
        documents = list((await session.scalars(select(Document))).all())
        entities = list((await session.scalars(select(KgEntity))).all())
        relationships = list((await session.scalars(select(KgRelationship))).all())
        communities = list((await session.scalars(select(KgCommunity))).all())
    doc_by_id = {document.id: document for document in documents}
    degree: Counter[str] = Counter()
    for relationship in relationships:
        degree[relationship.source_entity_id] += 1
        degree[relationship.target_entity_id] += 1
    nodes = []
    for entity in entities:
        if entity.canonical_entity_id:
            continue
        document_ids = [doc_id for doc_id in (entity.document_ids or []) if doc_id in doc_by_id]
        project_counts = Counter(
            projects[doc_by_id[doc_id].project_id]["name"]
            for doc_id in document_ids
            if doc_by_id[doc_id].project_id in projects
        )
        nodes.append({
            "id": entity.id,
            "name": entity.name,
            "type": entity.entity_type,
            "description": entity.description,
            "aliases": list(entity.aliases or []),
            "degree": degree.get(entity.id, 0),
            "document_ids": document_ids,
            "documents": [
                {
                    "id": doc_id,
                    "title": doc_by_id[doc_id].title,
                    "project": (
                        projects[doc_by_id[doc_id].project_id]["name"]
                        if doc_by_id[doc_id].project_id in projects
                        else None
                    ),
                    "version_seq": doc_by_id[doc_id].version_seq,
                    "date": (
                        doc_by_id[doc_id].doc_date.isoformat()
                        if doc_by_id[doc_id].doc_date
                        else None
                    ),
                    "path": _relative((doc_by_id[doc_id].extra or {}).get("path")),
                    "format": _suffix((doc_by_id[doc_id].extra or {}).get("path") or ""),
                    "license": doc_by_id[doc_id].license_class,
                }
                for doc_id in document_ids
            ],
            "project": project_counts.most_common(1)[0][0] if project_counts else None,
            "chunk_ids": list(entity.chunk_ids or [])[:40],
        })
    node_ids = {node["id"] for node in nodes}
    links = []
    for relationship in relationships:
        if relationship.source_entity_id not in node_ids or relationship.target_entity_id not in node_ids:
            continue
        links.append({
            "id": relationship.id,
            "source": relationship.source_entity_id,
            "target": relationship.target_entity_id,
            "type": relationship.relation_type,
            "evidence": relationship.evidence,
            "confidence": relationship.confidence,
            "document_id": relationship.document_id,
            "chunk_id": relationship.chunk_id,
        })
    communities_out = [
        {
            "id": community.id,
            "title": community.title,
            "level": community.level,
            "summary": community.summary,
            "member_ids": list(community.member_entity_ids or []),
        }
        for community in communities
    ]
    return {
        "nodes": nodes,
        "links": links,
        "communities": communities_out,
        "stats": {"nodes": len(nodes), "links": len(links)},
        "ontology": _ontology_view(),
    }


def _ontology_view() -> dict[str, Any]:
    import json as _json

    path = Path(__file__).resolve().parent / "ontology.json"
    try:
        payload = _json.loads(path.read_text(encoding="utf-8"))
    except (OSError, _json.JSONDecodeError):
        return {"entity_types": [], "relation_types": []}
    return {
        "name": payload.get("name"),
        "description": payload.get("description"),
        "provenance": payload.get("provenance"),
        "entity_types": payload.get("entity_types", []),
        "relation_types": payload.get("relation_types", []),
    }
