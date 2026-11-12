"""Driver de OLT Datacom (DmOS — DM4615 e afins), GPON. Construído a partir de reconhecimento em equipamento real
(docs/estudo-campo/recon-cli-olts.md). SUPERFÍCIE VALIDADA EM CAMPO (AtivaTec, 2026-11-12): identidade
(`show firmware`), backup (`show running-config | nomore`) e LEITURA de ONU — lista por porta
(`show interface gpon f/s/p onu`) e sinal óptico (`show interface gpon f/s/p onu <id> optical-info`:
`Rx Optical Power [dBm]` / `Tx Optical Power [dBm]`). O DmOS pagina a saída; o modificador `| nomore` a suprime
(o `run` o anexa aos comandos `show`).

Autorização/remoção de ONU: implementadas e PROVADAS NO LABORATÓRIO (emulador por telnet real), transacionais
(`commit`; `abort` em qualquer erro), NÃO homologadas em DmOS real. Travadas por padrão: só com "allow_writes": true
+ firmware lido do `show firmware` igual ao aprovado na credencial local.

Transporte: `cli_transport` do agente (netmiko cisco_ios/_telnet — DmOS tem CLI estilo Cisco).
"""
import re
from typing import Optional

from .base import AckLost  # noqa: F401 (contrato comum)
from .olt_base import OnuState, WriteRefused, free_id, require_write, safe


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


def parse_ports(output: str) -> list[str]:
    """Portas GPON do dump físico ('Physical interface : gpon f/s/p, ...')."""
    return sorted(set(re.findall(r"gpon\s+(\d+/\d+/\d+)", output)))


def parse_onu_list(output: str) -> list[dict]:
    """'show interface gpon f/s/p onu': Itf, ONU ID, Serial Number, Oper State, Software Download State, Name.
    O Name (o 'name' configurado na ONU) carrega o marcador de versão quando a ONU foi provisionada pelo sistema."""
    rows = []
    for line in output.splitlines():
        m = re.match(r"^\s*(\d+/\d+/\d+)\s+(\d+)\s+([0-9A-Za-z]{8,20})\s+(\S+)(?:\s+(\S+)\s*(.*?))?\s*$", line)
        if m:
            rows.append({"pon_port": m.group(1), "onu_id": int(m.group(2)), "serial": m.group(3).upper(),
                         "oper": m.group(4).lower(), "name": (m.group(6) or "").strip() or None})
    return rows


def parse_service_ports(config: str) -> dict:
    """Linhas 'service-port <id> gpon <f/s/p> onu <n> ...' do running-config -> {id: (porta, onu)}."""
    out = {}
    for m in re.finditer(r"(?m)^\s*service-port\s+(\d+)\s+gpon\s+(\d+/\d+/\d+)\s+onu\s+(\d+)\b", config or ""):
        out[int(m.group(1))] = (m.group(2), int(m.group(3)))
    return out


def parse_optical(output: str) -> tuple[Optional[float], Optional[float]]:
    def num(label):
        m = re.search(rf"{re.escape(label)}\s*:\s*(-?\d+\.\d+)", output, re.I)
        return float(m.group(1)) if m else None
    return num("Rx Optical Power [dBm]"), num("Tx Optical Power [dBm]")


