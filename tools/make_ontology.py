#!/usr/bin/env python3
"""Copy the PC-Mem ontology out of the repository, as JSON, for the demo.

The demo must not drift from the ontology the project actually ships, so this
script reads ``personal-agent/domain-personal/domain.yaml`` and writes
``pcmem_demo/ontology.json``. It is run by hand when the YAML changes; the
demo itself has no PyYAML dependency.

Usage:
    ../personal-agent/.venv/bin/python tools/make_ontology.py
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
DEMO = HERE.parent
SOURCE = DEMO.parent / "personal-agent" / "domain-personal" / "domain.yaml"
TARGET = DEMO / "pcmem_demo" / "ontology.json"


def main() -> None:
    raw = SOURCE.read_bytes()
    config = yaml.safe_load(raw.decode("utf-8"))
    payload = {
        "name": config["name"],
        "description": " ".join(str(config["description"]).split()),
        "entity_types": [
            {
                "name": item["name"],
                "description": " ".join(str(item.get("description", "")).split()),
                "canonical_suffixes": item.get("canonical_suffixes", {}),
            }
            for item in config["entity_types"]
        ],
        "relation_types": [
            {
                "name": item["name"],
                "description": " ".join(str(item.get("description", "")).split()),
                "source_types": item.get("source_types", []),
                "target_types": item.get("target_types", []),
            }
            for item in config["relation_types"]
        ],
        "query_classes": config.get("query_classes", []),
        "retrieval": config.get("retrieval", {}),
        "provenance": {
            "source": "personal-agent/domain-personal/domain.yaml",
            "sha256": hashlib.sha256(raw).hexdigest(),
        },
    }
    TARGET.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {TARGET} ({len(payload['entity_types'])} entity types, "
          f"{len(payload['relation_types'])} relation types)")


if __name__ == "__main__":
    main()
