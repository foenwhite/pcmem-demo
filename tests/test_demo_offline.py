"""Offline checks for the demo: corpus, ontology, project rules, secret store.

No database and no model call. Run with the repository virtualenv:

    ../personal-agent/.venv/bin/python -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

DEMO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DEMO))

from pcmem_demo import paths, secrets  # noqa: E402  (paths prepares sys.path/env)


class CorpusTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads((paths.SAMPLE_DIR / "manifest.json").read_text(encoding="utf-8"))
        cls.documents = cls.manifest["documents"]

    def test_document_count_and_formats(self) -> None:
        self.assertEqual(len(self.documents), 14)
        formats = {Path(row["path"]).suffix.lower() for row in self.documents}
        self.assertEqual(
            formats,
            {".md", ".docx", ".xlsx", ".py", ".txt", ".eml", ".csv"},
        )

    def test_every_manifest_path_exists(self) -> None:
        for row in self.documents:
            self.assertTrue((paths.SAMPLE_DIR / row["path"]).is_file(), row["path"])
            for revision in row.get("history") or []:
                self.assertTrue((paths.SAMPLE_DIR / revision["path"]).is_file(), revision["path"])

    def test_one_real_version_chain(self) -> None:
        versioned = [row for row in self.documents if row.get("history")]
        self.assertEqual(len(versioned), 1)
        row = versioned[0]
        self.assertEqual(row["title"], "远山项目立项书 v2")
        self.assertEqual(len(row["history"]), 2)
        current = (paths.SAMPLE_DIR / row["path"]).read_text(encoding="utf-8")
        oldest = (paths.SAMPLE_DIR / row["history"][0]["path"]).read_text(encoding="utf-8")
        self.assertIn("48 万元", current)
        self.assertIn("北辰测绘", oldest)
        self.assertNotIn("北辰测绘", current)

    def test_internal_links_resolve_to_current_titles(self) -> None:
        titles = {row["title"] for row in self.documents}
        links: set[str] = set()
        for row in self.documents:
            text = (paths.SAMPLE_DIR / row["path"]).read_text(encoding="utf-8", errors="ignore")
            links.update(re.findall(r"\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]", text))
        missing = {link for link in links if link not in titles}
        self.assertEqual(missing, set())

    def test_restricted_rights_demo(self) -> None:
        restricted = {row["path"] for row in self.documents if row["license"] == "restricted"}
        self.assertEqual(
            restricted,
            {"远山项目/检查点精度表.xlsx", "会议/2026-03-18 远山矿业预算确认.eml"},
        )

    def test_project_rules_are_ordered_and_match(self) -> None:
        from sci_rag.projects import load_project_rules

        rules = load_project_rules(paths.SAMPLE_DIR / "project_rules.yaml")
        self.assertEqual([rule.project for rule in rules], ["远山", "河图"])
        self.assertTrue(rules[0].matches("/tmp/work/远山项目/立项书.md"))
        self.assertFalse(rules[0].matches("/tmp/work/会议/纪要.md"))
        self.assertTrue(rules[1].matches("/tmp/work/河图项目/立项书.md"))


class OntologyTest(unittest.TestCase):
    def test_counts_and_relation_endpoints(self) -> None:
        ontology = json.loads((DEMO / "pcmem_demo" / "ontology.json").read_text(encoding="utf-8"))
        entity_names = {item["name"] for item in ontology["entity_types"]}
        relation_names = {item["name"] for item in ontology["relation_types"]}
        self.assertEqual(len(entity_names), 12)
        self.assertEqual(len(relation_names), 11)
        for relation in ontology["relation_types"]:
            self.assertTrue(set(relation["source_types"]) <= entity_names)
            self.assertTrue(set(relation["target_types"]) <= entity_names)
        project = next(item for item in ontology["entity_types"] if item["name"] == "Project")
        self.assertEqual(project["canonical_suffixes"], {"项目": 1, " project": 1})

    def test_ontology_matches_the_repository_source(self) -> None:
        import hashlib

        ontology = json.loads((DEMO / "pcmem_demo" / "ontology.json").read_text(encoding="utf-8"))
        source = paths.REPO_DIR / "domain-personal" / "domain.yaml"
        self.assertTrue(source.exists())
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        self.assertEqual(ontology["provenance"]["sha256"], digest)


#: Built from pieces so a repository secret scanner does not mistake a test
#: fixture for a live credential.
FAKE_KEY = "sk-" + "test-" + "0123456789abcdef"


class SecretStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self._original = secrets.SECRETS_PATH
        self._temp = tempfile.TemporaryDirectory()
        secrets.SECRETS_PATH = Path(self._temp.name) / "secrets.json"

    def tearDown(self) -> None:
        secrets.SECRETS_PATH = self._original
        self._temp.cleanup()

    def test_key_is_stored_private_and_never_echoed(self) -> None:
        key = FAKE_KEY
        view = secrets.save_api(
            base_url="https://example.test/v1",
            api_key=key,
            answer_model="answer-model",
            extraction_model="extract-model",
        )
        self.assertTrue(view["has_key"])
        self.assertNotIn("sk-", json.dumps(view))
        self.assertEqual(oct(secrets.SECRETS_PATH.stat().st_mode & 0o777), "0o600")
        self.assertEqual(secrets.load_api()["key"], key)
        again = secrets.save_api(
            base_url="https://example.test/v1",
            api_key="",
            answer_model="answer-model",
            extraction_model="extract-model",
        )
        self.assertTrue(again["has_key"])
        self.assertEqual(secrets.load_api()["key"], key)

    def test_clear_key_keeps_endpoint(self) -> None:
        secrets.save_api(
            base_url="https://example.test/v1",
            api_key=FAKE_KEY,
            answer_model="answer-model",
            extraction_model="extract-model",
        )
        view = secrets.clear_key()
        self.assertFalse(view["has_key"])
        self.assertEqual(view["base_url"], "https://example.test/v1")
        with self.assertRaises(secrets.SecretError):
            secrets.save_api(
                base_url="https://example.test/v1",
                api_key="",
                answer_model="answer-model",
                extraction_model="extract-model",
            )

    def test_url_validation_rejects_credentials_and_queries(self) -> None:
        with self.assertRaises(secrets.SecretError):
            secrets.validate_base_url("https://user:password@example.test/v1")
        with self.assertRaises(secrets.SecretError):
            secrets.validate_base_url("https://example.test/v1?key=abc")
        self.assertEqual(
            secrets.validate_base_url("https://example.test/v1/"),
            "https://example.test/v1",
        )

    def test_redaction(self) -> None:
        message = f"provider said {FAKE_KEY} and other " + "sk-" + "abcdefghijkl"
        redacted = secrets.redact(message)
        self.assertNotIn(FAKE_KEY, redacted)
        self.assertIn("***", redacted)


class StaticAssetsTest(unittest.TestCase):
    def test_no_external_frontend_resources(self) -> None:
        html = (paths.WEB_DIR / "index.html").read_text(encoding="utf-8")
        script = (paths.WEB_DIR / "app.js").read_text(encoding="utf-8")
        self.assertNotRegex(html, r'(?:src|href)="https?://')
        self.assertNotRegex(script, r'fetch\(\s*["\']https?://')
        self.assertNotRegex(script, r'(?:src|href)\s*=\s*["\']https?://')
        self.assertIn("/app.js", html)
        self.assertIn("/styles.css", html)

    def test_theme_is_light(self) -> None:
        css = (paths.WEB_DIR / "styles.css").read_text(encoding="utf-8")
        self.assertIn("--bg: #f7f8fa", css)
        self.assertIn("--panel: #ffffff", css)
        self.assertNotIn("#0b0e14", css)


if __name__ == "__main__":
    unittest.main()
