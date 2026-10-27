"""Driver real: autorização no RADIUS local (FreeRADIUS lendo SQLite) + sessões PPP via API do MikroTik RouterOS v7.

SITUAÇÃO: validado em laboratório virtual em 10/10/2026 (CHR RouterOS 7.24.5 + pppd + FreeRADIUS 3.2.10; docs/lab-pppoe.md).
Falta repetir no equipamento físico/versão do piloto (ADR-012). FreeRADIUS segue como candidato EXPERIMENTAL (ADR-005).

A autenticação é respondida pelo FreeRADIUS com os dados locais: continua funcionando com a nuvem ou o agente parados.
Atributos (manual MikroTik, RADIUS): Mikrotik-Group = nome do perfil PPP do usuário."""
import re
import ipaddress
import os
import sqlite3
import ssl
import time
from typing import Optional

from .base import AccountState, AckLost

SCHEMA = """
create table if not exists nexo_accounts (
  username text primary key, policy text not null, profile text not null, prev_profile text,
  applied_version integer not null, updated_at real not null);
"""
# colunas acrescentadas depois da primeira versão do banco (agente 0.4.0); o ALTER é repetível
EXTRA_COLUMNS = (("by_profile", "integer not null default 0"),)
# Atributos opcionais (agente 0.5.0). Resposta: velocidade com rajada, pool de endereços e intervalo de accounting.
# Conferência: Simultaneous-Use (exige a seção "session" do FreeRADIUS consultando o accounting).
REPLY_ATTRS = {"rate_limit": "Mikrotik-Rate-Limit", "address_pool": "Framed-Pool", "acct_interim": "Acct-Interim-Interval", "delegated_ipv6_prefix": "Delegated-IPv6-Prefix"}
CHECK_ATTRS = {"simultaneous_use": "Simultaneous-Use"}
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
              block_profile: Optional[str] = None, mac: Optional[str] = None, extra: Optional[dict] = None):
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
            # vínculo de MAC: comparação no próprio RADIUS ('=='); outro equipamento com a mesma senha não autentica
            db.execute("delete from radcheck where username = ? and attribute = 'Calling-Station-Id'", (username,))
            if mac:
                db.execute("insert into radcheck (username, attribute, op, value) values (?, 'Calling-Station-Id', '==', ?)", (username, mac))
            if policy == "suspended" and not by_profile:  # modalidade 'reject': nega novas autenticações
                db.execute("insert into radcheck (username, attribute, op, value) values (?, 'Auth-Type', ':=', 'Reject')", (username,))
            db.execute("delete from radreply where username = ? and attribute = 'Mikrotik-Group'", (username,))
            db.execute("insert into radreply (username, attribute, op, value) values (?, 'Mikrotik-Group', ':=', ?)", (username, effective))
            db.execute("delete from radreply where username = ? and attribute = 'Framed-IP-Address'", (username,))
            if framed_ip:  # IP fixo: o NAS usa este endereço em vez do pool dinâmico do perfil
                db.execute("insert into radreply (username, attribute, op, value) values (?, 'Framed-IP-Address', ':=', ?)", (username, framed_ip))
            extra = extra or {}
            for key, attr in REPLY_ATTRS.items():
                db.execute("delete from radreply where username = ? and attribute = ?", (username, attr))
                if extra.get(key) is not None:
                    db.execute("insert into radreply (username, attribute, op, value) values (?, ?, ':=', ?)", (username, attr, str(extra[key])))
            for key, attr in CHECK_ATTRS.items():
                db.execute("delete from radcheck where username = ? and attribute = ?", (username, attr))
                if extra.get(key) is not None:
                    db.execute("insert into radcheck (username, attribute, op, value) values (?, ?, ':=', ?)", (username, attr, str(extra[key])))
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
        bound = chk.get("Calling-Station-Id")
        acc = self._db.execute("select * from nexo_accounts where username = ?", (username,)).fetchone()
        # suspensa = rejeitada OU entregando o perfil de bloqueio que este agente gravou (se alguém trocar o perfil à mão, volta a "ativa")
        by_profile = bool(acc and acc["by_profile"] and rep and rep["value"] == acc["profile"])
        reply = {r["attribute"]: r["value"] for r in self._db.execute("select attribute, value from radreply where username = ?", (username,))}
        attrs = {k: reply[a] for k, a in REPLY_ATTRS.items() if a in reply}
        attrs.update({k: chk[a] for k, a in CHECK_ATTRS.items() if a in chk})
        for k in ("simultaneous_use", "acct_interim"):
            if k in attrs and str(attrs[k]).isdigit():
                attrs[k] = int(attrs[k])
        return {"policy": "suspended" if chk.get("Auth-Type") == "Reject" or by_profile else "active", "profile": rep["value"] if rep else None,
                "framed_ip": ip["value"] if ip else None, "mac": bound, "attrs": attrs,
                "applied_version": acc["applied_version"] if acc else None, "prev_profile": acc["prev_profile"] if acc else None,
                "updated_at": acc["updated_at"] if acc else None}


    def usage(self, usernames: list[str], since_epoch: float) -> dict[str, dict[str, dict]]:
        """Consumo por conta e por mês (UTC) a partir do accounting local: {usuário: {"AAAA-MM": {...}}}.
        acctinputoctets = recebido do assinante (upload); acctoutputoctets = enviado a ele (download)."""
        if not usernames:
            return {}
        out: dict[str, dict[str, dict]] = {}
        marks = ",".join("?" * len(usernames))
        # acctstarttime pode estar como época (padrão do FreeRADIUS 3.2/SQLite) ou como texto
        started = "case when typeof(acctstarttime) in ('integer','real') then acctstarttime else cast(strftime('%s', acctstarttime) as integer) end"
        try:
            rows = self._db.execute(
                f"select username, strftime('%Y-%m', {started}, 'unixepoch') as month, coalesce(sum(acctinputoctets),0) as b_in, coalesce(sum(acctoutputoctets),0) as b_out, "
                f"coalesce(sum(acctsessiontime),0) as secs, count(*) as n from radacct where username in ({marks}) and {started} >= ? group by username, month",
                [*usernames, int(since_epoch)]).fetchall()
        except sqlite3.OperationalError:
            return {}   # banco mínimo sem accounting
        for r in rows:
            if r["month"]:
                out.setdefault(r["username"], {})[r["month"]] = {"bytes_in": int(r["b_in"]), "bytes_out": int(r["b_out"]), "session_seconds": int(r["secs"]), "sessions": int(r["n"])}
        return out

    def sessions(self, usernames: list[str], since_epoch: float, limit: int = 5000) -> list[dict]:
        """Sessões do accounting local desde `since_epoch`, com o motivo de encerramento. Tolera banco com menos colunas."""
        if not usernames:
            return []
        try:
            have = {r["name"] for r in self._db.execute("pragma table_info(radacct)")}
        except sqlite3.OperationalError:
            return []
        if "acctstarttime" not in have or "username" not in have:
            return []
        col = lambda c, alias=None: (f"{c}" if c in have else "null") + (f" as {alias or c}")   # noqa: E731
        started = "case when typeof(acctstarttime) in ('integer','real') then acctstarttime else cast(strftime('%s', acctstarttime) as integer) end"
        stopped = ("case when acctstoptime is null then null when typeof(acctstoptime) in ('integer','real') then acctstoptime "
                   "else cast(strftime('%s', acctstoptime) as integer) end") if "acctstoptime" in have else "null"
        key = "coalesce(nullif(acctuniqueid, ''), cast(radacctid as text))" if {"acctuniqueid", "radacctid"} <= have else \
            ("cast(radacctid as text)" if "radacctid" in have else "cast(rowid as text)")
        marks = ",".join("?" * len(usernames))
        sql = (f"select username, {key} as skey, {started} as t0, {stopped} as t1, {col('framedipaddress', 'ip')}, {col('callingstationid', 'mac')}, "
               f"{col('nasipaddress', 'nas')}, coalesce({'acctinputoctets' if 'acctinputoctets' in have else '0'}, 0) as b_in, "
               f"coalesce({'acctoutputoctets' if 'acctoutputoctets' in have else '0'}, 0) as b_out, "
               f"coalesce({'acctsessiontime' if 'acctsessiontime' in have else '0'}, 0) as secs, {col('acctterminatecause', 'cause')} "
               f"from radacct where username in ({marks}) and {started} >= ? order by {started} desc limit ?")
        out = []
        for r in self._db.execute(sql, [*usernames, int(since_epoch), limit]).fetchall():
            if r["t0"] is None:
                continue
            out.append({"username": r["username"], "session_key": str(r["skey"])[:80], "started_at": int(r["t0"]),
                        "stopped_at": int(r["t1"]) if r["t1"] is not None else None, "ip": r["ip"] or None, "mac": r["mac"] or None,
                        "nas_ip": r["nas"] or None, "bytes_in": int(r["b_in"]), "bytes_out": int(r["b_out"]), "seconds": int(r["secs"]),
                        "terminate_cause": (r["cause"] or None)})
        return out

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
        if self.plaintext or cred.get("insecure_skip_verify"):
            try:
                loopback = ipaddress.ip_address(host).is_loopback
            except ValueError:
                loopback = False
            if os.environ.get("NEXO_AGENT_ALLOW_INSECURE_LAB") != "1" or not loopback:
                raise ValueError("transporte NAS inseguro exige laboratório explícito e IP de loopback")
        self.port = port or (8728 if self.plaintext else 8729)

    def _connect(self):
        from librouteros import connect
        kw = {}
        if not self.plaintext:
            ctx = ssl.create_default_context(cafile=self.cred.get("ca_file"))
            ctx.minimum_version = ssl.TLSVersion.TLSv1_2
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
                try:
                    path.remove(*ids)
                except Exception:
                    raise AckLost("resposta NAS ausente após remoção; consultar sessões sem presumir falha") from None
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

    def usage(self, usernames: list[str], since_epoch: float) -> dict:
        return self.radius.usage(usernames, since_epoch)

    def sessions(self, usernames: list[str], since_epoch: float, limit: int = 5000) -> list:
        return self.radius.sessions(usernames, since_epoch, limit)

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
        return AccountState(True, a["policy"], a["profile"], a["applied_version"], session, framed_ip=a["framed_ip"], mac=a["mac"], attrs=a["attrs"])

    def apply_authorization(self, username: str, *, secret: Optional[str], profile: str, policy: str, version: int, framed_ip: Optional[str] = None,
                            block_profile: Optional[str] = None, mac: Optional[str] = None, extra: Optional[dict] = None) -> dict:
        self.radius.apply(username, secret, profile, policy, version, framed_ip, block_profile, mac, extra)
        return {"radius": "radcheck/radreply atualizados", "policy": policy, "profile": block_profile or profile,
                **({"suspension": "perfil de bloqueio"} if block_profile and policy == "suspended" else {}),
                **({"framed_ip": framed_ip} if framed_ip else {}), **({"mac": mac} if mac else {}), **({"attrs": extra} if extra else {})}

    def disconnect(self, username: str) -> dict:
        return {"sessions_removed": self.sessions.remove(username)}
