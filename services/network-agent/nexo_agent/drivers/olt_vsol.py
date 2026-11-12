"""Driver VSOL (OLTs da família BDCOM — EPON "epon-olt" e GPON): backup de config VALIDADO AO VIVO + lista de ONUs
autorizadas lida do running-config.

Reconhecido em equipamento real (docs/estudo-campo/recon-cli-olts.md): o backup (`show running-config`) funciona por
telnet. A CLI é estilo switch e NÃO expõe leitura operacional de ONU (estado/sinal) — isso exigiria SNMP. O que a CLI
traz de ONU é a lista de autorização no próprio running-config, associada à seção 'interface epon/gpon f/p':
  - EPON:  `confirm onu mac <MAC> onuid <N>`              (ONU identificada por MAC)
  - GPON:  `onu add <N> profile <perfil> sn <SERIAL>`     (ONU identificada por SN) — validado ao vivo (TC+/Maxprint)
Este driver parseia as duas formas para reportar as ONUs autorizadas. online/sinal ficam indisponíveis via CLI.

Autorização/remoção (só GPON): os comandos são as próprias linhas de configuração vistas no running-config real
(`onu add`, `onu N tcont/gemport/service/service-port/portvlan`), mais `onu N desc` (marcador de versão) e
`onu delete N`. PROVADO NO LABORATÓRIO (emulador por telnet real), NÃO homologado em VSOL real — `onu N desc` e
`onu delete N` não foram vistos em campo. Travado por padrão (allow_writes + modelo/firmware do 'show version').
EPON: escrita recusada (modelo de serviço diferente, sem base de campo).
"""
import re

from .olt_base import OnuState, free_id, safe
from .olt_cli_backup import CliBackupDriver, CliBackupError, CliBackupProfile

# 'show running-config' é o comando validado ao vivo; mantém alternativas como fallback.
VSOL_PROFILE = CliBackupProfile(
    "OLT VSOL",
    "telnet",
    backup_commands=("show running-config", "show running-config-devel", "show config", "show configuration"),
)

_MAC = r"([0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}|[0-9A-Fa-f]{4}(?:\.[0-9A-Fa-f]{4}){2})"
_CONFIRM = re.compile(rf"^\s*confirm\s+onu\s+mac\s+{_MAC}\s+onuid\s+(\d+)", re.I)
_GPON_ADD = re.compile(r"^\s*onu\s+add\s+(\d+)\s+profile\s+\S+\s+sn\s+(\S+)", re.I)
_DESC = re.compile(r"^\s*onu\s+(\d+)\s+desc(?:ription)?\s+(\S+)", re.I)
_IFACE = re.compile(r"^\s*interface\s+((?:epon|gpon)\s*\d+/\d+)", re.I)
_OTHER_IFACE = re.compile(r"^\s*interface\s+", re.I)


def norm_mac(mac: str) -> str:
    hexs = re.sub(r"[^0-9A-Fa-f]", "", mac).upper()
    return ":".join(hexs[i:i + 2] for i in range(0, 12, 2)) if len(hexs) == 12 else mac.upper()


def parse_authorized(config: str) -> list[dict]:
    """ONUs autorizadas no running-config, associadas à seção 'interface epon/gpon f/p' corrente:
    EPON `confirm onu mac <MAC> onuid <N>` e GPON `onu add <N> profile <perfil> sn <SERIAL>` (+ `onu N desc`).
    Uma interface não-PON (gigabitethernet/vlan...) encerra a seção."""
    rows, cur_port, descs = [], None, {}
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
            continue
        d = _DESC.match(line)
        if d and cur_port:
            descs[(cur_port, int(d.group(1)))] = d.group(2)
    for r in rows:
        r["description"] = descs.get((r["pon_port"], r["onuid"]))
    return rows


