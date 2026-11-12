"""EMULADOR de laboratório de OLT Datacom DmOS (NÃO é software da Datacom; passar aqui NÃO é homologação).

LEITURAS no formato capturado em DmOS real (AtivaTec, 2026-11-12): `show firmware`, `show interface gpon f/s/p onu`
(tabela com a coluna Name) e `... onu <id> optical-info`. O sufixo `| nomore` é aceito e removido, como no real.

Configuração TRANSACIONAL como o DmOS (ConfD): as mudanças vão para a configuração candidata; só o `commit` aplica, e é
nele que a validação acontece (perfil de linha inexistente, VLAN inexistente, ONU ainda referenciada por service-port,
serial duplicado -> "Aborted: ..."). `abort` descarta a candidata.
"""
import copy
import re

from .lab_cli_server import LabCli

SYNTAX = "-------------------------------------------^\nsyntax error: unknown argument"


class DatacomState:
    def __init__(self):
        self.firmware = "10.8.0-emulador"
        self.ports = ["1/1/1", "1/1/2", "1/1/3", "1/1/4"]
        self.line_profiles = {"ROUTER_701", "BRIDGE_100"}
        self.vlans = {100, 200, 2301}
        # Configuração em vigor. ONU 0 em 1/1/1 é de outro cliente (o ID livre tem que ser escolhido de verdade).
        self.cfg = {"onus": {("1/1/1", 0): {"sn": "DTCM00000001", "lp": "ROUTER_701", "name": "outro-cliente"}},
                    "sps": {1: ("1/1/1", 0, 1, 100, 100)}}
        self.offline = set()


