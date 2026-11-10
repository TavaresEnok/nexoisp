"""Driver genérico de BACKUP DE CONFIGURAÇÃO por CLI, para OLTs que despejam a config na tela mas o paramiko/netmiko
não atende (Intelbras, FiberHome, VSOL, Parks). Usa o transporte OS (nexo_agent/os_cli): ssh real via pty ou telnet
puro. Entra em modo privilegiado (`enable`), desliga paginação e tenta uma lista de comandos de dump até sair config
reconhecível. Mesma lógica do backup center (OltCliProfile/run_olt_cli_backup).

SÓ LEITURA: faz identidade e backup; provisionamento de ONU não é implementado (recusado). A enumeração/gerência de ONU
de cada marca fica para um driver dedicado depois (como o ZTE).
"""
import re
from dataclasses import dataclass, field

from .base import AckLost  # noqa: F401

ERROR_MARKERS = ("unknown command", "invalid command", "invalid input", "incomplete command", "parameter error",
                 "unrecognized command", "command not found", "no such command", "bad command", "% error", "syntax error")
CONFIG_MARKERS = ("hostname ", "sysname ", "interface ", "vlan ", "ip address", "ip route", "gpon", "epon", "xpon",
                  "pon ", "onu ", "ont ", "service-port", "service port", "traffic-profile", "snmp", "aaa ", "dba-profile")
PAGING_COMMANDS = ("terminal length 0", "terminal datadump", "no page", "no paging", "screen-length 0",
                   "screen-length disable", "screen-length 0 temporary")
DEFAULT_BACKUP_COMMANDS = ("show running-config-devel", "show running-config", "show configuration", "show running",
                           "show startup-config", "display current-configuration")
# Linhas voláteis (data/relógio do dump) que mudam sem a config mudar — tiradas para a detecção de "mudou".
_VOLATILE = re.compile(r"(?mi)^\s*(timestamp_write|Building configuration|! Last (commit|configuration)|Current configuration|Time[:=]).*\n?")


@dataclass
class CliBackupProfile:
    name: str
    transport_default: str = "telnet"
    needs_enable: bool = True
    backup_commands: tuple = DEFAULT_BACKUP_COMMANDS
    markers: tuple = CONFIG_MARKERS


class CliBackupError(Exception):
    pass


def looks_error(text: str) -> bool:
    low = text.lower()
    return any(m in low for m in ERROR_MARKERS)


def looks_config(text: str, markers=CONFIG_MARKERS) -> bool:
    low = (text or "").lower()
    if len(low.strip()) < 80 or looks_error(low):
        return False
    hits = sum(1 for m in markers if m in low)
    lines = [l for l in text.splitlines() if l.strip()]
    if hits >= 2 and len(text) >= 200:
        return True
    if re.search(r"(?m)^\s*(end|return|!)\s*$", text) and hits >= 1 and len(lines) >= 15:
        return True
    return len(lines) >= 25 and hits >= 1


def clean_config(text: str) -> str:
    return _VOLATILE.sub("", text)


PROFILES = {
    "olt_intelbras": CliBackupProfile("OLT Intelbras", "telnet"),
    "olt_fiberhome": CliBackupProfile("OLT FiberHome", "telnet",
                                      backup_commands=("show startup-config", "show running-config") + DEFAULT_BACKUP_COMMANDS),
    "olt_vsol": CliBackupProfile("OLT VSOL", "telnet",
                                 backup_commands=("show running-config-devel", "show running-config", "show config",
                                                  "show configuration", "show running")),
    "olt_parks": CliBackupProfile("OLT Parks", "ssh"),
}


class CliBackupDriver:
    simulated = False
    session_idle_s = 45
    poll_interval_s = 60

    def __init__(self, connect, profile: CliBackupProfile, *, enable_secrets=(), transport_note="", transport_hygiene=()):
        self._connect = connect
        self.profile = profile
        self.enable_secrets = tuple(s for s in enable_secrets if s)
        self.transport_note = transport_note
        self.transport_hygiene = tuple(transport_hygiene)
        self._check_cache = None

    @classmethod
    def from_device(cls, dev: dict, credentials: dict, profile: CliBackupProfile):
        cred = credentials.get(dev.get("credential_ref") or "")
        if not cred:
            raise RuntimeError(f"credencial '{dev.get('credential_ref')}' não encontrada no arquivo local do agente")
        if not dev.get("host"):
            raise RuntimeError("OLT sem endereço configurado")
        from .. import os_cli
        from ..cli_transport import hygiene, note, settings
        settings(cred)  # valida transport/ssh_profile/allow_telnet (telnet exige allow_telnet)
        transport = cred.get("transport") or profile.transport_default
        host = dev["host"]
        port = int(dev.get("api_port") or (23 if transport == "telnet" else 22))
        user, pw = cred["username"], cred["password"]
        connect = lambda: os_cli.connect(transport, host, port, user, pw, cred)  # noqa: E731
        secrets = (cred.get("enable_password"), pw, user)
        return cls(connect, profile, enable_secrets=secrets, transport_note=note(cred), transport_hygiene=hygiene(cred))

    def _enable(self, s):
        if not self.profile.needs_enable:
            return
        s.chan.write("enable\n")
        out = s.read_idle(idle=1.2, maxt=8, page=False)
        if re.search(r"(?i)(password|senha|passwd)\s*[: ]", out[-160:]):
            for sec in self.enable_secrets:
                s.chan.write(sec + "\n")
                out = s.read_idle(idle=1.2, maxt=8, page=False)
                if not re.search(r"(?i)(password|senha|passwd)\s*[: ]", out[-160:]):
                    break

    def _disable_paging(self, s):
        for cmd in PAGING_COMMANDS:
            try:
                s.run(cmd, idle=0.8, maxt=6)
            except Exception:
                pass

    def _collect(self):
        s = self._connect()
        out = ""
        try:
            self._enable(s)
            self._disable_paging(s)
            for cmd in self.profile.backup_commands:
                out = s.dump(cmd, idle=4.0, maxt=240)
                if looks_config(out, self.profile.markers):
                    return cmd, out
            return None, out
        finally:
            s.close()

    def check(self) -> dict:
        import time
        if self._check_cache and time.time() - self._check_cache[0] < self.poll_interval_s:
            return self._check_cache[1]
        s = self._connect()
        try:
            self._enable(s)
            self._disable_paging(s)
        finally:
            s.close()
        detail = f"{self.profile.name} — backup por CLI; driver não homologado em equipamento real"
        if self.transport_note:
            detail += f"; {self.transport_note}"
        result = {"ok": True, "product": self.profile.name, "firmware": None, "homologated": False, "detail": detail}
        if self.transport_hygiene:
            result["hygiene"] = list(self.transport_hygiene)
        self._check_cache = (time.time(), result)
        return result

    def export_config(self) -> str:
        cmd, out = self._collect()
        if not cmd:
            raise CliBackupError("nenhum comando de dump trouxe configuração reconhecível; backup não registrado")
        return clean_config(out)

    def _no_writes(self, *_a, **_k):
        raise CliBackupError(f"provisionamento de ONU {self.profile.name} não homologado neste agente (apenas backup)")

    authorize = deauthorize = _no_writes
