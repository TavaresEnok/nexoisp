"""Driver real: autorização no RADIUS local (FreeRADIUS lendo SQLite) + sessões PPP via API do MikroTik RouterOS v7.

SITUAÇÃO: validado em laboratório virtual em 10/10/2026 (CHR RouterOS 7.24.5 + pppd + FreeRADIUS 3.2.10; docs/lab-pppoe.md).
Falta repetir no equipamento físico/versão do piloto (ADR-012). FreeRADIUS segue como candidato EXPERIMENTAL (ADR-005).

A autenticação é respondida pelo FreeRADIUS com os dados locais: continua funcionando com a nuvem ou o agente parados.
Atributos (manual MikroTik, RADIUS): Mikrotik-Group = nome do perfil PPP do usuário."""
import re
import sqlite3
import ssl
import time
from typing import Optional

from .base import AccountState

SCHEMA = """
create table if not exists nexo_accounts (
  username text primary key, policy text not null, profile text not null, prev_profile text,
  applied_version integer not null, updated_at real not null);
"""
# colunas acrescentadas depois da primeira versão do banco (agente 0.4.0); o ALTER é repetível
EXTRA_COLUMNS = (("by_profile", "integer not null default 0"),)
_UPTIME = re.compile(r"(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$")


def uptime_seconds(s: str) -> Optional[int]:
    m = _UPTIME.match(s or "")
    if not m or not any(m.groups()):
        return None
    w, d, h, mi, se = (int(x or 0) for x in m.groups())
    return ((w * 7 + d) * 24 + h) * 3600 + mi * 60 + se


