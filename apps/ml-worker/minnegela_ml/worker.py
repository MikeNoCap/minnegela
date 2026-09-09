"""Job loop: batches `analyze` to keep the GPU fed, runs `identify`/`recluster`/`retag` one at a time."""
from __future__ import annotations

import logging
import signal
import time
from typing import Callable

from . import db, queue
from .config import settings

log = logging.getLogger(__name__)


class Worker:
    def __init__(self) -> None:
        self.stop = False
        self._last_stale_check = 0.0
        # Imported lazily so the worker boots (and polls) even when ML deps are absent.
        self._handlers: dict[str, Callable[[list[queue.Job]], None]] = {
            "analyze": self._run_analyze_batch,
            "identify": self._run_single("identify"),
            "recluster": self._run_single("recluster"),
            "retag": self._run_single("retag"),
        }

    # -- handlers ---------------------------------------------------------------------
    def _run_analyze_batch(self, jobs: list[queue.Job]) -> None:
        from .jobs.analyze import analyze_batch
        analyze_batch(jobs)

    def _run_single(self, kind: str) -> Callable[[list[queue.Job]], None]:
        def run(jobs: list[queue.Job]) -> None:
            for job in jobs:
                try:
                    if kind == "identify":
                        from .jobs.identify import run_identify
                        out = run_identify(job.payload)
                    elif kind == "retag":
                        from .jobs.retag import run_retag
                        out = run_retag(job.payload)
                    else:
                        from .jobs.recluster import run_recluster
                        out = run_recluster(job.payload)
                    with db.connect() as conn, conn.transaction():
                        queue.complete(conn, job.id)
                    log.info("job %s %s done: %s", job.id, kind, out)
                except Exception as e:  # noqa: BLE001
                    log.exception("job %s %s failed", job.id, kind)
                    with db.connect() as conn, conn.transaction():
                        queue.fail(conn, job.id, e)
        return run

    # -- loop --------------------------------------------------------------------------
    def _install_signals(self) -> None:
        def handler(signum, frame):  # noqa: ANN001
            log.info("signal %s: finishing current batch then exiting", signum)
            self.stop = True
        signal.signal(signal.SIGTERM, handler)
        signal.signal(signal.SIGINT, handler)

    def tick(self) -> int:
        """One poll. Returns the number of jobs processed."""
        now = time.monotonic()
        if now - self._last_stale_check > 300:
            with db.connect() as conn, conn.transaction():
                n = queue.release_stale(conn)
            if n:
                log.warning("released %d stale jobs", n)
            self._last_stale_check = now
        processed = 0
        with db.connect() as conn, conn.transaction():
            batch = queue.claim(conn, ["analyze"], settings.worker_id, settings.ml_batch_size)
        if batch:
            self._handlers["analyze"](batch)
            processed += len(batch)
        for kind in ("identify", "recluster", "retag"):
            with db.connect() as conn, conn.transaction():
                jobs = queue.claim(conn, [kind], settings.worker_id, 1)
            if jobs:
                self._handlers[kind](jobs)
                processed += len(jobs)
        return processed

    def run(self) -> None:
        self._install_signals()
        log.info("ml worker %s polling (device=%s, batch=%d)", settings.worker_id, settings.ml_device, settings.ml_batch_size)
        idle = 0.0
        while not self.stop:
            try:
                n = self.tick()
            except Exception:  # noqa: BLE001
                log.exception("tick failed")
                n = 0
            if n:
                idle = 0.0
                continue
            idle = min(idle + settings.ml_poll_seconds, 15.0)
            time.sleep(idle)
        db.close()
        log.info("ml worker stopped")
