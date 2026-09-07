# ADR 0003: Target server hardware differs from the design assumptions

Status: accepted, 2026-09-07

## Context
docs/DESIGN.md was written for a GTX 1080 (8 GB VRAM) box. The actual target server is:

| Part | Actual |
|---|---|
| CPU | Intel Core i5-8400, 6 cores |
| RAM | 8 GB DDR4 (one DIMM, second slot free, board supports 32 GB) |
| GPU | NVIDIA GTX 1060 6 GB (Pascal GP106, compute 6.1) |
| OS | Ubuntu 24.04, headless, currently on the nouveau driver |

## Decision
Keep the design. It holds on this hardware with the following adjustments:

- **VRAM**: SCRFD + ArcFace + OpenCLIP ViT-B/16 in fp32 need under 1 GB plus batch activations; 6 GB is enough. Keep `ML_BATCH_SIZE` at 32 rather than 64 until measured. ViT-L/14 stays out of scope.
- **RAM is the tight resource.** Postgres, the Node API, Next.js, the media worker and a PyTorch process together want more than 8 GB under load. Set `shared_buffers` to 1 GB, cap the ML worker at one process, `WORKER_CONCURRENCY=2` for the media worker, and add the second 8 GB DIMM before Phase 2 (cheap, and the board supports it).
- **Driver**: the box runs nouveau today. Install the proprietary NVIDIA driver from the 570/580 series (the last branches with Pascal support) and the NVIDIA container toolkit before Phase 0 task 4; pin the package so unattended upgrades cannot move it.
- **NVENC**: GP106 has the same NVENC generation as GP104; `h264_nvenc` transcodes work as designed.

## Consequences
Phase 0 task 4 (GPU stack verification) must run on this box with the real driver before thresholds are tuned. Everything else in the roadmap is unchanged.
