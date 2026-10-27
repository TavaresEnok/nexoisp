"""Persistência local (SQLite) de tentativas, etapas e resultados — ADR-008.
Sem registro durável da tentativa, o agente não inicia escrita no equipamento. Segredos não são gravados aqui."""
import json
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any, Optional

SCHEMA = """
create table if not exists attempts (
  attempt_id text primary key,
  operation_id text not null,
  resource_id text not null,
  device_id text not null,
  action text not null,
  desired_version integer not null,
  envelope text not null,
  status text not null,            -- RECEIVED | EXECUTING | VERIFYING | DONE
  steps text not null default '[]',
  outcome text,                    -- JSON do resultado final (null se encerrada sem resultado)
  reported integer not null default 0,
  created_at text not null,
  updated_at text not null
);
create index if not exists attempts_op on attempts (operation_id);
create table if not exists kv (key text primary key, value text not null);
create table if not exists resources (resource_id text primary key, device_id text not null, username text not null);
create table if not exists onus (onu_id text primary key, device_id text not null, serial text not null);
"""
# Schema local versionado. Banco novo nasce na versão 1 (SCHEMA acima) e recebe as migrações em ordem.
MIGRATIONS = {
    2: "alter table attempts add column agent_version text",   # qual versão do agente executou a tentativa (diagnóstico pós-atualização)
}
LOCAL_SCHEMA_VERSION = 2


def backup_path(path: str, version: int) -> str:
    return f"{path}.bak-v{version}"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, path: str):
        self._db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        self._db.execute("pragma journal_mode=wal")
        self._db.execute("pragma synchronous=full")
        self._db.executescript(SCHEMA)
        v = int(self.get_kv("schema_version") or 1)
        if v > LOCAL_SCHEMA_VERSION:
            raise RuntimeError(f"banco local criado por versão mais nova do agente (schema {v}); para voltar à versão anterior use "
                               f"'python -m nexo_agent.rollback' (restaura a cópia feita antes da atualização)")
        if v < LOCAL_SCHEMA_VERSION and self._db.execute("select 1 from attempts limit 1").fetchone() is None and self.get_kv("schema_version") is None:
            pass  # banco recém-criado: nada a preservar
        elif v < LOCAL_SCHEMA_VERSION:
            # cópia íntegra ANTES de alterar o schema: é o que permite voltar ao binário anterior
            dst = sqlite3.connect(backup_path(path, v))
            try:
                self._db.backup(dst)
            finally:
                dst.close()
        for target in range(v + 1, LOCAL_SCHEMA_VERSION + 1):
            self._db.execute("begin immediate")
            try:
                self._db.execute(MIGRATIONS[target])
                self._db.execute("insert into kv (key, value) values ('schema_version', ?) on conflict(key) do update set value = excluded.value", (str(target),))
                self._db.execute("commit")
            except Exception:
                self._db.execute("rollback")   # atualização interrompida: o banco continua na versão anterior, íntegro
                raise
        if self.get_kv("schema_version") is None:
            self.set_kv("schema_version", str(LOCAL_SCHEMA_VERSION))

    def _x(self, sql: str, args: tuple = ()):
        with self._lock:
            return self._db.execute(sql, args)

    def get_kv(self, key: str) -> Optional[str]:
        r = self._x("select value from kv where key = ?", (key,)).fetchone()
        return r["value"] if r else None

    def set_kv(self, key: str, value: str):
        self._x("insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value", (key, value))

    # --- mapa de recursos conhecidos (para observações periódicas) ---
    def upsert_resource(self, resource_id: str, device_id: str, username: str):
        self._x("insert into resources values (?,?,?) on conflict(resource_id) do update set device_id=excluded.device_id, username=excluded.username",
                (resource_id, device_id, username))

    def resources(self) -> list[sqlite3.Row]:
        return self._x("select * from resources").fetchall()

    def upsert_onu(self, onu_id: str, device_id: str, serial: str):
        self._x("insert into onus values (?,?,?) on conflict(onu_id) do update set device_id=excluded.device_id, serial=excluded.serial", (onu_id, device_id, serial))

    def onus(self) -> list[sqlite3.Row]:
        return self._x("select * from onus").fetchall()

    # --- tentativas ---
    def record_attempt(self, attempt_id: str, env, raw: str):
        t = now_iso()
        from . import __version__
        self._x("insert or ignore into attempts (attempt_id, operation_id, resource_id, device_id, action, desired_version, envelope, status, created_at, updated_at, agent_version)"
                " values (?,?,?,?,?,?,?,?,?,?,?)",
                (attempt_id, env.operation_id, env.resource_id, env.device_id, env.action, env.desired_version, raw, "RECEIVED", t, t, __version__))

    def set_status(self, attempt_id: str, status: str, steps: Optional[list] = None):
        if steps is None:
            self._x("update attempts set status = ?, updated_at = ? where attempt_id = ?", (status, now_iso(), attempt_id))
        else:
            self._x("update attempts set status = ?, steps = ?, updated_at = ? where attempt_id = ?", (status, json.dumps(steps), now_iso(), attempt_id))

    def finish(self, attempt_id: str, outcome: Optional[dict[str, Any]], steps: Optional[list] = None):
        self._x("update attempts set status = 'DONE', outcome = ?, steps = coalesce(?, steps), reported = ?, updated_at = ? where attempt_id = ?",
                (json.dumps(outcome) if outcome else None, json.dumps(steps) if steps is not None else None, 0 if outcome else 1, now_iso(), attempt_id))

    def mark_reported(self, attempt_id: str):
        self._x("update attempts set reported = 1, updated_at = ? where attempt_id = ?", (now_iso(), attempt_id))

    def finished_outcome(self, operation_id: str) -> Optional[dict]:
        """Resultado final já registrado para a operação (reentrega legítima reutiliza a evidência)."""
        r = self._x("select outcome from attempts where operation_id = ? and status = 'DONE' and outcome is not null"
                    " and json_extract(outcome, '$.outcome') = 'SUCCEEDED' order by updated_at desc limit 1", (operation_id,)).fetchone()
        return json.loads(r["outcome"]) if r else None

    def may_have_effect(self, operation_id: str) -> bool:
        """Alguma tentativa anterior desta operação chegou a iniciar escrita?"""
        return self._x("select 1 from attempts where operation_id = ? and (status in ('EXECUTING','VERIFYING') or outcome is not null)", (operation_id,)).fetchone() is not None

    def unresolved_effect(self, operation_id: str) -> bool:
        return self._x("select 1 from attempts where operation_id = ? and status in ('EXECUTING','VERIFYING')", (operation_id,)).fetchone() is not None

    def unresolved_resource(self, resource_id: str, operation_id: str) -> bool:
        return self._x("select 1 from attempts where resource_id = ? and operation_id <> ? and status in ('EXECUTING','VERIFYING')", (resource_id, operation_id)).fetchone() is not None

    def interrupted(self) -> list[sqlite3.Row]:
        return self._x("select * from attempts where status in ('EXECUTING','VERIFYING') order by created_at").fetchall()

    def abandon_received(self):
        self._x("update attempts set status = 'DONE', reported = 1, updated_at = ? where status = 'RECEIVED'", (now_iso(),))

    def unreported(self) -> list[sqlite3.Row]:
        return self._x("select * from attempts where status = 'DONE' and outcome is not null and reported = 0 order by updated_at").fetchall()

    def prune(self, keep_days: int = 30):
        self._x("delete from attempts where status = 'DONE' and reported = 1 and updated_at < datetime('now', ?)", (f"-{keep_days} days",))
