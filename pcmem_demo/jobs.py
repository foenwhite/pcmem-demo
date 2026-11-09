"""In-memory state of the one build job the demo allows at a time."""

from __future__ import annotations

import threading
import time
from datetime import UTC, datetime
from typing import Any


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


class BuildJob:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state: dict[str, Any] = {
            "status": "idle",
            "phase": "",
            "percent": 0,
            "started_at": None,
            "updated_at": None,
            "finished_at": None,
            "log": [],
            "result": None,
            "error": None,
        }

    def begin(self) -> bool:
        with self._lock:
            if self._state["status"] == "running":
                return False
            self._state.update(
                status="running",
                phase="开始",
                percent=0,
                started_at=_now(),
                updated_at=_now(),
                finished_at=None,
                log=[],
                result=None,
                error=None,
            )
            return True

    def progress(self, phase: str, message: str, percent: int | None = None,
                 **extra: Any) -> None:
        with self._lock:
            if percent is not None:
                self._state["percent"] = max(0, min(100, int(percent)))
            self._state["phase"] = phase
            self._state["updated_at"] = _now()
            entry = {"time": _now(), "phase": phase, "message": message, **extra}
            log = self._state["log"]
            log.append(entry)
            if len(log) > 240:
                del log[: len(log) - 240]

    def finish(self, result: dict[str, Any]) -> None:
        with self._lock:
            self._state.update(
                status="done", phase="完成", percent=100, result=result,
                finished_at=_now(), updated_at=_now(),
            )

    def fail(self, message: str) -> None:
        with self._lock:
            self._state.update(
                status="failed", phase="失败", error=message,
                finished_at=_now(), updated_at=_now(),
            )

    def is_running(self) -> bool:
        with self._lock:
            return self._state["status"] == "running"

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            snapshot = dict(self._state)
            snapshot["log"] = list(self._state["log"])
            if self._state["status"] == "running" and self._state["started_at"]:
                try:
                    started = datetime.fromisoformat(self._state["started_at"])
                    snapshot["elapsed_s"] = round(
                        (datetime.now(UTC) - started).total_seconds(), 1
                    )
                except ValueError:
                    pass
            return snapshot

    def wait(self, timeout: float = 30.0) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self.is_running():
                return self.snapshot()
            time.sleep(0.1)
        return self.snapshot()
