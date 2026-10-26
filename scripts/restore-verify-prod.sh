#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec docker compose --env-file "${NEXO_PROD_ENV_FILE:-infra/prod/.env}" -p "${NEXO_PROD_PROJECT:-nexoisp-prod}" -f infra/prod/docker-compose.yml run --rm -e "NEXO_RESTORE_DATABASE=$1" migrate verify-restore
