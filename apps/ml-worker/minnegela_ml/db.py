from __future__ import annotations

import contextlib
from typing import Any, Iterator

import psycopg
from pgvector.psycopg import register_vector
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import settings

_pool: ConnectionPool | None = None


def _configure(conn: psycopg.Connection) -> None:
    register_vector(conn)


def pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(
            settings.database_url_worker,
            min_size=1,
            max_size=6,
            kwargs={"row_factory": dict_row, "application_name": settings.worker_id},
            configure=_configure,
            open=True,
        )
    return _pool


@contextlib.contextmanager
def connect() -> Iterator[psycopg.Connection[dict[str, Any]]]:
    """A pooled connection. Commit is the caller's job (use `with conn.transaction():`)."""
    with pool().connection() as conn:
        yield conn


def close() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


def ping() -> bool:
    try:
        with connect() as conn:
            conn.execute("select 1")
        return True
    except Exception:
        return False
