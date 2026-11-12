"""EMULADOR de laboratório de OLT ZTE ZXA10 (NÃO é software da ZTE; passar aqui NÃO é homologação).

As LEITURAS saem no formato capturado em OLT ZTE real (NOBRE/Vibe, XGSPON, 2026-11-12: `show card`, `show gpon onu
state`, `detail-info`, `show pon power ...`) ou, no estilo C300, no formato do reconhecimento de campo. Assim, o que a
escrita produz no emulador precisa ser reconhecido pelos MESMOS parsers validados no equipamento real.

Estilos: "xgspon" (interface gpon_olt-/gpon_onu-) e "c300" (gpon-olt_/gpon-onu_) — o token de interface é a principal
diferença de firmware encontrada em campo. A escrita valida tipo de ONU, perfil de T-CONT, VLAN, unicidade de SN e
faixa de ID, como o equipamento faria.
"""
import re

from .lab_cli_server import LabCli

INVALID = "                    ^\n%Error 140303: Invalid input detected at '^' marker."
NO_INFO = "%Code 62310-GPONSRV : No related information to show."


class ZteState:
    def __init__(self, style: str = "xgspon"):
        self.style = style
        self.olt_pfx, self.onu_pfx = ("gpon_olt-", "gpon_onu-") if style == "xgspon" else ("gpon-olt_", "gpon-onu_")
        self.ports = [f"1/1/{p}" for p in range(1, 9)]
        self.types = {"ZTE-F660", "ZTE-F601", "ZTE-ONT"}
        self.tconts = {"T1-100M", "T1-1G"}
        self.vlans = {100, 200, 1851}
        # Uma ONU de outro cliente já ocupa o ID 1 em 1/1/1 (o ID livre tem que ser escolhido de verdade).
        self.onus = {"1/1/1:1": {"sn": "ZTEG00000001", "type": "ZTE-F601", "desc": "outro-cliente", "tcont": "T1-100M",
                                 "gem": True, "sp": (100, 100), "svc": 100, "vport": 100}}
        self.uncfg = [("1/1/1", "ZTE-F660", "ZTEGC0FFEE01"), ("1/1/2", "ZTE-F601", "ZTEGC0FFEE02")]
        self.offline = set()


