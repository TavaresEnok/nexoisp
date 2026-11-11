"""Driver Intelbras OLT8820 (GPON): backup de config (herdado do driver genérico por CLI) + LEITURA de ONU.
Reconhecido em equipamento real (docs/estudo-campo/recon-cli-olts.md): `onu inventory` lista id/serial/estado/sinal,
`onu show` traz as ONUs descobertas (autofind). Transporte OS (telnet). Provisionamento de ONU não homologado.
"""
import re

from .olt_base import OnuState
from .olt_cli_backup import CliBackupDriver, CliBackupProfile

INTELBRAS_PROFILE = CliBackupProfile("OLT Intelbras", "telnet")


def parse_inventory(output: str) -> list[dict]:
    """'onu inventory': uma linha por ONU provisionada — 'gpon <link> onu <id> <serial8> <vendor> <modelo> ...'."""
    rows = []
    for line in output.splitlines():
        m = re.match(r"^\s*gpon\s+(\d+)\s+onu\s+(\d+)\s+([0-9A-Fa-f]{8})\s+(\S+)\s+(\S+)", line)
        if m:
            rows.append({"link": int(m.group(1)), "onu_id": int(m.group(2)), "serial": m.group(3).upper(),
                         "vendor": m.group(4), "model": m.group(5)})
    return rows


def parse_status(output: str) -> list[dict]:
    """'onu status' (tabela): ONU Serial OperStatus ConfigStatus OLT-Rx ONU-Rx Distance ...
    rx_dbm = ONU Rx Power (downstream); tx_dbm ~ OLT Rx Power (nível recebido no OLT, upstream)."""
    rows = []
    for line in output.splitlines():
        m = re.match(r"^\s*(\d+)\s+([0-9A-Fa-f]{6,16})\s+(Active|Inactive)\s+(\S+)\s+(-?\d+\.\d+)\s*dBm\s+(-?\d+\.\d+)\s*dBm", line)
        if m:
            rows.append({"onu_id": int(m.group(1)), "serial": m.group(2).upper(), "online": m.group(3) == "Active",
                         "tx_dbm": float(m.group(5)), "rx_dbm": float(m.group(6))})
        else:
            m2 = re.match(r"^\s*(\d+)\s+([0-9A-Fa-f]{6,16})\s+(Active|Inactive)\b", line)
            if m2:
                rows.append({"onu_id": int(m2.group(1)), "serial": m2.group(2).upper(),
                             "online": m2.group(3) == "Active", "tx_dbm": None, "rx_dbm": None})
    return rows


def parse_discovered(output: str) -> list[dict]:
    """'onu show' → tabela 'Discovered serial numbers': sernoID Vendor Serial Model Time."""
    found, in_block = [], False
    for line in output.splitlines():
        if re.search(r"Discovered serial numbers", line, re.I):
            in_block = True
            continue
        if in_block:
            if re.match(r"^\s*(Free slots|=+|sernoID|-+)\s*$", line) or re.match(r"^\s*sernoID", line):
                continue
            m = re.match(r"^\s*(\d+)\s+(\S+)\s+([0-9A-Za-z]{6,16})\s+(\S+)", line)
            if m:
                found.append({"serial": m.group(3).upper(), "vendor": m.group(2), "model": m.group(4)})
            elif re.search(r"Free slots|GPON Link", line):
                in_block = False
    return found


class IntelbrasOltDriver(CliBackupDriver):
    @classmethod
    def from_device(cls, dev: dict, credentials: dict, profile: CliBackupProfile = INTELBRAS_PROFILE):
        return super().from_device(dev, credentials, profile)

    def _open(self):
        s = self._connect()
        self._enable(s)
        return s

    def discover(self) -> list[dict]:
        s = self._open()
        try:
            return parse_discovered(s.run("onu show", idle=3.0, maxt=60))
        finally:
            s.close()

    def read_onus(self, serials: list[str]) -> dict[str, OnuState]:
        s = self._open()
        try:
            st = {r["serial"]: r for r in parse_status(s.dump("onu status", idle=3.0, maxt=180))}
        finally:
            s.close()
        out = {}
        for sn in serials:
            r = st.get(sn.upper())
            if not r:
                out[sn] = OnuState(authorized=False)
            else:
                out[sn] = OnuState(authorized=True, online=r["online"], rx_dbm=r["rx_dbm"], tx_dbm=r["tx_dbm"],
                                   extra={"onu_id": r["onu_id"]})
        return out

    def read_onu(self, serial: str) -> OnuState:
        return self.read_onus([serial]).get(serial, OnuState(authorized=False))
