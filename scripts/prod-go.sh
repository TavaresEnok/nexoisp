#!/usr/bin/env bash
# Go production entrypoint; credentials are read only by Compose, never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
env_file="${NEXO_PROD_ENV_FILE:-infra/prod/.env}"
project="${NEXO_PROD_PROJECT:-nexoisp-prod}"
compose=(docker compose --env-file "$env_file" -p "$project" -f infra/prod/docker-compose.yml)

# The backup runs on the host, while Compose reads its variables from env_file.
# Read the two operational settings without sourcing the file: production secrets
# are data, never shell code.
env_value() {
  awk -v wanted="$1" 'index($0, wanted "=") == 1 { sub(/^[^=]*=/, ""); sub(/\r$/, ""); print; exit }' "$env_file"
}
backup_env=()
backup_copy="$(env_value NEXO_BACKUP_COPY)"
backup_dir="$(env_value NEXO_BACKUP_DIR)"
if [ -n "$backup_copy" ]; then backup_env+=("NEXO_BACKUP_COPY=$backup_copy"); fi
if [ -n "$backup_dir" ]; then backup_env+=("NEXO_BACKUP_DIR=$backup_dir"); fi
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
  backup)
    backup_args=(backup "${2:-${backup_dir:-backups}}")
    env "${backup_env[@]}" NEXO_DB_CONTAINER="$project-db-1" bash scripts/backup.sh "${backup_args[@]}"
    ;;
  restore-check) NEXO_DB_CONTAINER="$project-db-1" bash scripts/backup.sh "$@" ;;
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
