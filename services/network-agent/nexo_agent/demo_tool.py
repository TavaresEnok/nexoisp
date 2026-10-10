"""Ferramenta do AMBIENTE DE DEMONSTRAÇÃO: injeta falhas e simula ações externas nos equipamentos simulados.
NAS:  python -m nexo_agent.demo_tool <device_id> lose-ack | fail | manual <usuario> <active|suspended> | writes <usuario>
OLT:  python -m nexo_agent.demo_tool <device_id> olt-plug <serial> <porta> | olt-unplug <serial> | olt-manual-remove <serial> | olt-lose-ack | olt-list"""
import os
import sys

from .drivers.demo import DemoDriver
from .drivers.olt_demo import DemoOltDriver


def main():
    dev, cmd, *rest = sys.argv[1:]
    data = os.environ.get("NEXO_AGENT_DATA", "./data")
    if cmd.startswith("olt-"):
        o = DemoOltDriver(os.path.join(data, "demo_olt.sqlite"), dev)
        if cmd == "olt-plug":
            o.plug(rest[0], rest[1])
        elif cmd == "olt-unplug":
            o.unplug(rest[0])
        elif cmd == "olt-manual-remove":
            o.manual_remove(rest[0])
        elif cmd == "olt-lose-ack":
            o.inject("lose_ack", 1)
        elif cmd == "olt-list":
            for u in o.discover():
                print("aguardando autorização:", u)
            return
        else:
            sys.exit(__doc__)
        print("ok")
        return
    d = DemoDriver(os.path.join(data, "demo_nas.sqlite"), dev)
    if cmd == "lose-ack":
        d.inject("lose_ack", 1)
    elif cmd == "fail":
        d.inject("fail_before_write", 1)
    elif cmd == "manual":
        d.manual_change(rest[0], rest[1])
    elif cmd == "writes":
        print(d.write_count(rest[0], "authorization"), "escrita(s) de autorização;", d.write_count(rest[0], "disconnect"), "desconexão(ões)")
        return
    else:
        sys.exit(__doc__)
    print("ok")


if __name__ == "__main__":
    main()