class RadiusStore:
    """Tabelas padrão do FreeRADIUS (radcheck/radreply) + marcador de versão, tudo na mesma transação local."""

    PASSWORD_ATTRS = ("Cleartext-Password", "NT-Password")

    def __init__(self, path: str, password_storage: str = "cleartext"):
        # "cleartext": exigido por CHAP. "nt_hash": só o hash NT (MD4) fica em disco; exige NAS em MS-CHAPv2 (sem CHAP/PAP).
        if password_storage not in ("cleartext", "nt_hash"):
            raise ValueError("password_storage deve ser 'cleartext' ou 'nt_hash'")
        self.password_storage = password_storage
        self._db = sqlite3.connect(path, isolation_level=None, timeout=10, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("pragma busy_timeout=10000")
        if not self._db.execute("select 1 from sqlite_master where name = 'radcheck'").fetchone():
            raise RuntimeError(f"banco do RADIUS local não inicializado em {path} (suba o serviço radius primeiro)")
        self._db.executescript(SCHEMA)
        have = {r["name"] for r in self._db.execute("pragma table_info(nexo_accounts)")}
        for col, ddl in EXTRA_COLUMNS:
            if col not in have:
                self._db.execute(f"alter table nexo_accounts add column {col} {ddl}")

    def apply(self, username: str, secret: Optional[str], profile: str, policy: str, version: int, framed_ip: Optional[str] = None,
              block_profile: Optional[str] = None):
        """block_profile: suspensão por perfil. A conta continua autenticando e recebe o perfil de bloqueio (sem Auth-Type Reject).
        `profile` é sempre o perfil do plano; o que o RADIUS entrega é o de bloqueio enquanto durar a suspensão."""
        by_profile = policy == "suspended" and block_profile is not None
        effective = block_profile if by_profile else profile
        db = self._db
        db.execute("begin immediate")
        try:
            cur = db.execute("select profile from nexo_accounts where username = ?", (username,)).fetchone()
            if secret is not None:
                db.execute("delete from radcheck where username = ? and attribute in ('Cleartext-Password','NT-Password')", (username,))
                if self.password_storage == "nt_hash":
                    from passlib.hash import nthash
                    db.execute("insert into radcheck (username, attribute, op, value) values (?, 'NT-Password', ':=', ?)", (username, nthash.hash(secret).upper()))
                else:
                    db.execute("insert into radcheck (username, attribute, op, value) values (?, 'Cleartext-Password', ':=', ?)", (username, secret))
            elif not db.execute("select 1 from radcheck where username = ? and attribute in ('Cleartext-Password','NT-Password')", (username,)).fetchone():
                raise ValueError("conta sem credencial local e segredo não fornecido")
            db.execute("delete from radcheck where username = ? and attribute = 'Auth-Type'", (username,))
            if policy == "suspended" and not by_profile:  # modalidade 'reject': nega novas autenticações
                db.execute("insert into radcheck (username, attribute, op, value) values (?, 'Auth-Type', ':=', 'Reject')", (username,))
            db.execute("delete from radreply where username = ? and attribute = 'Mikrotik-Group'", (username,))
            db.execute("insert into radreply (username, attribute, op, value) values (?, 'Mikrotik-Group', ':=', ?)", (username, effective))
            db.execute("delete from radreply where username = ? and attribute = 'Framed-IP-Address'", (username,))
            if framed_ip:  # IP fixo: o NAS usa este endereço em vez do pool dinâmico do perfil
                db.execute("insert into radreply (username, attribute, op, value) values (?, 'Framed-IP-Address', ':=', ?)", (username, framed_ip))
            prev = cur["profile"] if cur and cur["profile"] != effective else None
            db.execute("insert or replace into nexo_accounts (username, policy, profile, prev_profile, applied_version, updated_at, by_profile) values (?,?,?,?,?,?,?)",
                       (username, policy, effective, prev, version, time.time(), 1 if by_profile else 0))
            db.execute("commit")
        except Exception:
            db.execute("rollback")
            raise

    def read(self, username: str) -> Optional[dict]:
        """Lê o que o RADIUS de fato vai responder (radcheck/radreply), não apenas o marcador."""
        chk = {r["attribute"]: r["value"] for r in self._db.execute("select attribute, value from radcheck where username = ?", (username,))}
        if not any(a in chk for a in self.PASSWORD_ATTRS):
            return None
        rep = self._db.execute("select value from radreply where username = ? and attribute = 'Mikrotik-Group'", (username,)).fetchone()
        ip = self._db.execute("select value from radreply where username = ? and attribute = 'Framed-IP-Address'", (username,)).fetchone()
        acc = self._db.execute("select * from nexo_accounts where username = ?", (username,)).fetchone()
        # suspensa = rejeitada OU entregando o perfil de bloqueio que este agente gravou (se alguém trocar o perfil à mão, volta a "ativa")
        by_profile = bool(acc and acc["by_profile"] and rep and rep["value"] == acc["profile"])
        return {"policy": "suspended" if chk.get("Auth-Type") == "Reject" or by_profile else "active", "profile": rep["value"] if rep else None,
                "framed_ip": ip["value"] if ip else None,
                "applied_version": acc["applied_version"] if acc else None, "prev_profile": acc["prev_profile"] if acc else None,
                "updated_at": acc["updated_at"] if acc else None}


    def cleanup(self, keep_days: int = 90) -> int:
        """Limpa accounting encerrado e registros de autenticação antigos (crescem sem limite no FreeRADIUS)."""
        n = 0
        for sql in ("delete from radacct where acctstoptime is not null and acctstoptime < datetime('now', ?)",
                    "delete from radpostauth where authdate < datetime('now', ?)"):
            try:
                n += self._db.execute(sql, (f"-{keep_days} days",)).rowcount
            except sqlite3.OperationalError:
                pass  # tabela ausente (banco mínimo de teste)
        return n


class MikrotikSessions:
    """Sessões PPP ativas via API do RouterOS (api-ssl por padrão). Só duas chamadas: listar e remover."""

    def __init__(self, host: str, port: Optional[int], cred: dict):
        self.host, self.cred = host, cred
        self.plaintext = bool(cred.get("insecure_plaintext"))  # somente laboratório
        self.port = port or (8728 if self.plaintext else 8729)

    def _connect(self):
        from librouteros import connect
        kw = {}
        if not self.plaintext:
            ctx = ssl.create_default_context(cafile=self.cred.get("ca_file"))
            if self.cred.get("insecure_skip_verify"):  # somente laboratório; nunca padrão
                ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE
            kw["ssl_wrapper"] = lambda sock: ctx.wrap_socket(sock, server_hostname=self.host)
        return connect(host=self.host, port=self.port, username=self.cred["username"], password=self.cred["password"], timeout=10, **kw)

    def check(self) -> dict:
        api = self._connect()
        try:
            r = next(iter(api.path("system", "resource")), {})
            return {"ok": True, "detail": f"RouterOS {r.get('version', '?')} ({r.get('board-name', '?')})"}
        finally:
            api.close()

    def find(self, username: str) -> list[dict]:
        from librouteros.query import Key
        api = self._connect()
        try:
            return [dict(r) for r in api.path("ppp", "active").select(Key(".id"), Key("name"), Key("address"), Key("uptime"), Key("caller-id"), Key("service")).where(Key("name") == username)]
        finally:
            api.close()

    def all_active(self) -> dict[str, dict]:
        """Todas as sessões PPP ativas em UMA chamada (observação periódica)."""
        api = self._connect()
        try:
            return {r.get("name"): dict(r) for r in api.path("ppp", "active")}
        finally:
            api.close()

    def remove(self, username: str) -> int:
        from librouteros.query import Key
        api = self._connect()
        try:
            path = api.path("ppp", "active")
            ids = [r[".id"] for r in path.select(Key(".id"), Key("name")).where(Key("name") == username)]
            if ids:
                path.remove(*ids)
            return len(ids)
        finally:
            api.close()


class MikrotikRadiusDriver:
    simulated = False

    def __init__(self, radius: RadiusStore, sessions):
        self.radius, self.sessions = radius, sessions

    @classmethod
    def from_device(cls, dev: dict, credentials: dict, data_dir: str):
        import os
        cred = credentials.get(dev.get("credential_ref") or "")
        if not cred:
            raise RuntimeError(f"credencial '{dev.get('credential_ref')}' não encontrada no arquivo local do agente")
        if not dev.get("host"):
            raise RuntimeError("equipamento sem endereço configurado")
        radius_db = os.environ.get("NEXO_RADIUS_DB", os.path.join(data_dir, "radius", "radius.sqlite"))
        return cls(RadiusStore(radius_db, cred.get("password_storage", "cleartext")), MikrotikSessions(dev["host"], dev.get("api_port"), cred))

    def maintenance(self) -> dict:
        import os
        return {"radius_rows_removed": self.radius.cleanup(int(os.environ.get("NEXO_RADIUS_KEEP_DAYS", "90")))}

    def check(self) -> dict:
        return self.sessions.check()

    def read_many(self, usernames: list[str]) -> dict[str, AccountState]:
        """Leitura em lote: uma única consulta de sessões ao NAS para todas as contas."""
        try:
            active = self.sessions.all_active()
        except Exception as e:
            active = e
        return {u: self.read(u, _active=active) for u in usernames}

    def read(self, username: str, _active=None) -> AccountState:
        a = self.radius.read(username)
        if a is None:
            return AccountState(exists=False)
        try:
            if isinstance(_active, Exception):
                raise _active
            rows = self.sessions.find(username) if _active is None else ([_active[username]] if username in _active else [])
            session = None
            if rows:
                up = uptime_seconds(rows[0].get("uptime", ""))
                started = time.time() - up if up is not None else None
                # sessão iniciada antes da última mudança de autorização ainda usa o que foi negociado na época
                stale = started is not None and a["updated_at"] is not None and started < a["updated_at"]
                session = {"online": True, "ip": rows[0].get("address"), "caller_id": rows[0].get("caller-id"), "uptime": rows[0].get("uptime"),
                           "profile": (a["prev_profile"] or a["profile"]) if stale else a["profile"], "predates_authorization": stale}
        except Exception as e:  # sem acesso ao NAS: autorização local conhecida, sessão desconhecida
            session = {"online": None, "unknown": True, "error": str(e)[:200]}
        return AccountState(True, a["policy"], a["profile"], a["applied_version"], session, framed_ip=a["framed_ip"])

    def apply_authorization(self, username: str, *, secret: Optional[str], profile: str, policy: str, version: int, framed_ip: Optional[str] = None,
                            block_profile: Optional[str] = None) -> dict:
        self.radius.apply(username, secret, profile, policy, version, framed_ip, block_profile)
        return {"radius": "radcheck/radreply atualizados", "policy": policy, "profile": block_profile or profile,
                **({"suspension": "perfil de bloqueio"} if block_profile and policy == "suspended" else {}),
                **({"framed_ip": framed_ip} if framed_ip else {})}

    def disconnect(self, username: str) -> dict:
        return {"sessions_removed": self.sessions.remove(username)}
