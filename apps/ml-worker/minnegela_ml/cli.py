from __future__ import annotations

import argparse
import logging
import sys

from . import __version__
from .config import settings


def _logging(verbose: bool) -> None:
    logging.basicConfig(level=logging.DEBUG if verbose else logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("botocore").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="minnegela-ml", description="Minnegela ML worker")
    p.add_argument("--version", action="version", version=__version__)
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("worker", help="consume analyze/identify/recluster jobs from Postgres")
    s = sub.add_parser("serve", help="text-embedding HTTP endpoint (POST /embed-text)")
    s.add_argument("--port", type=int, default=settings.ml_serve_port)
    s.add_argument("--host", default="0.0.0.0")
    r = sub.add_parser("recluster", help="run WBS for a group now")
    r.add_argument("--group", required=True)
    r.add_argument("--full", action="store_true")
    r.add_argument("--from", dest="from_", default=None, help="ISO timestamp")
    r.add_argument("--to", default=None, help="ISO timestamp")
    i = sub.add_parser("identify", help="run identity matching for a group now")
    i.add_argument("--group", required=True)
    a = sub.add_parser("analyze-folder", help="spike helper: run models on local files, write an HTML contact sheet (no DB)")
    a.add_argument("folder")
    a.add_argument("--out", default="analyze-folder.html")
    a.add_argument("--limit", type=int, default=500)
    sub.add_parser("check-models", help="try to load the models and report")

    args = p.parse_args(argv)
    _logging(args.verbose)

    if args.cmd == "worker":
        from .worker import Worker
        Worker().run()
        return 0
    if args.cmd == "serve":
        import uvicorn
        uvicorn.run("minnegela_ml.server:app", host=args.host, port=args.port, log_level="info")
        return 0
    if args.cmd == "recluster":
        from .jobs.recluster import run_recluster
        payload = {"groupId": args.group, "full": args.full}
        if args.from_:
            payload["from"] = args.from_
        if args.to:
            payload["to"] = args.to
        summary = run_recluster(payload)
        print(summary)
        return 0
    if args.cmd == "identify":
        from .jobs.identify import run_identify
        print(run_identify({"groupId": args.group}))
        return 0
    if args.cmd == "analyze-folder":
        from .spike import analyze_folder
        analyze_folder(args.folder, args.out, args.limit)
        return 0
    if args.cmd == "check-models":
        from .models.clip import clip
        from .models.faces import faces
        try:
            c = clip()
            print("clip ok:", c.model_tag)
        except Exception as e:  # noqa: BLE001
            print("clip unavailable:", e)
        try:
            f = faces()
            print("faces ok:", f.model_tag)
        except Exception as e:  # noqa: BLE001
            print("faces unavailable:", e)
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
