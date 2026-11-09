"""The demo's only secret store.

The API key arrives in a POST body over loopback, is written to
``.state/secrets.json`` with mode 0600, and is never returned to a browser,
never placed in a log line, and never put in a URL. Reads expose a boolean and
non-secret endpoint/model metadata only.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import UTC, datetime
from urllib.parse import urlparse

from .paths import SECRETS_PATH

_KEY_PATTERN = re.compile(r"(?:sk|ak|key)-[A-Za-z0-9_\-]{8,}")
_MAX_URL = 300
_MAX_MODEL = 200


class SecretError(ValueError):
    """A settings payload that must not be stored."""


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _ensure_dir() -> None:
    SECRETS_PATH.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(SECRETS_PATH.parent, 0o700)
    except OSError:
        pass


def _read_raw() -> dict:
    if not SECRETS_PATH.exists():
        return {}
    try:
        payload = json.loads(SECRETS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _atomic_write(payload: dict) -> None:
    _ensure_dir()
    fd, temporary = tempfile.mkstemp(prefix=".secrets-", dir=str(SECRETS_PATH.parent))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, SECRETS_PATH)
        os.chmod(SECRETS_PATH, 0o600)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _clean_text(value: object, field: str, limit: int) -> str:
    if not isinstance(value, str):
        raise SecretError(f"{field} 必须是字符串")
    text = value.strip()
    if not text:
        raise SecretError(f"{field} 不能为空")
    if len(text) > limit:
        raise SecretError(f"{field} 过长")
    if any(ord(character) < 32 for character in text):
        raise SecretError(f"{field} 含有控制字符")
    return text


def validate_base_url(value: object) -> str:
    text = _clean_text(value, "Base URL", _MAX_URL).rstrip("/")
    parsed = urlparse(text)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise SecretError("Base URL 必须是 http(s)://主机/路径 的形式")
    if parsed.username or parsed.password:
        raise SecretError("不要把密钥写进 Base URL")
    if parsed.query or parsed.fragment:
        raise SecretError("Base URL 不能带查询串或片段")
    return text


def _validate_model(value: object, field: str) -> str:
    return _clean_text(value, field, _MAX_MODEL)


def load_api() -> dict | None:
    payload = _read_raw().get("api")
    if not isinstance(payload, dict):
        return None
    key = payload.get("key")
    if not isinstance(key, str) or not key:
        return None
    try:
        base_url = validate_base_url(payload.get("base_url"))
        answer_model = _validate_model(payload.get("answer_model"), "回答模型")
        extraction_model = _validate_model(
            payload.get("extraction_model") or answer_model, "抽取模型"
        )
    except SecretError:
        return None
    return {
        "base_url": base_url,
        "key": key,
        "answer_model": answer_model,
        "extraction_model": extraction_model,
        "updated_at": payload.get("updated_at"),
    }


def public_view() -> dict:
    """What the browser may see. No key characters, no hash of the key."""
    api = load_api()
    if api is None:
        raw = _read_raw().get("api") or {}
        return {
            "configured": False,
            "base_url": raw.get("base_url") if isinstance(raw, dict) else None,
            "answer_model": raw.get("answer_model") if isinstance(raw, dict) else None,
            "extraction_model": raw.get("extraction_model") if isinstance(raw, dict) else None,
            "has_key": False,
            "updated_at": raw.get("updated_at") if isinstance(raw, dict) else None,
        }
    return {
        "configured": True,
        "base_url": api["base_url"],
        "answer_model": api["answer_model"],
        "extraction_model": api["extraction_model"],
        "has_key": True,
        "updated_at": api["updated_at"],
    }


def save_api(*, base_url: object, api_key: object, answer_model: object,
             extraction_model: object) -> dict:
    """Store the endpoint. An empty key keeps the stored key, if any."""
    base = validate_base_url(base_url)
    answer = _validate_model(answer_model, "回答模型")
    extraction = _validate_model(extraction_model or answer, "抽取模型")
    existing = load_api()
    if isinstance(api_key, str) and api_key.strip():
        key = api_key.strip()
        if len(key) > 400 or any(ord(character) < 32 for character in key):
            raise SecretError("API Key 格式不正确")
        if _KEY_PATTERN.search(base):
            raise SecretError("Base URL 里出现了疑似密钥的内容")
    elif existing is not None:
        key = existing["key"]
    else:
        raise SecretError("首次保存必须填写 API Key")
    payload = {"api": {
        "base_url": base,
        "key": key,
        "answer_model": answer,
        "extraction_model": extraction,
        "updated_at": _now(),
    }}
    _atomic_write(payload)
    return public_view()


def clear_key() -> dict:
    raw = _read_raw()
    api = raw.get("api")
    if isinstance(api, dict):
        api.pop("key", None)
        api["updated_at"] = _now()
        raw["api"] = api
        _atomic_write(raw)
    return public_view()


def redact(text: object, key: str | None = None) -> str:
    """Remove a key and key-shaped strings from text that may reach a browser."""
    message = str(text)
    if key:
        message = message.replace(key, "***")
    return _KEY_PATTERN.sub("***", message)


def file_permissions() -> dict:
    if not SECRETS_PATH.exists():
        return {"exists": False, "mode": None}
    mode = oct(SECRETS_PATH.stat().st_mode & 0o777)
    return {"exists": True, "mode": mode}