class DatacomCli(LabCli):
    def __init__(self, state: DatacomState):
        super().__init__()
        self.s = state
        self.mode, self.cand, self.cur_port, self.cur_onu = "exec", None, None, None

    def prompt(self) -> str:
        return "DM4615-LAB" + {"exec": "#", "config": "(config)#", "if-gpon": f"(config-if-gpon-{self.cur_port})#",
                               "onu": f"(config-gpon-onu-{self.cur_port}/{self.cur_onu})#"}[self.mode]

    def _rx(self, port, oid):
        return round(-15.33 - int(port.split("/")[2]) * 0.4 - oid * 0.21, 2)

    def execute(self, c: str):
        s = self.s
        c = re.sub(r"\s+", " ", c.strip())
        if c.startswith("terminal "):
            return ""
        c = re.sub(r"\s*\|\s*nomore$", "", c)
        cfg = s.cfg
        if self.mode == "exec":
            if c == "show firmware":
                return f"Status: Idle\nDownload progress: -\n\nVersion                     State\n{'-' * 36}\n{s.firmware:<28}Active\n"
            m = re.fullmatch(r"show interface gpon (\d+/\d+/\d+) onu", c)
            if m:
                p = m.group(1)
                if p not in s.ports:
                    return SYNTAX
                rows = [f"{p:<10}{oid:<9}{o['sn']:<16}{('Down' if o['sn'] in s.offline else 'Up'):<13}{'None':<29}{o.get('name') or ''}"
                        for (pp, oid), o in sorted(cfg["onus"].items()) if pp == p]
                return ("  Itf     ONU ID   Serial Number   Oper State   Software Download State      Name\n"
                        "--------  ------   -------------   ----------   --------------------------   --------\n" + "\n".join(rows))
            m = re.fullmatch(r"show interface gpon (\d+/\d+/\d+) onu (\d+) optical-info", c)
            if m:
                key = (m.group(1), int(m.group(2)))
                o = cfg["onus"].get(key)
                if not o or o["sn"] in s.offline:
                    return " ID                    : %s\n Rx Optical Power [dBm]: -\n Tx Optical Power [dBm]: -" % key[1]
                return f" ID                    : {key[1]}\n Rx Optical Power [dBm]: {self._rx(*key):.2f}\n Tx Optical Power [dBm]: 2.90"
            if c == "show running-config service-port":
                return "\n".join(f"service-port {i} gpon {p} onu {o} gem {g} match vlan vlan-id {u} action vlan replace vlan-id {v}"
                                 for i, (p, o, g, u, v) in sorted(cfg["sps"].items()))
            if c == "show running-config":
                lines = ["hostname DM4615-LAB", "aaa user admin", "!"]
                for (p, oid), o in sorted(cfg["onus"].items()):
                    lines += [f"interface gpon {p}", f" onu {oid}", f"  serial-number {o['sn']}", f"  line-profile {o['lp']}",
                              f"  name {o.get('name') or ''}", " !", "!"]
                return "\n".join(lines + [self.execute("show running-config service-port")])
            if c == "config":
                self.mode, self.cand = "config", copy.deepcopy(cfg)
                return "Entering configuration mode terminal"
            return SYNTAX
        # --- modos de configuração (sobre a candidata) ---
        cand = self.cand
        if c == "commit":
            err = self._validate(cand)
            if err:
                return f"Aborted: {err}"
            s.cfg = copy.deepcopy(cand)
            return "Commit complete."
        if c == "abort":
            self.mode, self.cand = "exec", None
            return ""
        if c == "end":
            self.mode, self.cand = "exec", None
            return ""
        if c == "exit":
            self.mode = {"onu": "if-gpon", "if-gpon": "config", "config": "exec"}[self.mode]
            if self.mode == "exec":
                self.cand = None
            return ""
        if self.mode == "config":
            m = re.fullmatch(r"interface gpon (\d+/\d+/\d+)", c)
            if m and m.group(1) in s.ports:
                self.mode, self.cur_port = "if-gpon", m.group(1)
                return ""
            m = re.fullmatch(r"service-port (\d+) gpon (\d+/\d+/\d+) onu (\d+) gem (\d+) match vlan vlan-id (\d+) action vlan replace vlan-id (\d+)", c)
            if m:
                i = int(m.group(1))
                if i in cand["sps"]:
                    return f"Error: service-port {i} already exists"
                cand["sps"][i] = (m.group(2), int(m.group(3)), int(m.group(4)), int(m.group(5)), int(m.group(6)))
                return ""
            m = re.fullmatch(r"no service-port (\d+)", c)
            if m:
                if cand["sps"].pop(int(m.group(1)), None) is None:
                    return "Error: element does not exist"
                return ""
            return SYNTAX
        if self.mode == "if-gpon":
            m = re.fullmatch(r"onu (\d+)", c)
            if m and 0 <= int(m.group(1)) <= 127:
                self.mode, self.cur_onu = "onu", int(m.group(1))
                cand["onus"].setdefault((self.cur_port, self.cur_onu), {"sn": None, "lp": None, "name": None})
                return ""
            m = re.fullmatch(r"no onu (\d+)", c)
            if m:
                if cand["onus"].pop((self.cur_port, int(m.group(1))), None) is None:
                    return "Error: element does not exist"
                return ""
            return SYNTAX
        if self.mode == "onu":
            o = cand["onus"][(self.cur_port, self.cur_onu)]
            for key, field in (("serial-number", "sn"), ("line-profile", "lp"), ("name", "name")):
                m = re.fullmatch(rf"{key} (\S+)", c)
                if m:
                    o[field] = m.group(1).upper() if field == "sn" else m.group(1)
                    return ""
            return SYNTAX
        return SYNTAX

    def _validate(self, cand) -> str:
        seen = set()
        for (p, oid), o in cand["onus"].items():
            if not o.get("sn"):
                return f"illegal reference 'interface gpon {p} onu {oid} serial-number' (obrigatório)"
            if o["sn"] in seen:
                return f"serial-number {o['sn']} already in use"
            seen.add(o["sn"])
            if o.get("lp") not in self.s.line_profiles:
                return f"illegal reference 'interface gpon {p} onu {oid} line-profile {o.get('lp')}'"
        for i, (p, oid, _g, _u, v) in cand["sps"].items():
            if (p, oid) not in cand["onus"]:
                return f"illegal reference 'service-port {i} gpon {p} onu {oid}'"
            if v not in self.s.vlans:
                return f"illegal reference 'service-port {i} vlan-id {v}'"
        return ""
