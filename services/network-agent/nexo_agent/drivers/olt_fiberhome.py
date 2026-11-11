"""Driver FiberHome AN5516 (GPON): backup de config (herdado do genérico) + LEITURA de ONU.
Reconhecido em equipamento real (docs/estudo-campo/recon-cli-olts.md): após `enable` e `cd onu`,
`show authorization slot all pon all` lista as ONUs (PhyId=serial, ST=autorizada, OST=up/dn=online) e
`show onu optical-info slot all pon all onu all` traz rx/tx. Transporte OS (telnet). Provisionamento não homologado.
"""
import re
from typing import Optional

from .olt_base import OnuState
from .olt_cli_backup import PROFILES, CliBackupDriver, CliBackupProfile

FIBERHOME_PROFILE = PROFILES["olt_fiberhome"]


def _num(tok: str) -> Optional[float]:
    m = re.match(r"-?\d+\.\d+$", tok or "")
    return float(tok) if m else None


def parse_auth_table(output: str) -> list[dict]:
    """'show authorization slot all pon all': Slot Pon Onu OnuType ST Lic OST PhyId ...  (ST: A/P/R, OST: up/dn)."""
    rows = []
    for line in output.splitlines():
        m = re.match(r"^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([APR])\s+(\S+)\s+(\w+)\s+([0-9A-Za-z]{6,16})\b", line)
        if m:
            rows.append({"slot": int(m.group(1)), "pon": int(m.group(2)), "onu": int(m.group(3)), "type": m.group(4),
                         "authorized": m.group(5) == "A", "online": m.group(7).lower() == "up", "serial": m.group(8).upper()})
    return rows


def parse_optical_table(output: str) -> dict:
    """'show onu optical-info slot all pon all onu all': (slot,pon,onu) -> (rx_dbm, tx_dbm)."""
    out = {}
    for line in output.splitlines():
        m = re.match(r"^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w+)\s+(-?\d+\.\d+|-)\s+(-?\d+\.\d+|-)", line)
        if m:
            out[(int(m.group(1)), int(m.group(2)), int(m.group(3)))] = (_num(m.group(5)), _num(m.group(6)))
    return out


class FiberHomeOltDriver(CliBackupDriver):
    @classmethod
    def from_device(cls, dev: dict, credentials: dict, profile: CliBackupProfile = FIBERHOME_PROFILE):
        return super().from_device(dev, credentials, profile)

    def _open_onu(self):
        s = self._connect()
        self._enable(s)
        s.run("cd onu", idle=1.5, maxt=10)
        return s

    def discover(self) -> list[dict]:
        s = self._open_onu()
        try:
            raw = s.dump("show authorization discovery slot all pon all", idle=3.0, maxt=120)
        finally:
            s.close()
        return [{"pon_port": f"{r['slot']}/{r['pon']}", "serial": r["serial"]} for r in parse_auth_table(raw)]

    def read_onus(self, serials: list[str]) -> dict[str, OnuState]:
        s = self._open_onu()
        try:
            auth = {r["serial"]: r for r in parse_auth_table(s.dump("show authorization slot all pon all", idle=3.0, maxt=180))}
            optical = parse_optical_table(s.dump("show onu optical-info slot all pon all onu all", idle=3.0, maxt=180))
        finally:
            s.close()
        out = {}
        for sn in serials:
            r = auth.get(sn.upper())
            if not r:
                out[sn] = OnuState(authorized=False)
                continue
            rx, tx = optical.get((r["slot"], r["pon"], r["onu"]), (None, None))
            out[sn] = OnuState(authorized=r["authorized"], online=r["online"], rx_dbm=rx, tx_dbm=tx,
                               pon_port=f"{r['slot']}/{r['pon']}", extra={"onu": r["onu"], "type": r["type"]})
        return out

    def read_onu(self, serial: str) -> OnuState:
        return self.read_onus([serial]).get(serial, OnuState(authorized=False))
