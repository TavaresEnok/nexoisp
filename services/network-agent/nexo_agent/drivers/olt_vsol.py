"""Driver VSOL (OLTs da família BDCOM — EPON "epon-olt" e GPON): backup de config VALIDADO AO VIVO + lista de ONUs
autorizadas lida do running-config.

Reconhecido em equipamento real (docs/estudo-campo/recon-cli-olts.md): o backup (`show running-config`) funciona por
telnet. A CLI é estilo switch e NÃO expõe leitura operacional de ONU (estado/sinal) — isso exigiria SNMP. O que a CLI
traz de ONU é a lista de autorização no próprio running-config, associada à seção 'interface epon/gpon f/p':
  - EPON:  `confirm onu mac <MAC> onuid <N>`              (ONU identificada por MAC)
  - GPON:  `onu add <N> profile <perfil> sn <SERIAL>`     (ONU identificada por SN) — validado ao vivo (TC+/Maxprint)
Este driver parseia as duas formas para reportar as ONUs autorizadas. online/sinal ficam indisponíveis via CLI.
Provisionamento não homologado.
"""
import re

from .olt_base import OnuState
from .olt_cli_backup import CliBackupDriver, CliBackupProfile

# 'show running-config' é o comando validado ao vivo; mantém alternativas como fallback.
VSOL_PROFILE = CliBackupProfile(
    "OLT VSOL",
    "telnet",
    backup_commands=("show running-config", "show running-config-devel", "show config", "show configuration"),
)

_MAC = r"([0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}|[0-9A-Fa-f]{4}(?:\.[0-9A-Fa-f]{4}){2})"
_CONFIRM = re.compile(rf"^\s*confirm\s+onu\s+mac\s+{_MAC}\s+onuid\s+(\d+)", re.I)
_GPON_ADD = re.compile(r"^\s*onu\s+add\s+(\d+)\s+profile\s+\S+\s+sn\s+(\S+)", re.I)
_IFACE = re.compile(r"^\s*interface\s+((?:epon|gpon)\s*\d+/\d+)", re.I)
_OTHER_IFACE = re.compile(r"^\s*interface\s+", re.I)


def norm_mac(mac: str) -> str:
    hexs = re.sub(r"[^0-9A-Fa-f]", "", mac).upper()
    return ":".join(hexs[i:i + 2] for i in range(0, 12, 2)) if len(hexs) == 12 else mac.upper()


def parse_authorized(config: str) -> list[dict]:
    """ONUs autorizadas no running-config, associadas à seção 'interface epon/gpon f/p' corrente:
    EPON `confirm onu mac <MAC> onuid <N>` e GPON `onu add <N> profile <perfil> sn <SERIAL>`. Uma interface
    não-PON (gigabitethernet/vlan...) encerra a seção."""
    rows, cur_port = [], None
    for line in config.splitlines():
        mi = _IFACE.match(line)
        if mi:
            cur_port = re.sub(r"\s+", " ", mi.group(1)).strip()
            continue
        if _OTHER_IFACE.match(line):  # entrou noutra interface (não epon/gpon): fora da seção PON
            cur_port = None
            continue
        m = _CONFIRM.match(line)
        if m:
            rows.append({"serial": norm_mac(m.group(1)), "onuid": int(m.group(2)), "pon_port": cur_port})
            continue
        g = _GPON_ADD.match(line)
        if g and cur_port:  # só conta 'onu add' dentro de uma seção interface gpon/epon
            rows.append({"serial": g.group(2).upper(), "onuid": int(g.group(1)), "pon_port": cur_port})
    return rows


class VsolOltDriver(CliBackupDriver):
    @classmethod
    def from_device(cls, dev: dict, credentials: dict, profile: CliBackupProfile = VSOL_PROFILE):
        return super().from_device(dev, credentials, profile)

    def read_onus(self, serials: list[str]) -> dict[str, OnuState]:
        # A leitura vem do running-config (a CLI EPON não expõe estado/sinal por ONU); online/sinal = None.
        index = {r["serial"]: r for r in parse_authorized(self.export_config())}
        out = {}
        for sn in serials:
            # EPON casa por MAC normalizado; GPON casa pelo SN cru (um SN de 12 hex seria mal normalizado como MAC).
            r = index.get(norm_mac(sn)) or index.get(sn.upper())
            if not r:
                out[sn] = OnuState(authorized=False)
            else:
                out[sn] = OnuState(authorized=True, online=None, pon_port=r["pon_port"], extra={"onuid": r["onuid"]})
        return out

    def read_onu(self, serial: str) -> OnuState:
        return self.read_onus([serial]).get(serial, OnuState(authorized=False))
