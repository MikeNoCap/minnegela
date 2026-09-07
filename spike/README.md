# Phase 0 spike

Throwaway scripts for docs/DESIGN.md §24 Phase 0. The reusable parts live in `apps/ml-worker`:

- `uv run minnegela-ml analyze-folder <dir>` runs faces + CLIP over a folder and writes an HTML contact sheet.
- `apps/ml-worker/minnegela_ml/wbs.py` is the clustering algorithm; feed it a Parquet/CSV of your own metadata to judge events before wiring the app.

Put photo folders under `spike/data/` (git-ignored) and outputs under `spike/out/`.
