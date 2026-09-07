from __future__ import annotations

import os
import socket
from pathlib import Path

from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict


def _load_root_env() -> None:
    """Load the repo root .env if present (dev convenience; production uses real env vars)."""
    here = Path(__file__).resolve()
    for parent in [here.parent.parent, *here.parents]:
        candidate = parent / ".env"
        if candidate.is_file():
            load_dotenv(candidate, override=False)
            return


_load_root_env()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    database_url_worker: str = "postgres://minnegela_worker:minnegela@localhost:5432/minnegela"
    s3_endpoint: str = "http://localhost:9000"
    s3_bucket: str = "minnegela-media"
    s3_region: str = "auto"
    s3_access_key_id: str = "minnegela"
    s3_secret_access_key: str = "minnegela-dev-secret"
    s3_force_path_style: bool = True

    worker_cache_dir: str = "./worker-cache"
    worker_cache_gb: float = 50.0
    worker_id: str = f"ml-{socket.gethostname()}-{os.getpid()}"

    ml_device: str = "cuda"  # cuda | cpu
    ml_batch_size: int = 64
    model_dir: str = os.path.expanduser("~/.cache/minnegela-models")
    ml_poll_seconds: float = 2.0
    ml_serve_port: int = 4100
    ml_face_det_size: int = 640


settings = Settings()
