"""Driver de OLT Huawei SmartAX (família MA5600T/MA5608T/MA5800) por CLI (SSH), modo GPON com autenticação por serial.

SITUAÇÃO: **NÃO HOMOLOGADO EM EQUIPAMENTO REAL.** Escrito a partir de guias públicos de integradores e testado apenas contra um
emulador próprio da CLI (olt_huawei_emulator.py). A sintaxe dos comandos foi conferida nessas fontes; o formato exato das saídas
varia com a versão do firmware e precisa ser validado na OLT do provedor antes de qualquer uso em produção.

Conjunto fechado de comandos (nenhum texto livre vindo da nuvem é executado):
  display version | display ont autofind all | display ont info by-sn <SN> | display service-port port <F/S/P> ont <ID>
  interface gpon <F/S> ; ont add ... ; ont delete <P> <ID> ; display ont optical-info <P> <ID>
  service-port vlan <V> gpon <F/S/P> ont <ID> gemport <G> multi-service user-vlan <V> tag-transform translate ; undo service-port <INDEX>

Fora do escopo: criação de VLAN, perfis de linha/serviço e DBA (devem existir na OLT), ONU em modo roteador, TR-069, VoIP."""
import re
from typing import Optional, Protocol

from .olt_base import OnuState
from .base import AckLost


class OltCommandError(Exception):
    """A OLT recusou o comando (linha 'Failure:' ou erro de sintaxe '% ...')."""


class Cli(Protocol):
    def run(self, command: str) -> str: ...
    def close(self) -> None: ...


# ------------------------------------------------------------------ interpretação das saídas

def normalize_serial(serial: str) -> str:
    """A CLI usa o serial em 16 dígitos hexadecimais. Aceita também a forma 'HWTC1A2B3C4D' (4 letras do fabricante + 8 hex)."""
    s = re.sub(r"[^A-Za-z0-9]", "", serial).upper()
    if re.fullmatch(r"[0-9A-F]{16}", s):
        return s
    if re.fullmatch(r"[A-Z]{4}[0-9A-F]{8}", s):
        return s[:4].encode("ascii").hex().upper() + s[4:]
    raise ValueError(f"serial GPON inválido para Huawei: {serial!r} (use 16 hex ou 4 letras + 8 hex)")


def _field(text: str, label: str) -> Optional[str]:
    m = re.search(rf"^\s*{re.escape(label)}\s*:\s*(.*?)\s*$", text, re.M | re.I)
    return m.group(1) if m else None


def check_failure(output: str):
    m = re.search(r"^\s*(Failure\s*:.*|Error\s*:.*|%\s*\S.*)$", output, re.M | re.I)
    if m:
        raise OltCommandError(m.group(1).strip())


def parse_autofind(output: str) -> list[dict]:
    """Blocos de 'display ont autofind all'. Cada bloco traz 'F/S/P' e 'Ont SN : <16hex> (<VEND>-<8hex>)'."""
    found = []
    for block in re.split(r"^\s*-{10,}\s*$", output, flags=re.M):
        fsp, sn = _field(block, "F/S/P"), _field(block, "Ont SN")
        if not fsp or not sn:
            continue
        m = re.match(r"([0-9A-Fa-f]{16})", sn)
        if not m:
            continue
        found.append({"serial": m.group(1).upper(), "pon_port": fsp.replace(" ", ""), "vendor": _field(block, "VendorID"),
                      "model": _field(block, "Ont EquipmentID")})
    return found


def parse_ont_info(output: str) -> Optional[dict]:
    """'display ont info by-sn'. Devolve None quando a ONT não está cadastrada."""
    fsp, ont_id = _field(output, "F/S/P"), _field(output, "ONT-ID")
    if not fsp or ont_id is None or not ont_id.isdigit():
        return None
    return {"pon_port": fsp.replace(" ", ""), "ont_id": int(ont_id), "run_state": (_field(output, "Run state") or "").lower(),
            "config_state": _field(output, "Config state"), "match_state": _field(output, "Match state"),
            "description": _field(output, "Description"), "line_profile": _field(output, "Line profile name"),
            "service_profile": _field(output, "Service profile name"), "distance_m": _field(output, "ONT distance(m)"),
            "last_down_cause": _field(output, "Last down cause")}


