"""S3 storage adapter with a disk LRU cache and concurrent prefetch (DESIGN §13.3)."""
from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Iterable

import boto3
from botocore.config import Config

from .config import settings

log = logging.getLogger(__name__)


class Storage:
    def __init__(self, cache_dir: str | None = None, cache_gb: float | None = None) -> None:
        self.bucket = settings.s3_bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint,
            region_name=settings.s3_region,
            aws_access_key_id=settings.s3_access_key_id,
            aws_secret_access_key=settings.s3_secret_access_key,
            # pool sized for the 16-thread prefetch; timeouts so a dead R2 connection fails fast and retries
            config=Config(
                s3={"addressing_style": "path" if settings.s3_force_path_style else "virtual"},
                retries={"max_attempts": 4, "mode": "standard"},
                max_pool_connections=32, connect_timeout=10, read_timeout=60,
            ),
        )
        self.cache_dir = Path(cache_dir or settings.worker_cache_dir) / "ml"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.cache_bytes = int((cache_gb or settings.worker_cache_gb) * 1024**3)
        self._lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=16, thread_name_prefix="s3-prefetch")

    # -- cache -----------------------------------------------------------------
    def _path_for(self, key: str) -> Path:
        h = hashlib.sha1(key.encode()).hexdigest()
        ext = os.path.splitext(key)[1] or ".bin"
        return self.cache_dir / h[:2] / f"{h}{ext}"

    def get(self, key: str) -> Path:
        """Fetch `key` into the cache (if missing) and return the local path."""
        p = self._path_for(key)
        if p.is_file():
            os.utime(p, None)
            return p
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + f".{os.getpid()}.{threading.get_ident()}.tmp")
        self.client.download_file(self.bucket, key, str(tmp))
        os.replace(tmp, p)
        self._maybe_evict()
        return p

    def get_bytes(self, key: str) -> bytes:
        return self.get(key).read_bytes()

    def prefetch(self, keys: Iterable[str]) -> None:
        """Fetch many keys concurrently (16 in flight) so the GPU loop never waits on R2."""
        futures = [self._pool.submit(self.get, k) for k in keys]
        for f in futures:
            try:
                f.result()
            except Exception as e:  # individual misses are reported by the later get()
                log.warning("prefetch failed: %s", e)

    def _maybe_evict(self) -> None:
        with self._lock:
            files = [(p.stat().st_mtime, p.stat().st_size, p) for p in self.cache_dir.rglob("*") if p.is_file() and not p.name.endswith(".tmp")]
            total = sum(s for _, s, _ in files)
            if total <= self.cache_bytes:
                return
            files.sort()
            for _, size, p in files:
                try:
                    p.unlink()
                    total -= size
                except OSError:
                    pass
                if total <= self.cache_bytes * 0.9:
                    break

    # -- writes ---------------------------------------------------------------------
    def put_bytes(self, key: str, data: bytes, content_type: str) -> None:
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)

    def put_bytes_async(self, key: str, data: bytes, content_type: str) -> Future[None]:
        """Upload on the pool; call `.result()` before committing anything that references `key`."""
        return self._pool.submit(self.put_bytes, key, data, content_type)

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
            return True
        except self.client.exceptions.ClientError:
            return False


_storage: Storage | None = None


def storage() -> Storage:
    global _storage
    if _storage is None:
        _storage = Storage()
    return _storage
