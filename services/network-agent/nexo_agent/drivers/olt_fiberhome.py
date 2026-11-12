"""Driver FiberHome AN5516 (GPON): backup de config (herdado do genérico) + LEITURA de ONU.
Validado em equipamento real (2026-11-12): após `enable` e `cd onu`, `show authorization slot all pon all`
lista as ONUs (ST=A autorizada, OST=up/dn online, PhyId=serial). A potência óptica é consultada POR ONU com
`show onu opticalpower-info phy-id <serial>` — o comando em massa `show onu optical-info ... all` NÃO existe
neste firmware (devolve "% Unknown command"; `show onu opticalpower-info` sem argumento volta vazio). A saída por
ONU traz "SEND POWER : <tx> (Dbm)" e "RECV POWER : <rx> (Dbm)". Transporte OS (telnet). Provisionamento não homologado.
"""
import re
from typing import Optional, Tuple

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


def parse_optical_power(output: str) -> Tuple[Optional[float], Optional[float]]:
    """'show onu opticalpower-info phy-id <serial>': devolve (rx_dbm, tx_dbm) de 'RECV POWER'/'SEND POWER'."""
    rx = tx = None
    for line in output.splitlines():
        m = re.search(r"RECV\s*POWER\s*:\s*(-?\d+(?:\.\d+)?)", line, re.I)
        if m:
            rx = float(m.group(1))
        m = re.search(r"SEND\s*POWER\s*:\s*(-?\d+(?:\.\d+)?)", line, re.I)
        if m:
            tx = float(m.group(1))
    return rx, tx


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
            out = {}
            for sn in serials:
                r = auth.get(sn.upper())
                if not r:
                    out[sn] = OnuState(authorized=False)
                    continue
                rx = tx = None
                if r["online"]:  # a potência só existe para ONU online; consulta por ONU (phy-id)
                    rx, tx = parse_optical_power(s.dump(f"show onu opticalpower-info phy-id {sn.upper()}", idle=2.5, maxt=30))
                out[sn] = OnuState(authorized=r["authorized"], online=r["online"], rx_dbm=rx, tx_dbm=tx,
                                   pon_port=f"{r['slot']}/{r['pon']}", extra={"onu": r["onu"], "type": r["type"]})
        finally:
            s.close()
        return out

    def read_onu(self, serial: str) -> OnuState:
        return self.read_onus([serial]).get(serial, OnuState(authorized=False))
