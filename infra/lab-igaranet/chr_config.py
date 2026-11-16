#!/usr/bin/env python3
"""Configura o concentrador IGARA-BRAS (MikroTik CHR 7.17 do PNETLab) pelo console telnet.

- ether1: gerência na nuvem NAT do PNETLab (10.0.137.2/24) — por ela sai o túnel WireGuard até o NexoISP;
- túnel + RADIUS: exatamente os comandos que o painel do NexoISP gerou para este concentrador (provisionar.py base);
- ether2: servidor PPPoE para os clientes que chegam pela OLT.
Reaplicável: remove antes o que este script criou (comentário "igaranet") e o que o NexoISP gerou (comentário "nexoisp").
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lab-pnetlab"))
from ros_console import Con  # noqa: E402

ESTADO = Path.home() / ".local/share/nexoisp/igaranet/estado.json"
PORTA = int(sys.argv[1]) if len(sys.argv) > 1 else 30181


def main():
    st = json.loads(ESTADO.read_text())
    cmds = st["tunel"]["setup"]["commands"].replace("<SEGREDO>", st["nas_secret"])
    nexo = [c.strip() for c in cmds.splitlines() if c.strip() and not c.strip().startswith("#")]
    limpeza = [
        "/ip firewall filter remove [find comment~\"nexoisp\"]",
        "/radius remove [find comment=nexoisp]",
        "/ip address remove [find comment=nexoisp]",
        "/interface wireguard peers remove [find comment=nexoisp]",
        "/interface wireguard remove [find comment=nexoisp]",
        "/interface pppoe-server server remove [find service-name=igaranet]",
        "/ppp profile remove [find name=igaranet]",
        "/ip pool remove [find name=igaranet-clientes]",
        "/ip firewall nat remove [find comment=igaranet]",
        "/ip route remove [find comment=igaranet]",
        "/ip address remove [find comment=igaranet]",
    ]
    base = [
        "/system identity set name=IGARA-BRAS",
        "/system clock set time-zone-name=America/Recife",
        "/ip address add address=10.0.137.2/24 interface=ether1 comment=igaranet",
        "/ip route add dst-address=0.0.0.0/0 gateway=10.0.137.254 comment=igaranet",
        "/ip dns set servers=8.8.8.8",
    ]
    pppoe = [
        "/ip pool add name=igaranet-clientes ranges=100.64.10.2-100.64.10.254",
        "/ppp profile add name=igaranet local-address=100.64.10.1 remote-address=igaranet-clientes dns-server=8.8.8.8 only-one=yes",
        "/interface pppoe-server server add service-name=igaranet interface=ether2 default-profile=igaranet "
        "authentication=pap,chap,mschap2 one-session-per-host=yes keepalive-timeout=10 max-mtu=1480 max-mru=1480 disabled=no",
        "/ip firewall nat add chain=srcnat src-address=100.64.10.0/24 out-interface=ether1 action=masquerade comment=igaranet",
    ]
    c = Con(PORTA)
    if not c.login(180):
        raise SystemExit("console do CHR não respondeu")
    for cmd in limpeza + base + nexo + pppoe:
        out = c.cmd(cmd)
        bad = [ln for ln in out.splitlines() if "failure" in ln.lower() or "syntax error" in ln.lower() or "bad command" in ln.lower()]
        shown = cmd if "secret=" not in cmd and "private-key" not in cmd else cmd.split(" secret=")[0].split(" private-key")[0] + " …"
        print(("ERRO  " if bad else "ok    ") + shown + ("  -> " + bad[0].strip() if bad else ""))
    print(c.cmd("/interface wireguard peers print terse", 10))
    print(c.cmd("/ping 10.250.0.1 count=3", 15))


if __name__ == "__main__":
    main()