class DatacomOltDriver:
    simulated = False
    session_idle_s = 45
    poll_interval_s = 60

    def __init__(self, connect, *, allow_writes: bool = False, expected_product=None, expected_firmware=None,
                 transport_note: str = "", transport_hygiene=()):
        self._connect = connect
        self.allow_writes = allow_writes
        self.expected_product = expected_product
        self.expected_firmware = expected_firmware
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
        if cred.get("allow_writes") is True and (not cred.get("expected_product") or not cred.get("expected_firmware")):
            raise ValueError("escrita OLT exige modelo e firmware esperados explícitos na configuração local")
        from ..cli_transport import default_port, hygiene, note
        host = dev["host"]
        port = int(dev.get("api_port") or default_port(cred))
        connect = lambda: DatacomCli(host, port, cred["username"], cred["password"], cred)  # noqa: E731
        return cls(connect, allow_writes=cred.get("allow_writes") is True, expected_product=cred.get("expected_product"),
                   expected_firmware=cred.get("expected_firmware"), transport_note=note(cred), transport_hygiene=hygiene(cred))

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

    def _ports(self, s) -> list[str]:
        # Faixa de portas GPON do DM4615 (1/1/1..1/1/16). Portas inexistentes devolvem erro e são puladas no
        # _onu_index; portas sem ONU devolvem só o cabeçalho.
        return [f"1/1/{p}" for p in range(1, 17)]

    def _onu_index(self, s) -> dict:
        """Mapa serial -> (porta, onu_id, oper) varrendo as portas GPON (uma listagem por porta)."""
        index = {}
        for port in self._ports(s):
            raw = s.run(f"show interface gpon {port} onu")
            if re.search(r"syntax error|invalid input|not found|does not exist", raw, re.I):
                continue  # porta ausente neste modelo
            for row in parse_onu_list(raw):
                index[row["serial"]] = row
        return index

    def discover(self) -> list[dict]:
        # O DmOS não tem um comando simples de ONUs não autorizadas mapeado; não se reporta lista de autofind.
        return []

    def read_onu(self, serial: str) -> OnuState:
        return self.read_onus([serial]).get(serial, OnuState(authorized=False))

    def read_onus(self, serials: list[str]) -> dict[str, OnuState]:
        want = {s.upper() for s in serials}
        s = self._session()
        index = self._onu_index(s)
        out = {}
        for sn in serials:
            row = index.get(sn.upper())
            if not row:
                out[sn] = OnuState(authorized=False)
                continue
            rx = tx = None
            try:
                rx, tx = parse_optical(s.run(f"show interface gpon {row['pon_port']} onu {row['onu_id']} optical-info"))
            except DatacomCommandError:
                pass
            out[sn] = OnuState(authorized=True, pon_port=row["pon_port"], online=row["oper"] in ("up", "online"),
                               description=row.get("name"), rx_dbm=rx, tx_dbm=tx,
                               extra={"onu_id": row["onu_id"], "oper": row["oper"]})
        return out

    # --- escrita (autorizar/desautorizar) --------------------------------------------------------------------------
    # Provada no laboratório (emulador por telnet real); NÃO homologada em DmOS real. O DmOS é transacional: nada vale
    # sem 'commit' e, em qualquer erro, o driver dá 'abort' (descarta a candidata) — não fica efeito parcial.
    _CFG_ERROR = re.compile(r"syntax error|^\s*Error:|Aborted:|%\s*Invalid|%\s*Error|is not valid|already exists", re.I | re.M)

    def _require_write_capability(self, s):
        if not self.allow_writes:
            raise DatacomCommandError("escrita OLT desabilitada na configuração local (provisionamento Datacom não homologado)")
        firmware = parse_firmware(s.run("show firmware"))
        try:
            require_write(self.allow_writes, self.expected_product, self.expected_firmware, "Datacom DmOS" if firmware else None, firmware)
        except WriteRefused as e:
            raise DatacomCommandError(str(e)) from e

    def _transaction(self, s, commands: list[str]):
        s.run("config")
        try:
            for c in commands:
                out = s.run(c)
                if self._CFG_ERROR.search(out):
                    raise DatacomCommandError(f"OLT recusou {c!r}: {out.strip()[-200:]}")
            out = s.run("commit")
            if self._CFG_ERROR.search(out):
                raise DatacomCommandError(f"commit recusado: {out.strip()[-200:]}")
        except Exception:
            s.run("abort")  # descarta a configuração candidata; volta ao modo de execução
            raise
        s.run("end")

    def authorize(self, serial: str, *, pon_port: str, line_profile: str, service_vlan: int, description: str,
                  service_profile: Optional[str] = None) -> dict:
        if not self.allow_writes:
            raise DatacomCommandError("escrita OLT desabilitada na configuração local (provisionamento Datacom não homologado)")
        sn, lp, name = safe(serial, "serial").upper(), safe(line_profile, "line-profile"), safe(description, "nome")
        m = re.search(r"(\d+/\d+/\d+)", pon_port or "")
        if not m:
            raise ValueError(f"porta PON Datacom inválida: {pon_port!r}")
        port, vlan = m.group(1), int(service_vlan)
        if not 1 <= vlan <= 4094:
            raise ValueError("VLAN fora da faixa 1-4094")
        s = self._session()
        self._require_write_capability(s)
        oid = free_id([r["onu_id"] for r in parse_onu_list(s.run(f"show interface gpon {port} onu"))], 0, 127)
        spid = free_id(parse_service_ports(s.run("show running-config service-port")).keys(), 1, 4094)
        self._transaction(s, [f"interface gpon {port}", f"onu {oid}", f"serial-number {sn}", f"line-profile {lp}",
                              f"name {name}", "exit", "exit",
                              f"service-port {spid} gpon {port} onu {oid} gem 1 match vlan vlan-id {vlan} action vlan replace vlan-id {vlan}"])
        return {"onu_id": oid, "pon_port": port, "service_port": spid, "service_vlan": vlan}

    def deauthorize(self, serial: str) -> dict:
        if not self.allow_writes:
            raise DatacomCommandError("escrita OLT desabilitada na configuração local (provisionamento Datacom não homologado)")
        sn = safe(serial, "serial").upper()
        s = self._session()
        row = self._onu_index(s).get(sn)
        if not row:
            return {"removed": 0}  # idempotente
        self._require_write_capability(s)
        port, oid = row["pon_port"], row["onu_id"]
        sps = sorted(i for i, (p, o) in parse_service_ports(s.run("show running-config service-port")).items() if (p, o) == (port, oid))
        self._transaction(s, [f"no service-port {i}" for i in sps] + [f"interface gpon {port}", f"no onu {oid}", "exit"])
        return {"removed": 1, "onu_id": oid, "service_ports_removed": len(sps)}


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
        # O DmOS pagina a saída ('--More--') e o prompt não retorna; '| nomore' suprime a paginação (validado em
        # campo). Anexa só a comandos 'show' (modificador de pipe não vale em comando de configuração).
        cmd = command + " | nomore" if command.startswith("show ") and "|" not in command else command
        return self._c.send_command(cmd, expect_string=r"[>#]\s*$", read_timeout=60, cmd_verify=True,
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
