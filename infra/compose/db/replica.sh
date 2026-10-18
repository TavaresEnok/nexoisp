#!/bin/sh
# Réplica em espera do banco do NexoISP: na primeira subida copia o primário (pg_basebackup com slot próprio) e passa a receber
# tudo por replicação contínua. Só leitura. Para assumir no lugar do primário: docs/operacao.md, "Réplica do banco".
set -eu
: "${PRIMARY_HOST:=db}" "${PGDATA:=/var/lib/postgresql/data}"
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "réplica: copiando o primário $PRIMARY_HOST..."
  until pg_isready -h "$PRIMARY_HOST" -U nexo_replica -d postgres >/dev/null 2>&1; do sleep 2; done
  rm -rf "$PGDATA"/* 2>/dev/null || true
  # o slot guarda no primário o que a réplica ainda não recebeu (não se perde se ela ficar fora do ar um tempo)
  psql "host=$PRIMARY_HOST user=nexo_replica dbname=postgres replication=database" -Atc "SELECT 1 FROM pg_replication_slots WHERE slot_name='nexo_replica'" 2>/dev/null | grep -q 1 \
    && SLOT="-S nexo_replica" || SLOT="-C -S nexo_replica"
  pg_basebackup -h "$PRIMARY_HOST" -U nexo_replica -D "$PGDATA" -R -X stream $SLOT -c fast
  chmod 700 "$PGDATA"
  echo "réplica: cópia concluída; entrando em espera"
fi
exec postgres -c hot_standby=on -c max_worker_processes=32 -c max_parallel_workers=30 -c max_parallel_workers_per_gather=30