def parse_service_ports(output: str) -> list[dict]:
    """Linhas de 'display service-port port F/S/P ont ID': 'INDEX VLAN ATTR gpon F/S /P ONT GEM ... STATE'."""
    rows = []
    for line in output.splitlines():
        m = re.match(r"^\s*(\d+)\s+(\d+)\s+\S+\s+gpon\s+[\d/ ]+?\s+(\d+)\s+(\d+)\s", line)
        if m:
            rows.append({"index": int(m.group(1)), "vlan": int(m.group(2)), "ont_id": int(m.group(3)), "gemport": int(m.group(4))})
    return rows


def parse_optical(output: str) -> tuple[Optional[float], Optional[float]]:
    def num(label: str) -> Optional[float]:
        v = _field(output, label)
        try:
            return float(v) if v not in (None, "-", "") else None
        except ValueError:
            return None
    return num("Rx optical power(dBm)"), num("Tx optical power(dBm)")


def _scoped_service_ports(output: str, ont_id: int) -> list[dict]:
    if re.search(r"Failure\s*:\s*No service virtual port can be operated", output, re.I):
        return []
    check_failure(output)
    rows = parse_service_ports(output)
    if not rows or any(row["ont_id"] != ont_id for row in rows):
        raise OltCommandError("service-port não reconhecido ou de outra ONT; estado desconhecido")
    return rows


def parse_ont_add(output: str) -> int:
    m = re.search(r"ONTID\s*:\s*(\d+)", output)
    if not m:
        raise OltCommandError(f"resposta inesperada ao adicionar a ONT: {output.strip()[:200]}")
    return int(m.group(1))


def split_port(pon_port: str) -> tuple[str, str]:
    """'0/1/3' -> ('0/1', '3')."""
    parts = pon_port.split("/")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        raise ValueError(f"porta PON deve ter o formato frame/slot/porta, ex.: 0/1/3 (recebido: {pon_port!r})")
    return "/".join(parts[:2]), parts[2]


_SAFE = re.compile(r"^[A-Za-z0-9_.:\-]{1,64}$")


def _safe(value: str, what: str) -> str:
    """Tudo que entra em um comando é validado: sem espaços, aspas ou caracteres de controle."""
    if not _SAFE.match(value or ""):
        raise ValueError(f"{what} contém caracteres não permitidos: {value!r}")
    return value


# ------------------------------------------------------------------ transporte real (SSH)

class NetmikoCli:
    """Sessão SSH via netmiko (device_type huawei_smartax). Lê até o prompt aparecer (sem esperas fixas) e responde
    às confirmações "{ <cr>|... }:" e à paginação "---- More ----"."""

    _END = r"(?:[>#]|\}\s*:|More[^\n]*----)\s*$"

    def __init__(self, host: str, port: int, username: str, password: str, known_hosts_file: str):
        from netmiko import ConnectHandler
        from ..ssh_trust import ssh_parameters
        security = ssh_parameters(host, port, known_hosts_file)
        self._c = ConnectHandler(device_type="huawei_smartax", host=host, port=port, username=username, password=password,
                                 conn_timeout=15, auth_timeout=15, banner_timeout=15, fast_cli=True, global_delay_factor=0.1, **security)
        try:
            for cmd in ("enable", "undo smart", "undo interactive", "scroll 512", "config"):
                check_failure(self._send(cmd))
        except Exception:
            self.close()
            raise

    def _send(self, command: str) -> str:
        return self._c.send_command(command, expect_string=self._END, strip_prompt=False, strip_command=True, read_timeout=30, cmd_verify=False)

    def run(self, command: str) -> str:
        try:
            return self._run_command(command)
        except Exception:
            if re.match(r"^(ont (add|delete)\b|service-port\b|undo service-port\b)", command):
                raise AckLost("confirmação SSH ausente após comando mutante; consultar estado") from None
            raise

    def _run_command(self, command: str) -> str:
        out = self._send(command)
        for _ in range(50):
            tail = out.rstrip().splitlines()[-1] if out.strip() else ""
            if re.search(r"\}\s*:$", tail):
                out += "\n" + self._send("")
            elif "---- More" in tail:
                out += "\n" + self._send(" ")
            else:
                break
        else:
            raise OltCommandError("resposta CLI incompleta após limite de paginação")
        lines = out.splitlines()
        if lines and re.search(r"[>#]\s*$", lines[-1]):
            lines = lines[:-1]
        return "\n".join(lines)

    def close(self) -> None:
        try:
            self._c.disconnect()
        except Exception:
            pass


# ------------------------------------------------------------------ driver

