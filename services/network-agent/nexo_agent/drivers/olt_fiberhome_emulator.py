"""EMULADOR de laboratório de OLT FiberHome AN5516 (NÃO é software da FiberHome; NÃO é homologação).

LEITURAS no formato capturado em AN5516 real (Cyber Net, 2026-11-12): tabela `show authorization slot all pon all`
(Slot Pon Onu OnuType ST Lic OST PhyId ...) e `show onu opticalpower-info phy-id <SN>` (SEND/RECV POWER). Login
"Login:"/"Password:", prompt "User>", `enable` com senha -> "Admin#", árvore `cd onu` / `cd lan` / `cd ..`.

Escrita: whitelist `set whitelist phy_addr address <SN> password null action add|delete slot S pon P onu N type T` e
VLAN em `lan` (`set epon ... service number 1`, `... service 1 vlan_mode tag 0 33024 <V>`, `apply onu S P N vlan`).
Valida tipo de ONU, serial, ID, PON e VLAN.
"""
import re

from .lab_cli_server import LabCli

UNKNOWN = "% Unknown command."


class FiberHomeState:
    def __init__(self):
        self.pons = {(1, 1), (1, 2), (7, 1)}
        self.types = {"5506-01-A1", "HG6143D"}
        self.vlans = {100, 1001}
        # ONU 1 da PON 1/1 é de outro cliente.
        self.auth = {"FHTT00000001": {"slot": 1, "pon": 1, "onu": 1, "type": "5506-01-A1", "vlan": 1001, "applied": True}}
        self.discovery = [(1, 1, "FHTTC0FFEE01", "5506-01-A1")]
        self.offline = set()


class FiberHomeCli(LabCli):
    user_prompt = "Login:"
    enable_password = "emu-lab"

    def __init__(self, state: FiberHomeState):
        super().__init__()
        self.s = state
        self.admin, self.path = False, []

    def on_enable(self):
        self.admin = True

    def prompt(self) -> str:
        return ("Admin" + "".join("\\" + p for p in self.path) + "#") if self.admin else "User>"

    def label(self, cmd: str) -> str:
        return "<logout>" if cmd in ("exit", "quit", "logout") and not self.path else cmd

    def _table(self, rows, discovery=False):
        out = []
        for (slot, pon) in sorted(self.s.pons):
            items = [r for r in rows if (r[0], r[1]) == (slot, pon)]
            if not items:
                continue
            out.append(f"-----  ONU {'Discovery' if discovery else 'Auth'} Table, SLOT = {slot}, PON = {pon}, ITEM = {len(items)} -----")
            out.append("Slot Pon Onu OnuType        ST Lic OST PhyId        PhyPwd     LogicId")
            out.append("---- --- --- -------------- -- --- --- ------------ ---------- -------")
            for slot_, pon_, onu, typ, st, ost, sn in items:
                out.append(f"{slot_:<4} {pon_:<3} {onu:<3} {typ:<14} {st}  1   {ost:<3} {sn:<12} null")
        return "\n".join(out)

    def execute(self, c: str):
        s = self.s
        c = re.sub(r"\s+", " ", c.strip())
        if c in ("exit", "quit", "logout") and not self.path:
            return ""
        if not self.admin:
            return self.enable() if c == "enable" else UNKNOWN
        if c == "show version":
            return "Product : AN5516-06 (emulado)\nVersion : RP1000 (emulador NexoISP)"
        if c == "cd ..":
            if self.path:
                self.path.pop()
            return ""
        if c == "cd onu" and not self.path:
            self.path = ["onu"]
            return ""
        if c == "cd lan" and self.path == ["onu"]:
            self.path = ["onu", "lan"]
            return ""
        if self.path == ["onu"]:
            if c == "show authorization slot all pon all":
                rows = [(o["slot"], o["pon"], o["onu"], o["type"], "A", "dn" if sn in s.offline else "up", sn) for sn, o in s.auth.items()]
                return self._table(sorted(rows))
            if c == "show authorization discovery slot all pon all":
                return self._table([(sl, p, i, t, "P", "up", sn) for i, (sl, p, sn, t) in enumerate(s.discovery, 1)], discovery=True)
            m = re.fullmatch(r"show onu opticalpower-info phy-id (\S+)", c)
            if m:
                o = s.auth.get(m.group(1).upper())
                if not o or m.group(1).upper() in s.offline:
                    return " onu not exist or offline."
                rx = -16.65 - o["onu"] * 0.3
                return (f"\n onu ({o['slot']}/{o['pon']}/{o['onu']}).\n-----  ONU OPTICAL INFO {o['slot']}.{o['pon']}.{o['onu']}-----\n"
                        f"SEND POWER   :  2.58\t(Dbm)\nRECV POWER   : {rx:.2f}\t(Dbm)")
            m = re.fullmatch(r"set whitelist phy_addr address (\S+) password null action (add|delete) slot (\d+) pon (\d+) onu (\d+) type (\S+)", c)
            if m:
                sn, act, slot, pon, onu, typ = m.group(1).upper(), m.group(2), int(m.group(3)), int(m.group(4)), int(m.group(5)), m.group(6)
                if (slot, pon) not in s.pons:
                    return "% Error: slot/pon does not exist."
                if act == "add":
                    if typ not in s.types:
                        return f"% Error: onu type {typ} is not supported."
                    if sn in s.auth:
                        return "% Error: the phy address already exists in whitelist."
                    if not 1 <= onu <= 128 or any((o["slot"], o["pon"], o["onu"]) == (slot, pon, onu) for o in s.auth.values()):
                        return "% Error: the onu number is invalid or in use."
                    s.auth[sn] = {"slot": slot, "pon": pon, "onu": onu, "type": typ, "vlan": None, "applied": False}
                    s.discovery = [d for d in s.discovery if d[2] != sn]
                    return ""
                o = s.auth.get(sn)
                if not o or (o["slot"], o["pon"], o["onu"], o["type"]) != (slot, pon, onu, typ):
                    return "% Error: the phy address does not exist in whitelist."
                del s.auth[sn]
                if sn not in s.offline:
                    s.discovery.append((slot, pon, sn, typ))
                return ""
        if self.path == ["onu", "lan"]:
            def onu_at(slot, pon, n):
                return next((o for o in s.auth.values() if (o["slot"], o["pon"], o["onu"]) == (slot, pon, n)), None)
            m = re.fullmatch(r"set epon slot (\d+) pon (\d+) onu (\d+) port 1 service number 1", c)
            if m:
                o = onu_at(*map(int, m.groups()))
                if not o:
                    return "% Error: onu is not authorized."
                o["svc"] = 1
                return ""
            m = re.fullmatch(r"set epon slot (\d+) pon (\d+) onu (\d+) port 1 service 1 vlan_mode tag 0 33024 (\d+)", c)
            if m:
                o = onu_at(int(m.group(1)), int(m.group(2)), int(m.group(3)))
                if not o or not o.get("svc"):
                    return "% Error: service number is not configured."
                if int(m.group(4)) not in s.vlans:
                    return f"% Error: vlan {m.group(4)} does not exist."
                o["vlan"] = int(m.group(4))
                return ""
            m = re.fullmatch(r"apply onu (\d+) (\d+) (\d+) vlan", c)
            if m:
                o = onu_at(*map(int, m.groups()))
                if not o or not o.get("vlan"):
                    return "% Error: nothing to apply."
                o["applied"] = True
                return ""
        return UNKNOWN
