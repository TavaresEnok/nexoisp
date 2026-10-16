#!/usr/bin/env bash
# Go production entrypoint; credentials are read only by Compose, never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
env_file="${NEXO_PROD_ENV_FILE:-infra/prod/.env}"
project="${NEXO_PROD_PROJECT:-nexoisp-prod}"
compose=(docker compose --env-file "$env_file" -p "$project" -f infra/prod/docker-compose.yml)
case "${1:-}" in
  up)
    "${compose[@]}" config --quiet
    "${compose[@]}" build api migrate vpn caddy
    "${compose[@]}" up -d --wait db
    "${compose[@]}" run --rm migrate prepare
    "${compose[@]}" up -d
    ;;
  db) shift; "${compose[@]}" run --rm migrate "$@" ;;
  ps|logs|down|config) "${compose[@]}" "$@" ;;
  backup|restore-check) NEXO_DB_CONTAINER="$project-db-1" bash scripts/backup.sh "$@" ;;
  restore)
    running=();while read -r service;do case "$service" in api|api-go|vpn|radius|radius2) running+=("$service");; esac;done < <("${compose[@]}" ps --services --filter status=running)
    # The restore tool validates its --yes argument and checksum before stopping anything.
    printf -v base '%q ' "${compose[@]}"
    stop=true;start=true
    if ((${#running[@]}));then
      printf -v services '%q ' "${running[@]}"
      stop="${base}stop $services";start="${base}run --rm migrate prepare && ${base}start $services"
    fi
    NEXO_DB_CONTAINER="$project-db-1" NEXO_API_SERVICE_STOP="$stop" NEXO_API_SERVICE_START="$start" bash scripts/backup.sh "$@"
    ;;
  *) printf '%s\n' 'uso: ./nexo prod {up|db <comando>|ps|logs|down|backup|restore-check|restore <arquivo> --yes}';exit 2 ;;
esac
