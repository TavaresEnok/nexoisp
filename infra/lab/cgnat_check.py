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
api = connect(host="lab-chr", username="nexo-agent", password=os.environ["P"], port=8729, timeout=15,
              ssl_wrapper=lambda s: ctx.wrap_socket(s, server_hostname="lab-chr"))
nat = api.path("ip", "firewall", "nat")
mode = sys.argv[1]

if mode == "apply":
    section, added = None, 0
    for line in open(sys.argv[2], encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("/"):
            section = line
            continue
        if section != "/ip firewall nat" or not line.startswith("add "):
            raise SystemExit(f"linha inesperada no script: {line!r}")
        nat.add(**dict(p.split("=", 1) for p in shlex.split(line[4:])))
        added += 1
    print(json.dumps({"rules_added": added}))
elif mode == "conns":
    for r in api.path("ip", "firewall", "connection"):   # só os fluxos de teste desta execução (porta de destino única)
        if r.get("dst-address") == "198.18.0.1" and str(r.get("dst-port")) == sys.argv[2]:
            print(json.dumps({k: r.get(k) for k in ("protocol", "src-address", "src-port", "reply-dst-address", "reply-dst-port", "srcnat")}, default=str))
elif mode == "remove":
    ids = [r[".id"] for r in nat if sys.argv[2] in str(r.get("comment", ""))]
    for i in ids:
        nat.remove(i)
    print(json.dumps({"rules_removed": len(ids)}))
api.close()
