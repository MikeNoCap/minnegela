"""Postgres jobs table consumer/producer. Mirrors packages/db/src/jobs.ts exactly so Node and
Python workers share one queue (DESIGN §3.4, §13.2)."""
from __future__ import annotations

import json
import traceback
from dataclasses import dataclass
from typing import Any, Sequence

import psycopg

ML_KINDS: tuple[str, ...] = ("analyze", "identify", "recluster", "retag")


@dataclass
class Job:
    id: int
    kind: str
    payload: dict[str, Any]
    attempts: int
    max_attempts: int


def dedupe_key(kind: str, payload: dict[str, Any]) -> str | None:
    if kind == "recluster":
        return f"recluster:{payload['groupId']}"
    if kind == "identify":
        return None if payload.get("blobId") else f"identify:{payload['groupId']}"
    if kind == "titles":
        return None if payload.get("eventIds") else f"titles:{payload['groupId']}"
    if kind == "retag":
        return f"retag:{payload['groupId']}"
    return None


def enqueue(conn: psycopg.Connection, kind: str, payload: dict[str, Any], *, priority: int = 0,
            run_after_seconds: float = 0, max_attempts: int = 5) -> None:
    """Insert a job; jobs with a dedupe key coalesce with a pending one (debounce + window merge)."""
    key = dedupe_key(kind, payload)
    body = json.dumps(payload)
    if key is None:
        conn.execute(
            "insert into jobs (kind, payload, priority, run_after, max_attempts) "
            "values (%s, %s::jsonb, %s, now() + make_interval(secs => %s), %s)",
            (kind, body, priority, run_after_seconds, max_attempts),
        )
        return
    conn.execute(
        """
        insert into jobs (kind, payload, priority, dedupe_key, run_after, max_attempts)
        values (%s, %s::jsonb, %s, %s, now() + make_interval(secs => %s), %s)
        on conflict (dedupe_key) where dedupe_key is not null and done_at is null and locked_by is null
        do update set
          run_after = greatest(jobs.run_after, excluded.run_after),
          priority = greatest(jobs.priority, excluded.priority),
          payload = jobs.payload || excluded.payload
            || case when jobs.payload ? 'from' and excluded.payload ? 'from'
                 then jsonb_build_object('from', least(jobs.payload->>'from', excluded.payload->>'from')) else '{}'::jsonb end
            || case when jobs.payload ? 'to' and excluded.payload ? 'to'
                 then jsonb_build_object('to', greatest(jobs.payload->>'to', excluded.payload->>'to')) else '{}'::jsonb end
        """,
        (kind, body, priority, key, run_after_seconds, max_attempts),
    )


def claim(conn: psycopg.Connection, kinds: Sequence[str], worker_id: str, limit: int) -> list[Job]:
    rows = conn.execute(
        """
        with picked as (
          select id from jobs
          where kind = any(%s::text[])
            and done_at is null and locked_by is null and run_after <= now()
          order by priority desc, run_after
          limit %s
          for update skip locked
        )
        update jobs j set locked_by = %s, locked_at = now(), attempts = j.attempts + 1
        from picked where j.id = picked.id
        returning j.id, j.kind, j.payload, j.attempts, j.max_attempts
        """,
        (list(kinds), limit, worker_id),
    ).fetchall()
    return [Job(id=int(r["id"]), kind=r["kind"], payload=r["payload"], attempts=r["attempts"], max_attempts=r["max_attempts"]) for r in rows]


def complete(conn: psycopg.Connection, job_id: int) -> None:
    conn.execute("update jobs set done_at = now(), locked_by = null, error = null where id = %s", (job_id,))


def fail(conn: psycopg.Connection, job_id: int, err: BaseException | str) -> None:
    """Release with attempts² minutes of backoff; park (done_at set, error kept) after max_attempts."""
    if isinstance(err, BaseException):
        message = f"{type(err).__name__}: {err}\n" + "".join(traceback.format_exception(err))
    else:
        message = str(err)
    conn.execute(
        """
        update jobs set
          error = %s,
          locked_by = case when attempts >= max_attempts then locked_by else null end,
          done_at = case when attempts >= max_attempts then now() else null end,
          run_after = now() + make_interval(mins => attempts * attempts)
        where id = %s
        """,
        (message[:4000], job_id),
    )


def release_stale(conn: psycopg.Connection, stale_minutes: int = 30) -> int:
    rows = conn.execute(
        "update jobs set locked_by = null, locked_at = null where done_at is null and locked_by is not null "
        "and locked_at < now() - make_interval(mins => %s) returning id",
        (stale_minutes,),
    ).fetchall()
    return len(rows)
