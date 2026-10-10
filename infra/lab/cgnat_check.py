"""LABORATÓRIO: aplica no CHR as regras de um script de CGNAT gerado pelo NexoISP, lista as traduções ativas e remove tudo.
Uso (via lab.sh cgnat): cgnat_check.py apply <arquivo.rsc> | conns <porta de destino do teste> | remove <marcador>
O produto NÃO aplica CGNAT em equipamento: isto existe só para conferir, em RouterOS real, que as regras geradas são aceitas
e que a tradução observada é a calculada."""
import json
import os
import shlex
import ssl
import sys

from librouteros import connect

ctx = ssl.create_default_context(cafile="/c/routeros-ca.crt")
HOST = os.environ.get("H", "lab-chr")  # o laboratório do PNETLab (infra/lab-pnetlab) informa o endereço do concentrador
api = connect(host=HOST, username="nexo-agent", password=os.environ["P"], port=8729, timeout=15,
              ssl_wrapper=lambda s: ctx.wrap_socket(s, server_hostname=HOST))
nat = api.path("ip", "firewall", "nat")
mode = sys.argv[1]

if mode == "apply":
    section, added = None, 0
    # CGNAT_FIRST=1: o desvio entra ANTES das regras srcnat que o roteador já tem (a primeira regra que casa vence)
    first = next((r[".id"] for r in nat if r.get("chain") == "srcnat"), None) if os.environ.get("CGNAT_FIRST") else None
    for line in open(sys.argv[2], encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("/"):
            section = line
            continue
        if section != "/ip firewall nat" or not line.startswith("add "):
            raise SystemExit(f"linha inesperada no script: {line!r}")
        rule = dict(p.split("=", 1) for p in shlex.split(line[4:]))
        if first and rule.get("chain") == "srcnat":
            rule["place-before"] = first
        nat.add(**rule)
        added += 1
    print(json.dumps({"rules_added": added}))
elif mode == "conns":
    def split(r, k):  # o RouterOS 7.17 devolve "ip:porta" num campo só; versões que separam trazem <k>-address e <k>-port
        addr, port = str(r.get(f"{k}-address", "")), r.get(f"{k}-port")
        if port is None and ":" in addr:
            addr, port = addr.rsplit(":", 1)
        return addr, str(port)

    for r in api.path("ip", "firewall", "connection"):   # só os fluxos de teste desta execução (porta de destino única)
        dst, dport = split(r, "dst")
        if dst == "198.18.0.1" and dport == sys.argv[2]:
            (src, sport), (rdst, rport) = split(r, "src"), split(r, "reply-dst")
            print(json.dumps({"protocol": r.get("protocol"), "src-address": src, "src-port": sport, "reply-dst-address": rdst, "reply-dst-port": rport}))
elif mode == "remove":
    ids = [r[".id"] for r in nat if sys.argv[2] in str(r.get("comment", ""))]
    for i in ids:
        nat.remove(i)
    print(json.dumps({"rules_removed": len(ids)}))
api.close()
