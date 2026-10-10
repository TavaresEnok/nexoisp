#!/bin/sh
set -e
: "${RADIUS_NAS_SECRET:?defina RADIUS_NAS_SECRET}" "${RADIUS_NAS_NET:?defina RADIUS_NAS_NET (ex.: 10.0.0.1/32)}"
DB=/data/radius/radius.sqlite
mkdir -p /data/radius
if [ -n "$RADIUS_SECONDARY" ]; then
  # segunda instância: nunca cria o banco; espera a principal inicializá-lo
  n=0; while [ ! -f "$DB" ] && [ $n -lt 60 ]; do n=$((n+1)); sleep 1; done
  [ -f "$DB" ] || { echo "banco do RADIUS não encontrado em $DB (suba a instância principal primeiro)"; exit 1; }
elif [ ! -f "$DB" ]; then
  sqlite3 "$DB" < /etc/raddb/mods-config/sql/main/sqlite/schema.sql
  sqlite3 "$DB" "pragma journal_mode=wal;" >/dev/null
fi
# o agente (outro usuário) grava no mesmo arquivo; SQLite herda dono/modo nos arquivos -wal/-shm
chown 10001:10001 /data && chown -R 10001:10001 /data/radius
chmod 2770 /data/radius && chmod 660 "$DB"
exec "$@"
