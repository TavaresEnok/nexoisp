"""Driver de OLT ZTE ZXA10 (C300/C320/C6xx), GPON. Construído a partir de reconhecimento em equipamento real
(docs/estudo-campo/recon-cli-olts.md). SUPERFÍCIE VALIDADA: identidade (`show card`), backup de configuração
(`show running-config`) e leitura de ONU (`show gpon onu detail-info` + `show pon power ...`). A autorização/remoção de
ONU NÃO está homologada para ZTE e é recusada explicitamente (a sintaxe varia por firmware e não foi testada em campo).

Transporte: o mesmo `cli_transport` do agente (netmiko `zte_zxros`/`zte_zxros_telnet`). Só leitura aqui.
"""
import re
from typing import Optional, Protocol

from .base import AckLost  # noqa: F401  (contrato comum dos drivers)
from .olt_base import OnuState


class ZteCommandError(Exception):
    pass


class Cli(Protocol):
    def run(self, command: str) -> str: ...
    def dump(self, command: str) -> str: ...
    def close(self) -> None: ...


# "%Error ..." e "%Code ... Invalid" são falhas; "%Code 62310 ... No related information" é lista vazia, não erro.
def check_failure(output: str):
    if re.search(r"No related information to show", output, re.I):
        return
    m = re.search(r"^\s*(%Error\b.*|%Code\b.*(invalid|error).*)$", output, re.M | re.I)
    if m:
        raise ZteCommandError(m.group(1).strip())


def _field(text: str, label: str) -> Optional[str]:
    m = re.search(rf"^\s*{re.escape(label)}\s*:\s*(.*?)\s*$", text, re.M | re.I)
    return m.group(1).strip() if m else None


def normalize_index(index: str) -> str:
    """Aceita 'gpon-onu_1/2/1:1' ou '1/2/1:1' e devolve a forma curta 'f/s/p:id'."""
    m = re.search(r"(\d+/\d+/\d+:\d+)", index)
    if not m:
        raise ValueError(f"índice de ONU ZTE inválido: {index!r}")
    return m.group(1)


# O token de interface da ONU varia por firmware: XGSPON (ex.: NOBRE) usa 'gpon_onu-f/s/p:id',
# o C300 clássico usa 'gpon-onu_f/s/p:id'. A leitura tenta os dois e fica no que o equipamento aceitar.
_IFACE_PREFIXES = ("gpon_onu-", "gpon-onu_")


def onu_interface(index: str) -> str:
    return "gpon-onu_" + normalize_index(index)


def parse_card(output: str) -> list[dict]:
    """'show card' (ZXA10) — dois layouts reais, conforme o firmware:
       C300:    Rack Shelf Slot CfgType RealType Port HardVer [SoftVer] Status  (3 inteiros no início)
       XGSPON:  Shelf Slot CfgType CardName Port HardVer Status                 (sem Rack; 2 inteiros)
    Linhas OFFLINE podem omitir CardName/HardVer. 'real_type' guarda RealType (C300) ou CardName (XGSPON, ou None)."""
    rows = []
    for line in output.splitlines():
        m3 = re.match(r"^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]\w*)\s+(\S+)\s+(.*\S)\s*$", line)
        m2 = None if m3 else re.match(r"^\s*(\d+)\s+(\d+)\s+([A-Za-z]\w*)\s+(.*\S)\s*$", line)
        if m3:
            toks = m3.group(6).split()
            rows.append({"rack": int(m3.group(1)), "shelf": int(m3.group(2)), "slot": int(m3.group(3)),
                         "cfg_type": m3.group(4), "real_type": m3.group(5),
                         "ports": next((int(t) for t in toks if t.isdigit()), None),
                         "status": toks[-1] if toks else ""})
        elif m2:
            toks = m2.group(4).split()
            name = toks[0] if toks and not toks[0].isdigit() else None
            rows.append({"rack": None, "shelf": int(m2.group(1)), "slot": int(m2.group(2)),
                         "cfg_type": m2.group(3), "real_type": name,
                         "ports": next((int(t) for t in toks if t.isdigit()), None),
                         "status": toks[-1] if toks else ""})
    return rows


