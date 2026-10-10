"""LABORATÓRIO: configura um CHR recém-iniciado (admin sem senha) para o roteiro PPPoE do NexoISP.
Variáveis: CHR_HOST, RADIUS_HOST, RADIUS_NAS_SECRET, CHR_AGENT_PASSWORD, CHR_ADMIN_PASSWORD."""
import os
import socket
import time

from librouteros import connect

host = os.environ["CHR_HOST"]
from librouteros.exceptions import TrapError

for i in range(60):
    try:
        api = connect(host=host, username="admin", password="", port=8728, timeout=5)
        break
    except TrapError:  # admin já tem senha: CHR configurado numa execução anterior
        print("CHR já configurado; nada a fazer")
        raise SystemExit(0)
    except Exception as e:  # ainda iniciando (ou API em texto claro já desativada)
        last = e
        if i > 5 and "refused" in str(e).lower():
            print("CHR já configurado (API em texto claro desativada); nada a fazer")
            raise SystemExit(0)
        time.sleep(2)
else:
    raise SystemExit(f"CHR não respondeu: {last}")

res = next(iter(api.path("system", "resource")))
print("RouterOS", res.get("version"), res.get("board-name"))
radius_ip = socket.gethostbyname(os.environ["RADIUS_HOST"])

api.path("ip", "pool").add(name="pool-clientes", ranges="100.64.0.10-100.64.0.250")
for name, rate in (("plano-200m", "100M/200M"), ("plano-500m", "250M/500M"), ("plano-1000m", "500M/1000M")):
    api.path("ppp", "profile").add(name=name, **{"local-address": "100.64.0.1", "remote-address": "pool-clientes", "rate-limit": rate})
tuple(api("/ppp/aaa/set", **{"use-radius": "yes", "accounting": "yes", "interim-update": "1m"}))
api.path("radius").add(service="ppp", address=radius_ip, secret=os.environ["RADIUS_NAS_SECRET"], timeout="3s")
api.path("interface", "pppoe-server", "server").add(**{"service-name": "nexo", "interface": "ether2", "authentication": os.environ.get("LAB_PPP_AUTH", "mschap2,chap"),
                                                      "default-profile": "default", "disabled": "no", "one-session-per-host": "yes"})
# api-ssl com certificado próprio do laboratório; a CA é exportada para o agente verificar o servidor
cert = api.path("certificate")
cert.add(name="lab-ca", **{"common-name": "nexo-lab-ca", "key-usage": "key-cert-sign,crl-sign", "days-valid": "365"})
cert.add(name="lab-api", **{"common-name": host, "subject-alt-name": f"DNS:{host}", "key-usage": "digital-signature,key-encipherment,tls-server", "days-valid": "365"})
ids = {r["name"]: r[".id"] for r in cert}
tuple(api("/certificate/sign", **{".id": ids["lab-ca"]})); time.sleep(3)
tuple(api("/certificate/sign", **{".id": ids["lab-api"], "ca": "lab-ca"})); time.sleep(3)
tuple(api("/certificate/export-certificate", **{".id": ids["lab-ca"], "file-name": "lab-ca"})); time.sleep(1)
open("/out/routeros-ca.crt", "w").write([r for r in api.path("file") if r["name"] == "lab-ca.crt"][0]["contents"])
sid = [r[".id"] for r in api.path("ip", "service") if r["name"] == "api-ssl"][0]
api.path("ip", "service").update(**{".id": sid, "certificate": "lab-api", "disabled": "no"})

# usuário restrito para o agente (somente API, leitura e escrita)
api.path("user", "group").add(name="nexo-agent", policy="api,read,write,!local,!telnet,!ssh,!ftp,!reboot,!policy,!test,!winbox,!password,!web,!sniff,!sensitive,!romon,!rest-api")
api.path("user").add(name="nexo-agent", group="nexo-agent", password=os.environ["CHR_AGENT_PASSWORD"])
for svc in ("telnet", "ftp", "www", "ssh", "winbox"):
    sid = [r[".id"] for r in api.path("ip", "service") if r["name"] == svc]
    if sid:
        api.path("ip", "service").update(**{".id": sid[0], "disabled": "yes"})
uid = [r[".id"] for r in api.path("user") if r["name"] == "admin"][0]
api.path("user").update(**{".id": uid, "password": os.environ["CHR_ADMIN_PASSWORD"]})
# a API em texto claro (8728) só serviu a esta configuração inicial
for r in [r for r in api.path("ip", "service") if r["name"] == "api" and not r.get("dynamic")]:
    api.path("ip", "service").update(**{".id": r[".id"], "disabled": "yes"})
print("configurado: api-ssl com certificado, PPPoE server em ether2, RADIUS", radius_ip, "perfis:", [p["name"] for p in api.path("ppp", "profile")])
api.close()
