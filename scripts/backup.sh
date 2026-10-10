#!/usr/bin/env bash
# Backup e restauração do PostgreSQL do NexoISP (formato custom do pg_dump + SHA-256).
#   backup.sh backup [dir]            -> gera dir/nexo-AAAAMMDD-HHMMSS.dump (+ .sha256)
#   backup.sh restore-check <arquivo> -> restaura em banco temporário, compara contagens com o banco atual e remove
#   backup.sh restore <arquivo> --yes -> SUBSTITUI o banco principal pelo backup (para a API durante a operação)
# Variáveis: NEXO_DB_CONTAINER (padrão nexoisp-db-1), NEXO_API_SERVICE_STOP / _START (comandos opcionais).
set -euo pipefail
DBC="${NEXO_DB_CONTAINER:-nexoisp-db-1}"
psqlc() { docker exec -i "$DBC" psql -v ON_ERROR_STOP=1 -q -U nexo_owner "$@"; }
TABLES="tenants users subscribers contracts plan_versions service_resources operations invoices payments gateway_events audit_events"
counts() { for t in $TABLES; do printf "%s=%s " "$t" "$(psqlc -d "$1" -Atc "select count(*) from $t")"; done; }
verify() { [ -f "$1.sha256" ] && (cd "$(dirname "$1")" && sha256sum -c --quiet "$(basename "$1").sha256") || { echo "ERRO: soma de verificação ausente ou inválida para $1"; exit 1; }; }
load() { # banco arquivo
  psqlc -d postgres -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname = 'nexo_app') then create role nexo_app nologin; end if; end \$\$"
  psqlc -d postgres -c "drop database if exists $1 with (force)" -c "create database $1"
  docker exec -i "$DBC" pg_restore -U nexo_owner -d "$1" --no-owner --exit-on-error < "$2"
}
case "${1:-}" in
  backup)
    dir="${2:-backups}"; mkdir -p "$dir"; f="$dir/nexo-$(date +%Y%m%d-%H%M%S).dump"
    docker exec "$DBC" pg_dump -U nexo_owner -Fc nexo > "$f"
    (cd "$dir" && sha256sum "$(basename "$f")" > "$(basename "$f").sha256")
    chmod 600 "$f"; echo "backup: $f ($(du -h "$f" | cut -f1))" ;;
  restore-check)
    f="$2"; verify "$f"; load nexo_restore_check "$f"
    a="$(counts nexo_restore_check)"; b="$(counts nexo)"
    rls="$(psqlc -d nexo_restore_check -Atc "select count(*) from pg_policies where schemaname='public'")"
    psqlc -d postgres -c "drop database nexo_restore_check with (force)"
    echo "restaurado: $a"; echo "atual:      $b"; echo "políticas RLS restauradas: $rls"
    [ "$rls" -gt 0 ] || { echo "ERRO: políticas RLS ausentes no backup restaurado"; exit 1; }
    echo "restore-check OK (diferenças de contagem = alterações posteriores ao backup)" ;;
  restore)
    f="$2"; [ "${3:-}" = "--yes" ] || { echo "confirme com --yes: o banco principal será SUBSTITUÍDO"; exit 1; }
    verify "$f"; eval "${NEXO_API_SERVICE_STOP:-true}"
    load nexo "$f"; eval "${NEXO_API_SERVICE_START:-true}"
    echo "banco restaurado de $f: $(counts nexo)" ;;
  *) sed -n '2,6p' "$0"; exit 1 ;;
esac
