"""DRIVER DE OLT DE DEMONSTRAÇÃO — simula uma OLT GPON em um arquivo SQLite local.
Não fala com nenhum equipamento. Serve ao desenvolvimento; NÃO comprova compatibilidade com fabricante algum."""
import hashlib
import sqlite3
import time
from typing import Optional

from .base import AckLost
from .olt_base import OnuState

SCHEMA = """
create table if not exists pon_onus (device_id text, serial text, pon_port text, vendor text, model text, authorized integer not null default 0,
  line_profile text, service_vlan integer, description text, plugged_at real, primary key (device_id, serial));
create table if not exists olt_writes (id integer primary key autoincrement, device_id text, serial text, command text, at real);
create table if not exists olt_faults (name text primary key, remaining integer);
"""
SEED = [("FHTT1A2B3C4D", "0/1/1", "FHTT", "AN5506-01-A (simulado)"), ("ZTEGC0FFEE01", "0/1/1", "ZTEG", "F601 (simulado)"),
        ("HWTC00AB12CD", "0/1/2", "HWTC", "HG8310M (simulado)"), ("VSOL7F00A1B2", "0/2/4", "VSOL", "V2801 (simulado)")]


class DemoOltDriver:
    simulated = True

    def __init__(self, path: str, device_id: str):
        self.device_id = device_id
        self._db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.executescript(SCHEMA)
        if not self._db.execute("select 1 from pon_onus where device_id = ?", (device_id,)).fetchone():
            for serial, port, vendor, model in SEED:  # ONUs "recém-conectadas" aguardando autorização
                self.plug(serial, port, vendor, model)

    # --- ferramentas do ambiente de demonstração ---
    def plug(self, serial: str, pon_port: str, vendor: str = "DEMO", model: str = "ONU simulada"):
        self._db.execute("insert or ignore into pon_onus (device_id, serial, pon_port, vendor, model, plugged_at) values (?,?,?,?,?,?)",
                         (self.device_id, serial.upper(), pon_port, vendor, model, time.time()))

    def unplug(self, serial: str):
        self._db.execute("update pon_onus set plugged_at = null where device_id = ? and serial = ?", (self.device_id, serial.upper()))

    def manual_remove(self, serial: str):
        """Simula alguém removendo a autorização direto na OLT."""
        self._db.execute("update pon_onus set authorized = 0, line_profile = null, service_vlan = null, description = null where device_id = ? and serial = ?",
                         (self.device_id, serial.upper()))

    def inject(self, name: str, times: int = 1):
        self._db.execute("insert into olt_faults values (?, ?) on conflict(name) do update set remaining = excluded.remaining", (name, times))

    def _fault(self, name: str) -> bool:
        r = self._db.execute("select remaining from olt_faults where name = ?", (name,)).fetchone()
        if r and r["remaining"] > 0:
            self._db.execute("update olt_faults set remaining = remaining - 1 where name = ?", (name,))
            return True
        return False

    def write_count(self, serial: str, command: Optional[str] = None) -> int:
        q, a = "select count(*) c from olt_writes where device_id = ? and serial = ?", [self.device_id, serial.upper()]
        if command:
            q, a = q + " and command = ?", a + [command]
        return self._db.execute(q, a).fetchone()["c"]

    def _row(self, serial: str):
        return self._db.execute("select * from pon_onus where device_id = ? and serial = ?", (self.device_id, serial.upper())).fetchone()

    # --- contrato do driver ---
    def check(self) -> dict:
        return {"ok": True, "detail": "OLT de demonstração (simulada) — nenhum equipamento real consultado"}

    def discover(self) -> list[dict]:
        return [{"serial": r["serial"], "pon_port": r["pon_port"], "vendor": r["vendor"], "model": r["model"]}
                for r in self._db.execute("select * from pon_onus where device_id = ? and authorized = 0 and plugged_at is not null", (self.device_id,))]

    def read_onu(self, serial: str) -> OnuState:
        r = self._row(serial)
        if not r or not r["authorized"]:
            return OnuState(authorized=False, pon_port=r["pon_port"] if r else None, extra={"simulated": True})
        online = r["plugged_at"] is not None
        # sinal fictício, estável por serial
        base = int(hashlib.sha1(r["serial"].encode()).hexdigest(), 16) % 900 / 100.0
        return OnuState(True, r["pon_port"], r["line_profile"], r["service_vlan"], r["description"], online,
                        round(-17.0 - base, 2) if online else None, round(2.0 + base / 10, 2) if online else None, {"simulated": True})

    def authorize(self, serial: str, *, pon_port: str, line_profile: str, service_vlan: int, description: str, service_profile: Optional[str] = None) -> dict:
        if self._fault("fail_before_write"):
            raise ConnectionError("falha simulada antes da escrita")
        r = self._row(serial)
        if r and r["pon_port"] != pon_port and r["plugged_at"] is not None:
            raise ValueError(f"ONU {serial} está na porta {r['pon_port']}, não em {pon_port}")
        self._db.execute(
            "insert into pon_onus (device_id, serial, pon_port, authorized, line_profile, service_vlan, description) values (?,?,?,?,?,?,?)"
            " on conflict(device_id, serial) do update set authorized = 1, line_profile = excluded.line_profile, service_vlan = excluded.service_vlan, description = excluded.description",
            (self.device_id, serial.upper(), pon_port, 1, line_profile, service_vlan, description))
        self._db.execute("insert into olt_writes (device_id, serial, command, at) values (?,?,?,?)", (self.device_id, serial.upper(), "authorize", time.time()))
        if self._fault("lose_ack"):
            raise AckLost("confirmação perdida (simulada) após autorizar a ONU")
        return {"simulated": True, "line_profile": line_profile, "service_vlan": service_vlan}

    def deauthorize(self, serial: str) -> dict:
        n = self._db.execute("update pon_onus set authorized = 0, line_profile = null, service_vlan = null, description = null where device_id = ? and serial = ? and authorized = 1",
                             (self.device_id, serial.upper())).rowcount
        self._db.execute("insert into olt_writes (device_id, serial, command, at) values (?,?,?,?)", (self.device_id, serial.upper(), "deauthorize", time.time()))
        return {"simulated": True, "removed": n}
