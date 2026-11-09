"""One dedicated asyncio loop for every database and model call.

The HTTP server is a threaded stdlib server, but asyncpg pools bind to the
loop that created them. All ``sci_rag`` work therefore runs on this one loop;
handlers submit coroutines to it and block for the result (or pump a queue for
streaming responses).
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Coroutine
from concurrent.futures import Future
from typing import Any


class AsyncRuntime:
    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run, name="pcmem-async", daemon=True)
        self._ready = threading.Event()
        self._thread.start()
        self._ready.wait(timeout=10)

    def _run(self) -> None:
        asyncio.set_event_loop(self.loop)
        self._ready.set()
        self.loop.run_forever()

    def submit(self, coro: Coroutine[Any, Any, Any]) -> Future:
        return asyncio.run_coroutine_threadsafe(coro, self.loop)

    def run(self, coro: Coroutine[Any, Any, Any], timeout: float | None = 120.0) -> Any:
        return self.submit(coro).result(timeout=timeout)

    def shutdown(self) -> None:
        self.loop.call_soon_threadsafe(self.loop.stop)
        self._thread.join(timeout=5)