def parse_onu_state(output: str) -> list[dict]:
    """'show gpon onu state': OnuIndex(f/s/p:id) Admin OMCC Phase Channel."""
    rows = []
    for line in output.splitlines():
        m = re.match(r"^\s*(\d+/\d+/\d+:\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)", line)
        if m:
            rows.append({"index": m.group(1), "admin": m.group(2).lower(), "omcc": m.group(3).lower(),
                         "phase": m.group(4).lower(), "channel": m.group(5)})
    return rows


def parse_uncfg(output: str) -> list[dict]:
    """'show gpon onu uncfg': ONUs vistas e ainda não autorizadas (equivalente ao autofind). Vazio => []."""
    if re.search(r"No related information to show", output, re.I):
        return []
    found = []
    for line in output.splitlines():
        # Linhas com interface gpon_olt/gpon-onu e um serial (ZTE: 4 letras/dígitos + 8 hex, ou ASCII de 12).
        idx = re.search(r"gpon[-_]olt_(\d+/\d+/\d+)", line) or re.search(r"\b(\d+/\d+/\d+)\b", line)
        sn = re.search(r"\b([A-Z0-9]{4}[0-9A-Fa-f]{8})\b", line)
        if idx and sn:
            found.append({"pon_port": idx.group(1), "serial": sn.group(1).upper()})
    return found


def parse_onu_detail(output: str) -> Optional[dict]:
    """'show gpon onu detail-info gpon-onu_f/s/p:id'. None quando a ONU não existe."""
    iface = _field(output, "ONU interface")
    serial = _field(output, "Serial number")
    if not iface or not serial:
        return None
    return {"index": normalize_index(iface), "serial": serial, "name": _field(output, "Name"),
            "type": _field(output, "Type"), "phase_state": (_field(output, "Phase state") or "").lower(),
            "config_state": (_field(output, "Config state") or "").lower(), "admin_state": (_field(output, "Admin state") or "").lower(),
            "description": _field(output, "Description"), "distance_m": _field(output, "ONU Distance")}


def _dbm(text: str, pattern: str) -> Optional[float]:
    m = re.search(pattern, text, re.I)
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


def parse_power(onu_rx_output: str, attenuation_output: str) -> tuple[Optional[float], Optional[float]]:
    """Sinal da ONU: Rx de 'show pon power onu-rx' (ou do bloco 'down Rx:'), Tx do bloco 'up ... Tx:' da atenuação."""
    rx = _dbm(onu_rx_output, r"gpon[-_]onu[-_]\S+\s+(-?\d+\.\d+)\(dbm\)")
    if rx is None:
        rx = _dbm(attenuation_output, r"down\b.*?Rx\s*:\s*(-?\d+\.\d+)\(dbm\)")
    tx = _dbm(attenuation_output, r"up\b.*?Tx\s*:\s*(-?\d+\.\d+)\(dbm\)")
    return rx, tx


# Linha volátil do 'show running-config' (muda a cada dump sem a config mudar).
_VOLATILE_CONFIG = re.compile(r"(?mi)^\s*(timestamp_write|Building configuration|olleh)\b.*\n?")


def clean_running_config(text: str) -> str:
    """Normaliza o running-config para comparação/backup: remove linhas voláteis (timestamp, cabeçalho)."""
    return _VOLATILE_CONFIG.sub("", text)


