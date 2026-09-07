#!/usr/bin/env bash
# First-time setup on a fresh server. Idempotent.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] || { cp .env.example .env; echo "Wrote .env from .env.example; edit it before continuing."; exit 1; }
chmod 600 .env
COMPOSE="${COMPOSE:-podman compose}"
$COMPOSE -f infra/compose.yml up -d postgres
echo "Waiting for postgres..."; sleep 5
pnpm install --frozen-lockfile
pnpm db:migrate
$COMPOSE -f infra/compose.yml up -d --build
echo "Stack is up. Check: $COMPOSE -f infra/compose.yml ps"
