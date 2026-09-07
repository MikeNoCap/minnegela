# Minnegela ML worker. Target: one Linux box with a Pascal GPU (GTX 1060/1080, sm_61).
#
# Pascal notes (DESIGN §19):
#  - PyTorch wheels for CUDA 12.8+ drop sm_61; pyproject pins torch 2.6 from the cu126 index.
#  - fp16 on Pascal runs at 1/64 rate: everything is fp32, no autocast anywhere.
#  - Host driver must stay on a Pascal-supporting branch (<= 580 series). Pin it; do not auto-upgrade.
#  - onnxruntime-gpu 1.17-1.19 builds work with CUDA 12 + cuDNN 9.
# For a CPU-only box build with:  --build-arg ML_EXTRA=ml-cpu  and set ML_DEVICE=cpu.
ARG ML_EXTRA=ml
FROM docker.io/nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04 AS base
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 UV_LINK_MODE=copy
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
ARG ML_EXTRA
COPY apps/ml-worker/pyproject.toml apps/ml-worker/uv.lock apps/ml-worker/.python-version ./
RUN uv python install && uv sync --frozen --no-dev --no-install-project --extra ${ML_EXTRA}
COPY apps/ml-worker/ ./
RUN uv sync --frozen --no-dev --extra ${ML_EXTRA}

# Models (buffalo_l ~300 MB, OpenCLIP ViT-B/16 ~600 MB) are downloaded on first start into MODEL_DIR,
# which compose mounts as the `ml-models` volume so the download happens once.
ENV MODEL_DIR=/models ML_DEVICE=cuda WORKER_CACHE_DIR=/cache
VOLUME ["/models", "/cache"]
EXPOSE 4100
# The worker and the text-embed endpoint share one process image; compose runs `worker` and can add
# a second container with `serve` if the API's semantic search needs it in parallel.
CMD ["uv", "run", "--no-sync", "minnegela-ml", "worker"]