class ZteOltDriver:
    simulated = False
    session_idle_s = 45
    poll_interval_s = 60

    def __init__(self, connect, *, allow_writes: bool = False, transport_note: str = "", transport_hygiene=()):
        self._connect = connect
        self.allow_writes = allow_writes
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
        connect = lambda: ZteCli(host, port, cred["username"], cred["password"], cred)  # noqa: E731
        return cls(connect, allow_writes=False, transport_note=note(cred), transport_hygiene=hygiene(cred))

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

    # --- contrato do driver ---
    def check(self) -> dict:
        import time
        if self._check_cache and time.time() - self._check_cache[0] < self.poll_interval_s:
            return self._check_cache[1]
        out = self._session().run("show card")
        check_failure(out)
        cards = parse_card(out)
        # Placas de acesso PON (G)PON/XGSPON começam por "G" (GTGx/GFGx/GFCx...); controle/força/ventilação usam
        # outros prefixos (PR, SC, SF, FC). Heurística validada no NOBRE (XGSPON) e no laboratório C300.
        pon = [c for c in cards if (c["cfg_type"] or "").upper().startswith("G")]
        detail = f"ZTE ZXA10 — {len(cards)} placa(s), {len(pon)} PON — driver não homologado em equipamento real"
        if self.transport_note:
            detail += f"; {self.transport_note}"
        result = {"ok": True, "product": "ZTE ZXA10", "firmware": None, "homologated": False, "detail": detail}
        if self.transport_hygiene:
            result["hygiene"] = list(self.transport_hygiene)
        self._check_cache = (time.time(), result)
        return result

    def export_config(self) -> str:
        """Backup da configuração: 'show running-config' numa sessão própria (não disputa a das operações)."""
        cli = self._connect()
        try:
            out = cli.dump("show running-config")
        finally:
            cli.close()
        check_failure(out)
        text = clean_running_config(out)
        if "add-card" not in text and "interface" not in text:
            raise ZteCommandError("resposta sem configuração reconhecível; backup não registrado")
        return text

    def discover(self) -> list[dict]:
        out = self._session().run("show gpon onu uncfg")
        check_failure(out)
        return parse_uncfg(out)

    def _index_by_sn(self, s, serial: str) -> Optional[str]:
        out = s.run(f"show gpon onu by-sn {serial}")
        if re.search(r"No related information|%Error", out, re.I):
            return None
        m = re.search(r"(\d+/\d+/\d+:\d+)", out)
        return m.group(1) if m else None

    def _read_index(self, s, index: str) -> OnuState:
        norm = normalize_index(index)
        raw = prefix = None
        for pfx in _IFACE_PREFIXES:
            out = s.run(f"show gpon onu detail-info {pfx}{norm}")
            if re.search(r"Invalid input|Incomplete command", out, re.I):
                continue  # este firmware não aceita esse formato de interface; tenta o outro
            raw, prefix = out, pfx
            break
        if raw is None or re.search(r"No related information|does not exist|%Error", raw, re.I):
            return OnuState(authorized=False)
        info = parse_onu_detail(raw)
        if not info:
            raise ZteCommandError("resposta ONT incompleta; estado desconhecido")
        iface = prefix + norm
        rx_raw = s.run(f"show pon power onu-rx {iface}")
        att_raw = s.run(f"show pon power attenuation {iface}")
        rx, tx = parse_power(rx_raw, att_raw)
        return OnuState(authorized=True, pon_port=info["index"].split(":")[0], description=info.get("description"),
                        online=info["phase_state"] == "working", rx_dbm=rx, tx_dbm=tx,
                        extra={"serial": info["serial"], "type": info.get("type"), "config_state": info.get("config_state"),
                               "distance_m": info.get("distance_m"), "index": info["index"]})

    def read_onu(self, serial_or_index: str) -> OnuState:
        s = self._session()
        index = serial_or_index if re.search(r"\d+/\d+/\d+:\d+", serial_or_index) else self._index_by_sn(s, serial_or_index)
        if not index:
            return OnuState(authorized=False)
        return self._read_index(s, index)

    def read_onus(self, serials: list[str]) -> dict[str, OnuState]:
        out = {}
        s = self._session()
        for sn in serials:
            try:
                out[sn] = self.read_onu(sn)
            except ZteCommandError:
                continue
        return out

    def _no_writes(self, *_a, **_k):
        raise ZteCommandError("provisionamento de ONU ZTE não homologado neste agente (apenas leitura e backup)")

    authorize = deauthorize = _no_writes


class ZteCli:
    """Sessão CLI ZTE pelo cli_transport do agente. Paginação desligada no prelúdio; `dump` lê saídas longas
    (running-config) usando o prompt real como terminador."""

    def __init__(self, host: str, port: int, username: str, password: str, cred: dict):
        from ..cli_transport import connect
        self._c = connect("zte_zxros", host, port, username, password, cred,
                          conn_timeout=20, auth_timeout=20, banner_timeout=20)
        try:
            self._c.send_command("terminal length 0", expect_string=r"[>#]\s*$", read_timeout=15, cmd_verify=False)
        except Exception:
            pass

    def run(self, command: str) -> str:
        # cmd_verify=True: sincroniza pelo eco do comando; sem isso o netmiko casa o prompt que sobrou do comando
        # anterior e devolve vazio (ex.: `show card` voltando 0 placas).
        return self._c.send_command(command, expect_string=r"[>#]\s*$", read_timeout=60, cmd_verify=True,
                                    strip_prompt=False, strip_command=True)

    def dump(self, command: str) -> str:
        try:
            self._c.disable_paging(command="terminal length 0")
        except Exception:
            pass
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
