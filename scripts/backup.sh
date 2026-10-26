#!/usr/bin/env bash
# Backup e restauração do PostgreSQL do NexoISP (formato custom do pg_dump + SHA-256).
#   backup.sh backup [dir]            -> gera dir/nexo-AAAAMMDD-HHMMSS.dump (+ .sha256)
#   backup.sh restore-check <arquivo> -> restaura em banco temporário e confere o snapshot e isolamento
#   backup.sh restore <arquivo> --yes -> SUBSTITUI o banco principal pelo backup (para a API durante a operação)
# Variáveis: NEXO_DB_CONTAINER (padrão nexoisp-db-1), NEXO_API_SERVICE_STOP / _START (comandos opcionais).
#   NEXO_BACKUP_COPY: comando que leva o backup para FORA deste host; recebe o .dump, o .sha256 e o .manifest.json como argumentos.
#     Ex.: NEXO_BACKUP_COPY=/opt/nexo/enviar-backup.sh  (um script seu com scp, rclone ou o cliente do seu armazenamento)
#     Se o comando falhar, o backup local fica, mas o script termina com erro (para o agendador alertar).
set -euo pipefail
umask 077
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DBC="${NEXO_DB_CONTAINER:-nexoisp-db-1}"
DBP="${NEXO_DB_PORT:-5432}"
psqlc() { docker exec -i "$DBC" psql -v ON_ERROR_STOP=1 -X -q -p "$DBP" -U nexo_owner "$@"; }
TABLES="tenants users subscribers contracts plan_versions service_resources operations invoices payments gateway_events audit_events"
counts() { for t in $TABLES; do printf "%s=%s " "$t" "$(psqlc -d "$1" -Atc "select count(*) from $t")"; done; }
verify() { [ -f "$1.sha256" ] && (cd "$(dirname "$1")" && sha256sum -c --quiet "$(basename "$1").sha256") || { echo "ERRO: soma de verificação ausente ou inválida para $1"; exit 1; }; }
load() { # banco arquivo
  psqlc -d postgres -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname = 'nexo_app') then create role nexo_app nologin; end if; if not exists (select 1 from pg_roles where rolname = 'nexo_radius') then create role nexo_radius nologin; end if; if not exists (select 1 from pg_roles where rolname = 'nexo_go') then create role nexo_go nologin inherit; grant nexo_app to nexo_go; end if; end \$\$"
  psqlc -d postgres -c "drop database if exists $1 with (force)" -c "create database $1"
  docker exec -i "$DBC" pg_restore -p "$DBP" -U nexo_owner -d "$1" --no-owner --exit-on-error < "$2"
}
case "${1:-}" in
  backup)
    dir="${2:-backups}"; mkdir -p "$dir"; f="$(mktemp "$dir/nexo-$(date +%Y%m%d-%H%M%S)-XXXXXX.dump")"
    python3 "$SCRIPT_DIR/backup-manifest.py" capture "$f"
    (cd "$dir" && sha256sum "$(basename "$f")" "$(basename "$f").manifest.json" > "$(basename "$f").sha256")
    chmod 600 "$f"; echo "backup: $f ($(du -h "$f" | cut -f1))"
    if [ -n "${NEXO_BACKUP_COPY:-}" ]; then
      $NEXO_BACKUP_COPY "$f" "$f.sha256" "$f.manifest.json" || { echo "ERRO: a cópia para fora do host falhou; o backup existe só neste servidor"; exit 1; }
      echo "cópia externa: ok"
    else echo "AVISO: NEXO_BACKUP_COPY não definido — o backup está só neste host (mesmo domínio de falha do banco)"; fi ;;
  restore-check)
    f="$2"; verify "$f"
    [ -f "$f.manifest.json" ] || { echo "ERRO: backup antigo sem manifesto de snapshot; a restauração continua disponível, mas esta prova exige um backup novo"; exit 1; }
    check_db="nexo_restore_check_${$}_${RANDOM}"
    cleanup_check() { psqlc -d postgres -c "drop database if exists $check_db with (force)" >/dev/null; }
    trap cleanup_check EXIT
    load "$check_db" "$f"
    python3 "$SCRIPT_DIR/backup-manifest.py" verify "$f" --database "$check_db"
    psqlc -d "$check_db" -f - < "$SCRIPT_DIR/restore-isolation.sql"
    if [ -n "${NEXO_RESTORE_VERIFY:-}" ]; then
      $NEXO_RESTORE_VERIFY "$check_db"
    else
      echo "AVISO: configure NEXO_RESTORE_VERIFY para conferir as chaves criptográficas; ./nexo prod restore-check já inclui essa prova"
    fi
    echo "restore-check OK (snapshot e isolamento conferidos)" ;;
  restore)
    f="$2"; [ "${3:-}" = "--yes" ] || { echo "confirme com --yes: o banco principal será SUBSTITUÍDO"; exit 1; }
    verify "$f"; eval "${NEXO_API_SERVICE_STOP:-true}"
    load nexo "$f"; eval "${NEXO_API_SERVICE_START:-true}"
    echo "banco restaurado de $f: $(counts nexo)" ;;
  *) sed -n '2,6p' "$0"; exit 1 ;;
esac