class HuaweiOltDriver:
    simulated = False

    def __init__(self, connect, gemport: int = 1, *, allow_writes=True, expected_product=None, expected_firmware=None):
        self._connect, self.gemport = connect, gemport
        self.allow_writes, self.expected_product, self.expected_firmware = allow_writes, expected_product, expected_firmware
        self._check_cache = None
        self._cli, self._cli_used = None, 0.0

    @classmethod
    def from_device(cls, dev: dict, credentials: dict):
        cred = credentials.get(dev.get("credential_ref") or "")
        if not cred:
            raise RuntimeError(f"credencial '{dev.get('credential_ref')}' não encontrada no arquivo local do agente")
        if not dev.get("host"):
            raise RuntimeError("OLT sem endereço configurado")
        host, port = dev["host"], int(dev.get("api_port") or 22)
        if cred.get("allow_writes") is True and (not cred.get("expected_product") or not cred.get("expected_firmware")):
            raise ValueError("escrita OLT exige modelo e firmware esperados explícitos na configuração local")
        return cls(lambda: NetmikoCli(host, port, cred["username"], cred["password"], cred.get("known_hosts_file", "")), int(cred.get("gemport", 1)),
                   allow_writes=cred.get("allow_writes") is True, expected_product=cred.get("expected_product"), expected_firmware=cred.get("expected_firmware"))

    def _session(self):
        """Reaproveita a sessão SSH entre chamadas próximas (abrir uma sessão custa segundos). Qualquer erro descarta a sessão,
        para que a próxima chamada comece limpa, em modo de configuração."""
        import time
        if self._cli is not None and time.time() - self._cli_used > self.session_idle_s:
            self._drop()
        if self._cli is None:
            self._cli = self._connect()
        self._cli_used = time.time()
        return _Session(self._cli, self._drop)

    def _drop(self):
        if self._cli is not None:
            try:
                self._cli.close()
            finally:
                self._cli = None

    # --- contrato do driver ---
    def check(self) -> dict:
        import time
        if self._check_cache and time.time() - self._check_cache[0] < self.poll_interval_s:
            return self._check_cache[1]  # evita uma sessão SSH a cada ciclo do agente
        r = self._check()
        self._check_cache = (time.time(), r)
        return r

    def _check(self) -> dict:
        with self._session() as s:
            out = s.run("display version")
        product, firmware = _field(out, "PRODUCT"), _field(out, "VERSION")
        if not product or not firmware:
            raise OltCommandError("modelo/firmware não reconhecido; capacidade não confirmada")
        return {"ok": True, "product": product, "firmware": firmware, "homologated": False, "detail": f"{product} {firmware}"
                + " — driver não homologado em equipamento real"}

    def _require_write_capability(self):
        if not self.allow_writes:
            raise OltCommandError("escrita OLT desabilitada na configuração local")
        if self.expected_product is not None or self.expected_firmware is not None:
            actual = self._check()
            if not self.expected_product or not self.expected_firmware or actual["product"] != self.expected_product or actual["firmware"] != self.expected_firmware:
                raise OltCommandError("modelo/firmware não coincide com a capacidade aprovada localmente")

    def discover(self) -> list[dict]:
        with self._session() as s:
            output = s.run("display ont autofind all", tolerate=True)
            if re.search(r"Failure\s*:\s*The automatically found ONTs do not exist", output, re.I):
                return []
            check_failure(output)
            found = parse_autofind(output)
            if not found and not re.search(r"number of GPON autofind ONT is\s+0\b", output, re.I):
                raise OltCommandError("descoberta incompleta/não reconhecida; não reportar lista vazia")
            return found

    session_idle_s = 45
    poll_interval_s = 60   # leitura periódica: uma sessão SSH por ciclo para descoberta + todas as ONUs

    def read_onu(self, serial: str) -> OnuState:
        with self._session() as s:
            return self._read(s, serial)

    def read_onus(self, serials: list[str]) -> dict[str, OnuState]:
        """Estado de várias ONUs em UMA sessão (leitura periódica)."""
        with self._session() as s:
            return {sn: self._read(s, sn) for sn in serials}

    def _read(self, s, serial: str) -> OnuState:
        sn = normalize_serial(serial)
        if True:
            raw = s.run(f"display ont info by-sn {sn}", tolerate=True)
            if re.search(r"Failure\s*:\s*The required ONT does not exist", raw, re.I):
                return OnuState(authorized=False)
            check_failure(raw)
            info = parse_ont_info(raw)
            if not info:
                raise OltCommandError("resposta ONT incompleta; estado desconhecido")
            if _field(raw, "SN") != sn:
                raise OltCommandError("serial do readback não corresponde à ONU consultada")
            split_port(info["pon_port"])
            raw_ports = s.run(f"display service-port port {info['pon_port']} ont {info['ont_id']}", tolerate=True)
            empty_ports = re.search(r"Failure\s*:\s*No service virtual port can be operated", raw_ports, re.I)
            if not empty_ports:
                check_failure(raw_ports)
            ports = _scoped_service_ports(raw_ports, info["ont_id"])
            online = info["run_state"] == "online"
            rx = tx = None
            if online:
                fs, p = split_port(info["pon_port"])
                s.run(f"interface gpon {fs}")
                rx, tx = parse_optical(s.run(f"display ont optical-info {p} {info['ont_id']}", tolerate=True))
                s.run("quit")
        return OnuState(True, info["pon_port"], info["line_profile"], ports[0]["vlan"] if len(ports) == 1 else None, info["description"], online, rx, tx,
                        {"ont_id": info["ont_id"], "service_ports": len(ports), "last_down_cause": info["last_down_cause"], "distance_m": info["distance_m"]},
                        service_profile=info["service_profile"])

    def authorize(self, serial: str, *, pon_port: str, line_profile: str, service_vlan: int, description: str, service_profile: Optional[str] = None) -> dict:
        sn = normalize_serial(serial)
        fs, p = split_port(pon_port)
        if not service_profile:
            raise ValueError("OLT Huawei exige o perfil de serviço (ont-srvprofile-name)")
        vlan = int(service_vlan)
        if not 1 <= vlan <= 4094 or not 1 <= self.gemport <= 4095:
            raise ValueError("VLAN ou GEM port fora da capacidade suportada")
        _safe(line_profile, "perfil de linha"); _safe(service_profile, "perfil de serviço"); _safe(description, "descrição")
        self._require_write_capability()
        with self._session() as s:
            s.run(f"interface gpon {fs}")
            ont_id = parse_ont_add(s.run(
                f'ont add {p} sn-auth "{sn}" omci ont-lineprofile-name "{_safe(line_profile, "perfil de linha")}" '
                f'ont-srvprofile-name "{_safe(service_profile, "perfil de serviço")}" desc "{_safe(description, "descrição")}"'))
            s.run("quit")
            s.run(f"service-port vlan {vlan} gpon {fs}/{p} ont {ont_id} gemport {self.gemport} multi-service user-vlan {vlan} tag-transform translate")
        return {"ont_id": ont_id, "pon_port": pon_port, "service_vlan": vlan, "gemport": self.gemport}

    def deauthorize(self, serial: str) -> dict:
        sn = normalize_serial(serial)
        self._require_write_capability()
        with self._session() as s:
            raw = s.run(f"display ont info by-sn {sn}", tolerate=True)
            if re.search(r"Failure\s*:\s*The required ONT does not exist", raw, re.I):
                return {"removed": 0}
            check_failure(raw); info = parse_ont_info(raw)
            if not info or _field(raw, "SN") != sn:
                raise OltCommandError("identidade/estado ONT desconhecido; remoção recusada")
            split_port(info["pon_port"])
            raw_ports = s.run(f"display service-port port {info['pon_port']} ont {info['ont_id']}", tolerate=True)
            if not re.search(r"Failure\s*:\s*No service virtual port can be operated", raw_ports, re.I):
                check_failure(raw_ports)
            ports = _scoped_service_ports(raw_ports, info["ont_id"])
            for sp in ports:
                s.run(f"undo service-port {sp['index']}")
            fs, p = split_port(info["pon_port"])
            s.run(f"interface gpon {fs}")
            s.run(f"ont delete {p} {info['ont_id']}")
            s.run("quit")
        return {"removed": 1, "service_ports_removed": len(ports), "ont_id": info["ont_id"]}


class _Session:
    """Uso de uma sessão de CLI. 'tolerate' aceita respostas 'Failure:' em consultas (ex.: ONT inexistente).
    Saída normal mantém a conexão aberta para reuso; exceção a descarta."""

    def __init__(self, cli: Cli, drop):
        self._cli, self._drop = cli, drop

    def run(self, command: str, tolerate: bool = False) -> str:
        out = self._cli.run(command)
        if not tolerate:
            check_failure(out)
        return out

    def __enter__(self):
        return self

    def __exit__(self, exc_type, *exc):
        if exc_type is not None:
            self._drop()
        return False
