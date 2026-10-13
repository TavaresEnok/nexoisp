"""CENÁRIO PNETLAB: prepara (up) ou desfaz (down) o que o NexoISP precisa num concentrador MikroTik já configurado.
Só acrescenta itens marcados com o comentário/nome "nexo-lab"; não troca a senha do admin nem desliga serviços do cenário.
Variáveis: NAS_IP, HOST_IP, RADIUS_NAS_SECRET, NAS_AGENT_PASSWORD, NAS_LOCAL_ADDRESS, NAS_REMOTE_POOL."""
import os
import sys
import time

from librouteros import connect

E = os.environ
TAG = "nexo-lab"
api = connect(host=E["NAS_IP"], username="admin", password=E.get("NAS_ADMIN_PASSWORD", ""), port=8728, timeout=10)
P = api.path
PROFILES = (("plano-200m", "100M/200M"), ("plano-500m", "250M/500M"), ("plano-1000m", "500M/1000M"))


def ids(path, **match):
    return [r[".id"] for r in path if all(r.get(k) == v for k, v in match.items())]


def svc_set(**kw):
    P("ip", "service").update(**{".id": ids(P("ip", "service"), name="api-ssl")[0], **kw})


if sys.argv[1] == "up":
    res = next(iter(P("system", "resource")))
    print("RouterOS", res.get("version"), "|", res.get("board-name"))
    for name, rate in PROFILES:
        if not ids(P("ppp", "profile"), name=name):
            P("ppp", "profile").add(name=name, comment=TAG, **{"local-address": E["NAS_LOCAL_ADDRESS"], "remote-address": E["NAS_REMOTE_POOL"],
                                                              "rate-limit": rate, "change-tcp-mss": "yes"})
    # perfil de bloqueio (suspensão por perfil): conecta, mas com velocidade mínima e endereços de um pool próprio
    if not ids(P("ip", "pool"), name="nexo-bloqueados"):
        P("ip", "pool").add(name="nexo-bloqueados", ranges="10.254.0.2-10.254.0.254", comment=TAG)
    if not ids(P("ppp", "profile"), name="nexo-bloqueado"):
        P("ppp", "profile").add(name="nexo-bloqueado", comment=TAG, **{"local-address": "10.254.0.1", "remote-address": "nexo-bloqueados", "rate-limit": "1k/1k"})
    for r in ids(P("radius"), comment=TAG):
        P("radius").remove(r)
    P("radius").add(service="ppp", address=E["HOST_IP"], secret=E["RADIUS_NAS_SECRET"], timeout="3s", comment=TAG, **{"src-address": E["NAS_IP"]})
    tuple(api("/ppp/aaa/set", **{"use-radius": "yes", "accounting": "yes"}))
    cert = P("certificate")
    if not ids(cert, name="nexo-lab-api"):
        cert.add(name="nexo-lab-ca", **{"common-name": "nexo-lab-ca", "key-usage": "key-cert-sign,crl-sign", "days-valid": "365"})
        cert.add(name="nexo-lab-api", **{"common-name": E["NAS_IP"], "subject-alt-name": f"IP:{E['NAS_IP']}",
                                          "key-usage": "digital-signature,key-encipherment,tls-server", "days-valid": "365"})
        tuple(api("/certificate/sign", **{".id": ids(cert, name="nexo-lab-ca")[0]}))
        time.sleep(4)
        tuple(api("/certificate/sign", **{".id": ids(cert, name="nexo-lab-api")[0], "ca": "nexo-lab-ca"}))
        time.sleep(4)
    tuple(api("/certificate/export-certificate", **{".id": ids(cert, name="nexo-lab-ca")[0], "file-name": "nexo-lab-ca"}))
    time.sleep(1)
    open("/out/routeros-ca.crt", "w").write([r for r in P("file") if r["name"] == "nexo-lab-ca.crt"][0]["contents"])
    svc_set(certificate="nexo-lab-api", disabled="no")
    if not ids(P("user", "group"), name="nexo-agent"):
        P("user", "group").add(name="nexo-agent", comment=TAG,
                               policy="api,read,write,!local,!telnet,!ssh,!ftp,!reboot,!policy,!test,!winbox,!password,!web,!sniff,!sensitive,!romon,!rest-api")
    for r in ids(P("user"), name="nexo-agent"):
        P("user").remove(r)
    P("user").add(name="nexo-agent", group="nexo-agent", password=E["NAS_AGENT_PASSWORD"], address=E["HOST_IP"], comment=TAG)
    print("configurado: RADIUS", E["HOST_IP"], "| api-ssl com certificado | perfis", [n for n, _ in PROFILES], "| usuário nexo-agent restrito a", E["HOST_IP"])
else:
    tuple(api("/ppp/aaa/set", **{"use-radius": "no"}))
    for r in ids(P("radius"), comment=TAG):
        P("radius").remove(r)
    for r in ids(P("user"), name="nexo-agent"):
        P("user").remove(r)
    for r in ids(P("user", "group"), name="nexo-agent"):
        P("user", "group").remove(r)
    svc_set(certificate="none")
    for n in ("nexo-lab-api", "nexo-lab-ca"):
        for r in ids(P("certificate"), name=n):
            P("certificate").remove(r)
    for r in ids(P("ppp", "profile"), comment=TAG):
        P("ppp", "profile").remove(r)
    for r in ids(P("ip", "pool"), comment=TAG):
        P("ip", "pool").remove(r)
    for r in [r[".id"] for r in P("file") if r["name"].startswith("nexo-lab-ca")]:
        P("file").remove(r)
    print("removido do concentrador: RADIUS, usuário, certificado e perfis nexo-lab; use-radius=no")
api.close()
