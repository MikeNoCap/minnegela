import os
from pathlib import Path

import pytest
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[3]
load_dotenv(ROOT / ".env", override=False)
os.environ.setdefault("WORKER_CACHE_DIR", str(Path(__file__).parent / ".cache"))


@pytest.fixture(scope="session")
def db_available() -> bool:
    from minnegela_ml import db
    return db.ping()


@pytest.fixture
def conn(db_available):
    if not db_available:
        pytest.skip("DATABASE_URL_WORKER not reachable")
    from minnegela_ml import db
    with db.connect() as c:
        # autocommit so bare selects do not open an implicit transaction that hides the test's
        # committed rows from the worker's own pooled connections
        c.autocommit = True
        try:
            yield c
        finally:
            c.autocommit = False
