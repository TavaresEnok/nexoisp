"""EMULADOR de laboratório de OLT VSOL GPON (família BDCOM; NÃO é software da VSOL; NÃO é homologação).

A única leitura de ONU que a CLI VSOL oferece é o running-config; aqui ele sai no MESMO formato capturado na OLT real
(TC+ Itapissuma, 2026-11-12): `interface gpon 0/N` / `onu add N profile P sn SN` / `onu N tcont 1 dba D` /
`onu N gemport 1 tcont 1 gemport_name gem_1 portid X` / `onu N service srv_1 gemport 1 vlan V` /
`onu N service-port 1 gemport 1 uservlan U vlan V` / `onu N portvlan eth 1 mode tag vlan V`. Assim, a ONU que a
escrita cria tem que ser reconhecida pelo parser validado em campo. A escrita valida perfil, DBA, VLAN, serial e ID.
"""
import re

from .lab_cli_server import LabCli

UNKNOWN = "% Unknown command."


class VsolState:
    def __init__(self):
        self.ports = ["0/1", "0/2", "0/3", "0/4"]
        self.profiles = {"default", "p100M"}
        self.dbas = {"dba_100M", "dba_1G"}
        self.vlans = {100, 2301}
        # ONU 1 da PON 0/1 é de outro cliente.
        self.onus = {("0/1", 1): {"sn": "VSOL00000001", "lp": "default", "dba": "dba_100M", "gem": True, "svc": 2301,
                                  "sp": (2301, 2301), "pv": 2301, "desc": "outro-cliente"}}
        self.next_portid = 145


class VsolCli(LabCli):
    def __init__(self, state: VsolState):
        super().__init__()
        self.s = state
        self.mode, self.cur = "user", None

    def on_login(self):
        self.mode = "user"

    def on_enable(self):
        self.mode = "enable"

    def prompt(self) -> str:
        return "VSOL-LAB" + {"user": ">", "enable": "#", "config": "(config)#", "if": f"(config-if-gpon-{self.cur})#"}[self.mode]

    def label(self, cmd: str) -> str:
        return "<logout>" if cmd in ("exit", "quit", "logout") and self.mode in ("user", "enable") else cmd

    def _running(self) -> str:
        s = self.s
        lines = ["!", "hostname VSOL-LAB", "!"] + [f"vlan {v}" for v in sorted(s.vlans)] + ["!"]
        for p in s.ports:
            lines += [f"interface gpon {p}", "no onu auto-learn"]
            for (pp, n), o in sorted(s.onus.items()):
                if pp != p:
                    continue
                lines.append(f"onu add {n} profile {o['lp']} sn {o['sn']}")
                if o.get("dba"):
                    lines.append(f"onu {n} tcont 1 dba {o['dba']}")
                if o.get("gem"):
                    lines.append(f"onu {n} gemport 1 tcont 1 gemport_name gem_1 portid {o.setdefault('portid', 145 + n)}")
                if o.get("svc"):
                    lines.append(f"onu {n} service srv_1 gemport 1 vlan {o['svc']}")
                if o.get("sp"):
                    lines.append(f"onu {n} service-port 1 gemport 1 uservlan {o['sp'][0]} vlan {o['sp'][1]}")
                if o.get("pv"):
                    lines.append(f"onu {n} portvlan eth 1 mode tag vlan {o['pv']}")
                if o.get("desc"):
                    lines.append(f"onu {n} desc {o['desc']}")
            lines.append("!")
        lines += ["interface gigabitethernet 0/1", " description uplink", "!", "end"]
        return "\n".join(lines)

    def execute(self, c: str):
        s = self.s
        c = re.sub(r"\s+", " ", c.strip())
        if c == "terminal length 0":
            return ""
        if c in ("exit", "quit", "logout") and self.mode in ("user", "enable"):
            return ""  # logout: o cliente fecha a conexão
        if self.mode == "user":
            return self.enable() if c == "enable" else UNKNOWN
        if self.mode == "enable":
            if c == "show version":
                return "Product : V1600G1 (emulado)\nVersion : V2.1.6R (emulador NexoISP)"
            if c == "show running-config":
                return self._running()
            if c == "configure terminal":
                self.mode = "config"
                return ""
            return UNKNOWN
        if c == "exit":
            self.mode = {"if": "config", "config": "enable"}[self.mode]
            return ""
        if c == "end":
            self.mode = "enable"
            return ""
        if self.mode == "config":
            m = re.fullmatch(r"interface gpon (\d+/\d+)", c)
            if m and m.group(1) in s.ports:
                self.mode, self.cur = "if", m.group(1)
                return ""
            return UNKNOWN
        # modo interface gpon
        m = re.fullmatch(r"onu add (\d+) profile (\S+) sn (\S+)", c)
        if m:
            n, lp, sn = int(m.group(1)), m.group(2), m.group(3).upper()
            if not 1 <= n <= 128:
                return "% Error: onu id out of range"
            if lp not in s.profiles:
                return f"% Error: profile {lp} does not exist"
            if any(o["sn"] == sn for o in s.onus.values()):
                return f"% Error: sn {sn} already exists"
            if (self.cur, n) in s.onus:
                return f"% Error: onu {n} already exists"
            s.onus[(self.cur, n)] = {"sn": sn, "lp": lp}
            return ""
        m = re.fullmatch(r"onu delete (\d+)", c)
        if m:
            if s.onus.pop((self.cur, int(m.group(1))), None) is None:
                return f"% Error: onu {m.group(1)} does not exist"
            return ""
        m = re.fullmatch(r"onu (\d+) (.+)", c)
        if not m:
            return UNKNOWN
        o = s.onus.get((self.cur, int(m.group(1))))
        if o is None:
            return f"% Error: onu {m.group(1)} does not exist"
        rest = m.group(2)
        if mm := re.fullmatch(r"tcont 1 dba (\S+)", rest):
            if mm.group(1) not in s.dbas:
                return f"% Error: dba profile {mm.group(1)} does not exist"
            o["dba"] = mm.group(1)
            return ""
        if rest == "gemport 1 tcont 1 gemport_name gem_1":
            if not o.get("dba"):
                return "% Error: tcont 1 is not configured"
            o["gem"] = True
            return ""
        if mm := re.fullmatch(r"service srv_1 gemport 1 vlan (\d+)", rest):
            if int(mm.group(1)) not in s.vlans:
                return f"% Error: vlan {mm.group(1)} does not exist"
            if not o.get("gem"):
                return "% Error: gemport 1 is not configured"
            o["svc"] = int(mm.group(1))
            return ""
        if mm := re.fullmatch(r"service-port 1 gemport 1 uservlan (\d+) vlan (\d+)", rest):
            if int(mm.group(2)) not in s.vlans:
                return f"% Error: vlan {mm.group(2)} does not exist"
            o["sp"] = (int(mm.group(1)), int(mm.group(2)))
            return ""
        if mm := re.fullmatch(r"portvlan eth 1 mode tag vlan (\d+)", rest):
            o["pv"] = int(mm.group(1))
            return ""
        if mm := re.fullmatch(r"desc (\S+)", rest):
            o["desc"] = mm.group(1)
            return ""
        return UNKNOWN
