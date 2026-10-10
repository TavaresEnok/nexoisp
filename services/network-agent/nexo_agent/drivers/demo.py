"""DRIVER DE DEMONSTRAÇÃO — simula RADIUS + NAS em um arquivo SQLite local.
Não fala com nenhum equipamento. Serve ao desenvolvimento; NÃO comprova compatibilidade (ADR-012)."""
import hashlib
import sqlite3
import time
from typing import Optional

from .base import AccountState, AckLost

SCHEMA = """
create table if not exists accounts (device_id text, username text, secret_fp text, profile text, policy text,
  applied_version integer, updated_at real, primary key (device_id, username));
create table if not exists sessions (device_id text, username text, ip text, profile text, since real, primary key (device_id, username));
create table if not exists writes (id integer primary key autoincrement, device_id text, username text, command text, at real);
create table if not exists faults (name text primary key, remaining integer);
create table if not exists account_ips (device_id text, username text, framed_ip text, primary key (device_id, username));
"""


class DemoDriver:
    simulated = True

    def __init__(self, path: str, device_id: str, reconnect_after_s: float = 3.0):
        self.device_id = device_id
        self.reconnect_after_s = reconnect_after_s
        self._db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.executescript(SCHEMA)

    # --- injeção de falhas para os cenários de recuperação ---
    def inject(self, name: str, times: int = 1):
        self._db.execute("insert into faults values (?, ?) on conflict(name) do update set remaining = excluded.remaining", (name, times))

    def _fault(self, name: str) -> bool:
        r = self._db.execute("select remaining from faults where name = ?", (name,)).fetchone()
        if r and r["remaining"] > 0:
            self._db.execute("update faults set remaining = remaining - 1 where name = ?", (name,))
            return True
        return False

    def write_count(self, username: str, command: Optional[str] = None) -> int:
        q, a = "select count(*) c from writes where device_id = ? and username = ?", [self.device_id, username]
        if command:
            q, a = q + " and command = ?", a + [command]
        return self._db.execute(q, a).fetchone()["c"]

    # --- contrato do driver ---
    def check(self) -> dict:
        return {"ok": True, "detail": "driver de demonstração (simulado) — nenhum equipamento real consultado"}

    def read(self, username: str) -> AccountState:
        a = self._db.execute("select * from accounts where device_id = ? and username = ?", (self.device_id, username)).fetchone()
        if not a:
            return AccountState(exists=False)
        s = self._db.execute("select * from sessions where device_id = ? and username = ?", (self.device_id, username)).fetchone()
        fixed = self._db.execute("select framed_ip from account_ips where device_id = ? and username = ?", (self.device_id, username)).fetchone()
        fixed = fixed["framed_ip"] if fixed else None
        # CPE simulado: reconecta sozinho alguns segundos depois de autorizado
        if not s and a["policy"] == "active" and time.time() - a["updated_at"] >= self.reconnect_after_s:
            ip = fixed or "100.64.%d.%d" % (int(hashlib.sha1(username.encode()).hexdigest(), 16) % 250, 1 + a["applied_version"] % 250)
            self._db.execute("insert or replace into sessions values (?,?,?,?,?)", (self.device_id, username, ip, a["profile"], time.time()))
            s = self._db.execute("select * from sessions where device_id = ? and username = ?", (self.device_id, username)).fetchone()
        session = {"online": True, "ip": s["ip"], "profile": s["profile"], "since": s["since"], "simulated": True} if s else None
        return AccountState(True, a["policy"], a["profile"], a["applied_version"], session, {"simulated": True}, framed_ip=fixed)

    def apply_authorization(self, username: str, *, secret: Optional[str], profile: str, policy: str, version: int, framed_ip: Optional[str] = None) -> dict:
        if self._fault("fail_before_write"):
            raise ConnectionError("falha simulada antes da escrita")
        cur = self._db.execute("select secret_fp from accounts where device_id = ? and username = ?", (self.device_id, username)).fetchone()
        if secret is None and cur is None:
            raise ValueError("conta inexistente e segredo não fornecido")
        fp = hashlib.sha256(secret.encode()).hexdigest()[:12] if secret is not None else cur["secret_fp"]
        self._db.execute("insert or replace into accounts values (?,?,?,?,?,?,?)", (self.device_id, username, fp, profile, policy, version, time.time()))
        self._db.execute("delete from account_ips where device_id = ? and username = ?", (self.device_id, username))
        if framed_ip:
            self._db.execute("insert into account_ips values (?,?,?)", (self.device_id, username, framed_ip))
        self._db.execute("insert into writes (device_id, username, command, at) values (?,?,?,?)", (self.device_id, username, "authorization", time.time()))
        if self._fault("lose_ack"):
            raise AckLost("confirmação perdida (simulada) após aplicar a autorização")
        return {"simulated": True, "policy": policy, "profile": profile}

    def disconnect(self, username: str) -> dict:
        n = self._db.execute("delete from sessions where device_id = ? and username = ?", (self.device_id, username)).rowcount
        self._db.execute("insert into writes (device_id, username, command, at) values (?,?,?,?)", (self.device_id, username, "disconnect", time.time()))
        return {"simulated": True, "sessions_removed": n}

    # --- usado só pela ferramenta de demonstração: simula alteração manual externa ---
    def manual_change(self, username: str, policy: str):
        self._db.execute("update accounts set policy = ?, updated_at = ? where device_id = ? and username = ?", (policy, time.time(), self.device_id, username))