class VsolOltDriver(CliBackupDriver):
    @classmethod
    def from_device(cls, dev: dict, credentials: dict, profile: CliBackupProfile = VSOL_PROFILE):
        return super().from_device(dev, credentials, profile)

    def _index(self) -> dict:
        return {r["serial"]: r for r in parse_authorized(self.export_config())}

    @staticmethod
    def _find(index: dict, sn: str):
        # EPON casa por MAC normalizado; GPON casa pelo SN cru (um SN de 12 hex seria mal normalizado como MAC).
        return index.get(norm_mac(sn)) or index.get(sn.upper())

    def read_onus(self, serials: list[str]) -> dict[str, OnuState]:
        # A leitura vem do running-config (a CLI não expõe estado/sinal por ONU); online/sinal = None.
        index = self._index()
        out = {}
        for sn in serials:
            r = self._find(index, sn)
            if not r:
                out[sn] = OnuState(authorized=False)
            else:
                out[sn] = OnuState(authorized=True, online=None, pon_port=r["pon_port"], description=r.get("description"),
                                   extra={"onuid": r["onuid"]})
        return out

    def read_onu(self, serial: str) -> OnuState:
        return self.read_onus([serial]).get(serial, OnuState(authorized=False))

    # --- escrita (só GPON) ------------------------------------------------------------------------------------------
    def authorize(self, serial: str, *, pon_port: str, line_profile: str, service_vlan: int, description: str,
                  service_profile=None) -> dict:
        """line_profile = profile do 'onu add'; service_profile = perfil de DBA do T-CONT."""
        self._writes_enabled()
        m = re.fullmatch(r"\s*(?:(gpon|epon)\s*)?(\d+/\d+)\s*", pon_port or "", re.I)
        if not m:
            raise ValueError(f"porta PON VSOL inválida: {pon_port!r}")
        if (m.group(1) or "gpon").lower() == "epon":
            raise CliBackupError("escrita em VSOL EPON não implementada (modelo de serviço diferente, sem base de campo)")
        port = f"gpon {m.group(2)}"
        if not service_profile:
            raise ValueError("VSOL GPON exige o perfil de DBA (service_profile)")
        sn, lp, dba, desc = (safe(serial, "serial").upper(), safe(line_profile, "profile"), safe(service_profile, "DBA"),
                             safe(description, "descrição"))
        vlan = int(service_vlan)
        if not 1 <= vlan <= 4094:
            raise ValueError("VLAN fora da faixa 1-4094")
        used = [r["onuid"] for r in self._index().values() if r["pon_port"] == port]
        oid = free_id(used, 1, 128)
        s = self._connect()
        try:
            self._enable(s)
            self._require_write_capability(s)
            self._cfg(s, "configure terminal")
            self._cfg(s, f"interface {port}")
            for c in (f"onu add {oid} profile {lp} sn {sn}", f"onu {oid} tcont 1 dba {dba}",
                      f"onu {oid} gemport 1 tcont 1 gemport_name gem_1", f"onu {oid} service srv_1 gemport 1 vlan {vlan}",
                      f"onu {oid} service-port 1 gemport 1 uservlan {vlan} vlan {vlan}",
                      f"onu {oid} portvlan eth 1 mode tag vlan {vlan}", f"onu {oid} desc {desc}"):
                self._cfg(s, c)
            self._cfg(s, "exit")
            self._cfg(s, "exit")
        finally:
            s.close()
        return {"onu_id": oid, "pon_port": port, "service_vlan": vlan}

    def deauthorize(self, serial: str) -> dict:
        self._writes_enabled()
        sn = safe(serial, "serial").upper()
        r = self._find(self._index(), sn)
        if not r:
            return {"removed": 0}  # idempotente
        if not (r["pon_port"] or "").startswith("gpon"):
            raise CliBackupError("escrita em VSOL EPON não implementada")
        s = self._connect()
        try:
            self._enable(s)
            self._require_write_capability(s)
            self._cfg(s, "configure terminal")
            self._cfg(s, f"interface {r['pon_port']}")
            self._cfg(s, f"onu delete {r['onuid']}")
            self._cfg(s, "exit")
            self._cfg(s, "exit")
        finally:
            s.close()
        return {"removed": 1, "onu_id": r["onuid"], "pon_port": r["pon_port"]}
