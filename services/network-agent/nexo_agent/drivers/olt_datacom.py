"""Driver de OLT Datacom (DmOS — DM4615 e afins), GPON. Construído a partir de reconhecimento em equipamento real
(docs/estudo-campo/recon-cli-olts.md). SUPERFÍCIE VALIDADA: identidade (`show firmware`/`show system`) e backup de
configuração (`show running-config | nomore`). Leitura/provisionamento de ONU ainda não implementados para Datacom
(a enumeração de ONU no DmOS precisa de mais reconhecimento); autorização é recusada explicitamente.

Transporte: SSH pelo `cli_transport` do agente (netmiko `datacom_dmos`), com a chave do equipamento fixada. Só leitura.
"""
import re
from typing import Optional

from .base import AckLost  # noqa: F401 (contrato comum)


class DatacomCommandError(Exception):
    pass


def check_failure(output: str):
    m = re.search(r"^\s*(syntax error\b.*|%\s*Error\b.*|.*command not found.*)$", output, re.M | re.I)
    if m:
        raise DatacomCommandError(m.group(1).strip())


def parse_firmware(output: str) -> Optional[str]:
    """'show firmware': primeira versão marcada como Active."""
    for line in output.splitlines():
        m = re.match(r"^\s*(\S+)\s+Active\b", line)
        if m:
            return m.group(1)
    return None


# Linhas voláteis do 'show running-config' que mudam sem a config mudar (nada conhecido no DmOS por ora; reservado).
_VOLATILE = re.compile(r"(?mi)^\s*!\s*(Last (commit|configuration)|Generated)\b.*\n?")


def clean_running_config(text: str) -> str:
    return _VOLATILE.sub("", text)


class DatacomOltDriver:
    simulated = False
    session_idle_s = 45
    poll_interval_s = 60

    def __init__(self, connect, *, transport_note: str = "", transport_hygiene=()):
        self._connect = connect
        self.transport_note = transport_note
        self.transport_hygiene = tuple(transport_hygiene)
        self._cli = None
        self._cli_used = 0.0
        self._check_cache = None

    @classmethod
    def from_device(cls, dev: dict, credentials: dict):
        cred = credentials.get(dev.get("credential_ref") or "")
        if not cred:
            raise RuntimeError(f"credencial '{dev.get('credential_ref')}' não encontrada no arquivo local do agente")
        if not dev.get("host"):
            raise RuntimeError("OLT sem endereço configurado")
        from ..cli_transport import default_port, hygiene, note
        host = dev["host"]
        port = int(dev.get("api_port") or default_port(cred))
        connect = lambda: DatacomCli(host, port, cred["username"], cred["password"], cred)  # noqa: E731
        return cls(connect, transport_note=note(cred), transport_hygiene=hygiene(cred))

    def _session(self):
        import time
        if self._cli is not None and time.time() - self._cli_used > self.session_idle_s:
            self._drop()
        if self._cli is None:
            self._cli = self._connect()
        self._cli_used = time.time()
        return self._cli

    def _drop(self):
        if self._cli is not None:
            try:
                self._cli.close()
            finally:
                self._cli = None

    def check(self) -> dict:
        import time
        if self._check_cache and time.time() - self._check_cache[0] < self.poll_interval_s:
            return self._check_cache[1]
        out = self._session().run("show firmware")
        check_failure(out)
        version = parse_firmware(out)
        detail = f"Datacom DmOS{(' ' + version) if version else ''} — driver não homologado em equipamento real"
        if self.transport_note:
            detail += f"; {self.transport_note}"
        result = {"ok": True, "product": "Datacom DmOS", "firmware": version, "homologated": False, "detail": detail}
        if self.transport_hygiene:
            result["hygiene"] = list(self.transport_hygiene)
        self._check_cache = (time.time(), result)
        return result

    def export_config(self) -> str:
        """Backup: 'show running-config | nomore' numa sessão própria (não disputa a das operações)."""
        cli = self._connect()
        try:
            out = cli.dump("show running-config | nomore")
        finally:
            cli.close()
        check_failure(out)
        text = clean_running_config(out)
        if not re.search(r"^\s*(interface|aaa user|hostname|snmp)\b", text, re.M):
            raise DatacomCommandError("resposta sem configuração reconhecível; backup não registrado")
        return text

    def _no_writes(self, *_a, **_k):
        raise DatacomCommandError("provisionamento de ONU Datacom não homologado neste agente (apenas identidade e backup)")

    authorize = deauthorize = _no_writes


class DatacomCli:
    """Sessão SSH Datacom DmOS pelo cli_transport do agente. `dump` lê o running-config usando o prompt real como
    terminador (o DmOS não pagina com '| nomore')."""

    def __init__(self, host: str, port: int, username: str, password: str, cred: dict):
        # DmOS tem CLI estilo Cisco IOS; o netmiko não tem plataforma própria de Datacom, então usa-se cisco_ios
        # (mesma escolha do backup center). O cli_transport mapeia cisco_ios -> cisco_ios_telnet quando é telnet.
        from ..cli_transport import connect
        self._c = connect("cisco_ios", host, port, username, password, cred,
                          conn_timeout=20, auth_timeout=20, banner_timeout=20)

    def run(self, command: str) -> str:
        return self._c.send_command(command, expect_string=r"[>#]\s*$", read_timeout=60, cmd_verify=True,
                                    strip_prompt=False, strip_command=True)

    def dump(self, command: str) -> str:
        prompt = ""
        try:
            prompt = (self._c.find_prompt() or "").strip()
        except Exception:
            prompt = ""
        expect = re.escape(prompt) if prompt else r"[>#]\s*$"
        return self._c.send_command(command, expect_string=expect, read_timeout=300, cmd_verify=True,
                                    strip_prompt=True, strip_command=True)

    def close(self) -> None:
        try:
            self._c.disconnect()
        except Exception:
            pass
