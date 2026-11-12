"""Driver FiberHome AN5516 (GPON): backup de config (herdado do genérico) + LEITURA de ONU.
Validado em equipamento real (2026-11-12): após `enable` e `cd onu`, `show authorization slot all pon all`
lista as ONUs (ST=A autorizada, OST=up/dn online, PhyId=serial). A potência óptica é consultada POR ONU com
`show onu opticalpower-info phy-id <serial>` — o comando em massa `show onu optical-info ... all` NÃO existe
neste firmware (devolve "% Unknown command"; `show onu opticalpower-info` sem argumento volta vazio). A saída por
ONU traz "SEND POWER : <tx> (Dbm)" e "RECV POWER : <rx> (Dbm)". Transporte OS (telnet).

Autorização/remoção: whitelist + VLAN na árvore `lan`, PROVADAS NO LABORATÓRIO (emulador por telnet real), NÃO
homologadas em AN5516 real. Travadas por padrão (allow_writes + modelo/firmware do 'show version').
"""
import re
from typing import Optional, Tuple

from .olt_base import OnuState, free_id, safe
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

    # --- escrita (autorizar/desautorizar) --------------------------------------------------------------------------
    # Whitelist (`set whitelist phy_addr ... action add|delete`) + serviço/VLAN na árvore `lan` (`set epon ... service`,
    # `apply onu ... vlan`). PROVADO NO LABORATÓRIO (emulador por telnet real); NÃO homologado em AN5516 real.
    # A whitelist não tem descrição: no FiberHome NÃO há marcador de versão gravado no equipamento.
    def _open_for_write(self):
        s = self._connect()
        try:
            self._enable(s)
            self._require_write_capability(s)
            s.run("cd onu", idle=1.5, maxt=10)
        except Exception:
            s.close()
            raise
        return s

    def authorize(self, serial: str, *, pon_port: str, line_profile: str, service_vlan: int, description: str,
                  service_profile: Optional[str] = None) -> dict:
        """pon_port = 'slot/pon'; service_profile = TIPO da ONU (ex.: 5506-01-A1). line_profile e description não têm
        campo na whitelist FiberHome (validados, não gravados)."""
        self._writes_enabled()
        m = re.fullmatch(r"\s*(\d+)/(\d+)\s*", pon_port or "")
        if not m:
            raise ValueError(f"porta PON FiberHome inválida (use slot/pon): {pon_port!r}")
        slot, pon = int(m.group(1)), int(m.group(2))
        if not service_profile:
            raise ValueError("FiberHome exige o tipo da ONU (service_profile)")
        sn, typ = safe(serial, "serial").upper(), safe(service_profile, "tipo de ONU")
        safe(line_profile, "perfil"), safe(description, "descrição")
        vlan = int(service_vlan)
        if not 1 <= vlan <= 4094:
            raise ValueError("VLAN fora da faixa 1-4094")
        s = self._open_for_write()
        try:
            rows = parse_auth_table(s.dump("show authorization slot all pon all", idle=3.0, maxt=180))
            oid = free_id([r["onu"] for r in rows if (r["slot"], r["pon"]) == (slot, pon)], 1, 128)
            self._cfg(s, f"set whitelist phy_addr address {sn} password null action add slot {slot} pon {pon} onu {oid} type {typ}")
            self._cfg(s, "cd lan")
            self._cfg(s, f"set epon slot {slot} pon {pon} onu {oid} port 1 service number 1")
            self._cfg(s, f"set epon slot {slot} pon {pon} onu {oid} port 1 service 1 vlan_mode tag 0 33024 {vlan}")
            self._cfg(s, f"apply onu {slot} {pon} {oid} vlan")
            self._cfg(s, "cd ..")
        finally:
            s.close()
        return {"onu_id": oid, "pon_port": f"{slot}/{pon}", "service_vlan": vlan}

    def deauthorize(self, serial: str) -> dict:
        self._writes_enabled()
        sn = safe(serial, "serial").upper()
        s = self._open_for_write()
        try:
            rows = parse_auth_table(s.dump("show authorization slot all pon all", idle=3.0, maxt=180))
            r = next((x for x in rows if x["serial"] == sn), None)
            if not r:
                return {"removed": 0}  # idempotente
            self._cfg(s, f"set whitelist phy_addr address {sn} password null action delete slot {r['slot']} pon {r['pon']} "
                         f"onu {r['onu']} type {safe(r['type'], 'tipo de ONU')}")
        finally:
            s.close()
        return {"removed": 1, "onu_id": r["onu"], "pon_port": f"{r['slot']}/{r['pon']}"}