class ZteCli(LabCli):
    def __init__(self, state: ZteState):
        super().__init__()
        self.s = state
        self.mode, self.cur_port, self.cur_onu = "exec", None, None

    def prompt(self) -> str:
        return "ZXAN-LAB" + {"exec": "#", "config": "(config)#", "if-olt": "(config-if)#", "if-onu": "(config-if)#",
                             "mng": "(gpon-onu-mng)#"}[self.mode]

    # --- leituras (formato real) ----------------------------------------------------------------------------------
    def _card(self):
        if self.s.style == "xgspon":
            return ("Shelf Slot CfgType CardName     Port HardVer Status\n" + "-" * 51 + "\n"
                    "1     1    GFGH    GFGH         16   V1.0.0  INSERVICE\n"
                    "1     10   SFUB    C01SFUB      4    V1.0.0  INSERVICE\n"
                    "1     18   PRVR    PRVR         0    V1.0.0  INSERVICE")
        return ("Rack Shelf Slot CfgType RealType Port  HardVer SoftVer         Status\n" + "-" * 79 + "\n"
                "1    1     1    GTGH    GTGHK    16    V1.0.0  V2.1.0          INSERVICE\n"
                "1    1     11   SCXNT   SCXNT00  5     V1.0.0  V2.1.0          INSERVICE")

    def _state(self):
        rows = []
        for idx in sorted(self.s.onus, key=lambda i: (i.split(":")[0], int(i.split(":")[1]))):
            on = self.s.onus[idx]["sn"] not in self.s.offline
            if self.s.style == "xgspon":
                rows.append(f"{idx:<13} enable       {'enable ' if on else 'disable'}     {'working' if on else 'OffLine'}      {'GPON' if on else 'N/A'}")
            else:
                rows.append(f"{idx:<11} enable       {'enable ' if on else 'disable'}     {'working' if on else 'OffLine'}      1(GPON)")
        head = ("OnuIndex     Admin state  OMCC state  Phase state  Speed mode " if self.s.style == "xgspon"
                else "OnuIndex   Admin State  OMCC State  Phase State  Channel")
        return head + "\n" + "-" * 63 + "\n" + "\n".join(rows)

    def _detail(self, idx):
        o = self.s.onus[idx]
        on = o["sn"] not in self.s.offline
        return (f"\nONU interface:          {self.s.onu_pfx}{idx}\n  Name:                 ONU-{idx}\n  Type:                 {o['type']}\n"
                f"  Admin state:          enable\n  Phase state:          {'working' if on else 'OffLine'}\n"
                f"  Config state:         {'success' if o.get('sp') else 'warning'}\n  Authentication mode:  sn\n"
                f"  Serial number:        {o['sn']}\n  Description:          {o.get('desc') or ''}\n"
                f"  ONU Distance:         {1000 + int(idx.split(':')[1]) * 31}m\n")

    def _rx(self, idx):
        return round(-18.5 - int(idx.split(":")[1]) * 0.37, 3)

    def _onu_from(self, arg):
        m = re.fullmatch(re.escape(self.s.onu_pfx) + r"(\d+/\d+/\d+:\d+)", arg)
        return m.group(1) if m else None

    # --- execução -------------------------------------------------------------------------------------------------
    def execute(self, c: str):
        s = self.s
        c = re.sub(r"\s+", " ", c.strip())
        if c.startswith("terminal "):
            return ""
        if c == "show version":
            return ("Product : ZXA10 C600 (emulado)\nVersion : V1.2.1 (emulador NexoISP)" if s.style == "xgspon"
                    else "Product : ZXA10 C300 (emulado)\nVersion : V2.1.0 (emulador NexoISP)")
        if c == "show card":
            return self._card()
        if c == "show gpon onu state":
            return self._state()
        if c == "show gpon onu uncfg":
            if not s.uncfg:
                return NO_INFO
            return "OnuIndex            Model          SN             State\n" + "\n".join(
                f"{s.olt_pfx}{p:<12} {t:<14} {sn:<14} unknown" for p, t, sn in s.uncfg)
        m = re.fullmatch(r"show gpon onu by-sn (\S+)", c)
        if m:
            idx = next((i for i, o in s.onus.items() if o["sn"] == m.group(1).upper()), None)
            return f"  search result: {s.onu_pfx}{idx}" if idx else NO_INFO
        m = re.fullmatch(r"show gpon onu detail-info (\S+)", c)
        if m:
            idx = self._onu_from(m.group(1))
            if idx is None:
                return INVALID
            return self._detail(idx) if idx in s.onus else NO_INFO
        m = re.fullmatch(r"show pon power (onu-rx|attenuation) (\S+)", c)
        if m:
            idx = self._onu_from(m.group(2))
            if idx is None:
                return INVALID
            if idx not in s.onus or s.onus[idx]["sn"] in s.offline:
                return NO_INFO
            rx = self._rx(idx)
            if m.group(1) == "onu-rx":
                return f"Onu                  Rx power   \n{'-' * 36}\n{s.onu_pfx}{idx:<10} {rx:.3f}(dbm)"
            return (f"           OLT                  ONU              Attenuation\n{'-' * 74}\n"
                    f" up      Rx :{rx - 0.4:.3f}(dbm)      Tx:2.875(dbm)        34.887(dB)     \n \n"
                    f" down    Tx :5.612(dbm)        Rx:{rx:.3f}(dbm)      37.162(dB)     ")
        if c == "show running-config":
            lines = ["Building configuration...", "!"]
            for p in s.ports:
                onus = [(i, o) for i, o in s.onus.items() if i.split(":")[0] == p]
                if onus:
                    lines += [f"interface {s.olt_pfx}{p}"] + [f"  onu {i.split(':')[1]} type {o['type']} sn {o['sn']}" for i, o in onus] + ["!"]
            return "\n".join(lines + ["end"])
        if c == "configure terminal" and self.mode == "exec":
            self.mode = "config"
            return ""
        if c == "end":
            self.mode, self.cur_port, self.cur_onu = "exec", None, None
            return ""
        if c == "exit":
            self.mode = {"if-olt": "config", "if-onu": "config", "mng": "config", "config": "exec"}.get(self.mode, "exec")
            if self.mode != "if-olt":
                self.cur_port = None
            return ""
        if self.mode == "config":
            m = re.fullmatch(r"interface (\S+)", c)
            if m:
                arg = m.group(1)
                if arg.startswith(s.olt_pfx) and arg[len(s.olt_pfx):] in s.ports:
                    self.mode, self.cur_port = "if-olt", arg[len(s.olt_pfx):]
                    return ""
                idx = self._onu_from(arg)
                if idx and idx in s.onus:
                    self.mode, self.cur_onu = "if-onu", idx
                    return ""
                return INVALID
            m = re.fullmatch(r"pon-onu-mng (\S+)", c)
            if m:
                idx = self._onu_from(m.group(1))
                if idx and idx in s.onus:
                    self.mode, self.cur_onu = "mng", idx
                    return ""
                return INVALID
        if self.mode == "if-olt":
            m = re.fullmatch(r"onu (\d+) type (\S+) sn (\S+)", c)
            if m:
                oid, typ, sn = int(m.group(1)), m.group(2), m.group(3).upper()
                idx = f"{self.cur_port}:{oid}"
                if not 1 <= oid <= 128:
                    return "%Code 32000-GPONSRV : The ONU ID is out of range."
                if typ not in s.types:
                    return "%Code 62311-GPONSRV : The ONU type does not exist."
                if any(o["sn"] == sn for o in s.onus.values()):
                    return "%Code 62305-GPONSRV : The SN already exists."
                if idx in s.onus:
                    return "%Code 62304-GPONSRV : The ONU already exists."
                s.onus[idx] = {"sn": sn, "type": typ, "desc": "", "tcont": None, "gem": False, "sp": None, "svc": None, "vport": None}
                s.uncfg = [u for u in s.uncfg if u[2] != sn]
                return ""
            m = re.fullmatch(r"no onu (\d+)", c)
            if m:
                idx = f"{self.cur_port}:{m.group(1)}"
                o = s.onus.pop(idx, None)
                if o is None:
                    return "%Code 62302-GPONSRV : The ONU does not exist."
                if o["sn"] not in s.offline:
                    s.uncfg.append((self.cur_port, o["type"], o["sn"]))  # a ONU continua ligada: volta ao uncfg
                return ""
        if self.mode == "if-onu":
            o = s.onus[self.cur_onu]
            m = re.fullmatch(r"(?:description|name) (\S+)", c)
            if m:
                if c.startswith("description"):
                    o["desc"] = m.group(1)
                return ""
            m = re.fullmatch(r"tcont 1 profile (\S+)", c)
            if m:
                if m.group(1) not in s.tconts:
                    return "%Code 61002-GPONSRV : The T-CONT profile does not exist."
                o["tcont"] = m.group(1)
                return ""
            if c == "gemport 1 tcont 1":
                if not o["tcont"]:
                    return "%Code 61010-GPONSRV : The T-CONT is not configured."
                o["gem"] = True
                return ""
            m = re.fullmatch(r"service-port 1 vport 1 user-vlan (\d+) vlan (\d+)", c)
            if m:
                if int(m.group(2)) not in s.vlans:
                    return "%Code 40035-SRVCOMM : The VLAN does not exist."
                if not o["gem"]:
                    return "%Code 61011-GPONSRV : The GEM port is not configured."
                o["sp"] = (int(m.group(1)), int(m.group(2)))
                return ""
        if self.mode == "mng":
            o = s.onus[self.cur_onu]
            m = re.fullmatch(r"service internet gemport 1 vlan (\d+)", c)
            if m:
                o["svc"] = int(m.group(1))
                return ""
            m = re.fullmatch(r"vlan port eth_0/1 mode tag vlan (\d+)", c)
            if m:
                o["vport"] = int(m.group(1))
                return ""
        return INVALID
