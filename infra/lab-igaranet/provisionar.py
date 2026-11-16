#!/usr/bin/env python3
"""Cria o provedor de LABORATÓRIO IgaraNet no NexoISP só pela API pública do painel (nada direto no banco).

Etapas (idempotentes; o progresso e os segredos ficam em ~/.local/share/nexoisp/igaranet/estado.json, fora do git):
  tenant + módulos, usuários, agente de rede, OLT Huawei, concentrador MikroTik no RADIUS integrado (túnel WireGuard),
  POP, planos com velocidade, 30 assinantes fictícios com contrato, PPPoE, coordenadas e ONU autorizada pela OLT.

Uso: python3 provisionar.py [tudo|base|clientes|onus|estado]
Variáveis: NEXO_PAINEL (padrão http://127.0.0.1:18380/api).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import struct
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = os.environ.get("NEXO_PAINEL", "http://127.0.0.1:18380/api")
DIR = Path.home() / ".local/share/nexoisp/igaranet"
ESTADO = DIR / "estado.json"
AQUI = Path(__file__).resolve().parent
CLIENTES = json.loads((AQUI / "clientes.json").read_text())
OPERADOR = "laboratorio@nexoisp.local"
ADMIN = "automacao@igaranet.lab"      # usado por este script (MFA configurado aqui)
GESTOR = "gestor@igaranet.lab"        # conta do dono para entrar no painel (MFA configurado no 1º acesso)
OLT_HOST, OLT_PORT, AGENTE_IP = "10.0.137.3", 22, "10.0.137.4"
PLANOS = {  # nome: (preço em centavos, download kbps, upload kbps, rate-limit MikroTik subida/descida)
    "IgaraNet 300 Mega": (9990, 300_000, 150_000, "150M/300M"),
    "IgaraNet 500 Mega": (11990, 500_000, 250_000, "250M/500M"),
    "IgaraNet 700 Mega": (14990, 700_000, 350_000, "350M/700M"),
}


def carregar() -> dict:
    return json.loads(ESTADO.read_text()) if ESTADO.exists() else {}


def salvar(st: dict):
    DIR.mkdir(parents=True, exist_ok=True)
    ESTADO.write_text(json.dumps(st, indent=1, ensure_ascii=False))
    os.chmod(ESTADO, 0o600)


def totp(secret: str, at: float | None = None) -> str:
    key = base64.b32decode(secret.upper() + "=" * (-len(secret) % 8))
    msg = struct.pack(">Q", int((at or time.time()) // 30))
    h = hmac.new(key, msg, hashlib.sha1).digest()
    o = h[-1] & 15
    return f"{(struct.unpack('>I', h[o:o + 4])[0] & 0x7FFFFFFF) % 1_000_000:06d}"


class ApiError(Exception):
    def __init__(self, status, body):
        super().__init__(f"{status}: {body}")
        self.status, self.body = status, body


def call(method: str, path: str, body=None, token: str | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            raw = json.loads(raw)
        except ValueError:
            pass
        raise ApiError(e.code, raw) from None


def login(email: str, password: str, st: dict, key: str) -> str:
    """Entra e, se o painel exigir, configura a verificação em duas etapas (segredo guardado no estado local)."""
    body = {"email": email, "password": password, "bearer": True}
    if st.get(key):
        body["code"] = totp(st[key])
    token = call("POST", "/auth/login", body)["token"]
    if not st.get(key):  # o painel exige MFA de administradores: configura uma vez e guarda o segredo
        setup = call("POST", "/me/mfa/setup", {}, token)
        secret = setup.get("secret") or (setup.get("data") or {}).get("secret")
        if not secret:
            raise RuntimeError(f"resposta inesperada do setup de MFA: {list(setup)}")
        call("POST", "/me/mfa/enable", {"code": totp(secret)}, token)
        st[key] = secret
        salvar(st)
    return token


def lista(resp):
    if isinstance(resp, list):
        return resp
    for k in ("items", "data", "rows", "results"):
        if isinstance(resp, dict) and isinstance(resp.get(k), list):
            return resp[k]
    return resp or []


# ------------------------------------------------------------------ etapa base

def base(st: dict):
    op_pw = (DIR / "operador.txt").read_text().strip()
    op = login(OPERADOR, op_pw, st, "mfa_operador")
    if not st.get("tenant_id"):
        st.setdefault("senha_automacao", secrets.token_urlsafe(18))
        try:
            t = call("POST", "/tenants", {"name": "IgaraNet (laboratório)", "slug": "igaranet", "admin_name": "Automação IgaraNet",
                                         "admin_email": ADMIN, "admin_password": st["senha_automacao"]}, op)
            st["tenant_id"] = t.get("id") or t.get("tenant", {}).get("id")
        except ApiError as e:
            if e.status != 409:
                raise
            st["tenant_id"] = next(x["id"] for x in lista(call("GET", "/tenants", token=op)) if x.get("slug") == "igaranet")
        salvar(st)
    call("PATCH", f"/tenants/{st['tenant_id']}", {"modules": ["olt", "ipam", "field", "ftth", "crm", "noc", "notices", "messages", "api"]}, op)
    adm = login(ADMIN, st["senha_automacao"], st, "mfa_automacao")

    if not st.get("gestor"):
        st.setdefault("senha_gestor", secrets.token_urlsafe(12))
        try:
            call("POST", "/users", {"name": "Gestor IgaraNet", "email": GESTOR, "role": "admin", "password": st["senha_gestor"]}, adm)
        except ApiError as e:
            if e.status != 409:
                raise
        st["gestor"] = GESTOR
        salvar(st)

    if not st.get("agent_id"):
        a = call("POST", "/agents", {"name": "Agente IgaraNet (PNETLab)"}, adm)
        st.update(agent_id=a["id"], agent_token=a["token"], agent_signing_key=a.get("signing_public_key"))
        salvar(st)

    if not st.get("pop_id"):
        p = call("POST", "/pops", {"name": "POP Igarassu Centro", "city": "Igarassu", "state": "PE"}, adm)
        st["pop_id"] = p["id"]
        salvar(st)
    call("PUT", f"/pops/{st['pop_id']}/location", {"latitude": -7.8340, "longitude": -34.9063}, adm)

    if not st.get("olt_id"):
        d = call("POST", "/devices", {"name": "OLT-HUAWEI-IGARASSU", "driver": "olt_huawei", "host": OLT_HOST, "api_port": OLT_PORT,
                                      "credential_ref": "olt-igarassu", "agent_id": st["agent_id"]}, adm)
        st["olt_id"] = d["id"]
        salvar(st)

    if not st.get("nas_id"):
        r = call("POST", "/radius/devices", {"name": "BRAS-IGARASSU", "vendor": "mikrotik", "connection": "vpn"}, adm)
        st.update(nas_id=r.get("id") or r.get("device", {}).get("id"), nas_secret=r.get("secret"), nas_setup=r.get("setup"))
        salvar(st)
    if not st.get("tunel"):
        st["tunel"] = call("POST", f"/radius/devices/{st['nas_id']}/tunnel", {"kind": "vpn"}, adm)
        salvar(st)

    # Primeiro backup da configuração da OLT pedido na hora (o agendado semanal pode ter falhado antes de a OLT subir).
    try:
        call("POST", f"/devices/{st['olt_id']}/config-backups", None, adm)
    except ApiError as e:
        print("backup da OLT não pedido agora:", e.status, e.body)
    # Alerta de sinal fraco no NOC: abaixo de -25 dBm (os clientes 7, 18 e 25 do laboratório têm atenuação alta).
    call("PUT", "/noc/settings", {"onu_rx_min_dbm": -25, "pon_outage_min": 3}, adm)

    planos = {p["name"]: p for p in lista(call("GET", "/plans", token=adm))}
    st.setdefault("planos", {})
    for nome, (preco, down, up, rate) in PLANOS.items():
        if nome not in planos:
            planos[nome] = call("POST", "/plans", {"name": nome, "price_cents": preco, "down_kbps": down, "up_kbps": up,
                                                   "profile_name": nome.split()[1] + "M"}, adm)
        st["planos"][nome] = planos[nome]["id"]
        call("PUT", f"/plans/{planos[nome]['id']}/network", {"rate_limit": rate, "address_pool": None}, adm)
    salvar(st)
    print("base pronta: tenant", st["tenant_id"], "agente", st["agent_id"], "OLT", st["olt_id"], "NAS", st["nas_id"])


# ------------------------------------------------------------------ assinantes

def clientes(st: dict):
    adm = login(ADMIN, st["senha_automacao"], st, "mfa_automacao")
    st.setdefault("clientes", {})
    for c in CLIENTES:
        k = str(c["n"])
        reg = st["clientes"].setdefault(k, {})
        if not reg.get("subscriber_id"):
            s = call("POST", "/subscribers", {"name": c["nome"], "document": c["cpf"], "email": c["email"], "phone": c["telefone"],
                                              "address_street": c["logradouro"], "address_number": c["numero"], "address_district": c["bairro"],
                                              "address_city": c["cidade"], "address_state": c["uf"], "address_zip": c["cep"],
                                              "notes": "Assinante FICTÍCIO do laboratório IgaraNet (PNETLab)."}, adm)
            reg["subscriber_id"] = s["id"]; salvar(st)
        if not reg.get("contract_id"):
            k_ = call("POST", "/contracts", {"subscriber_id": reg["subscriber_id"], "plan_id": st["planos"][c["plano"]], "due_day": 10,
                                             "notes": "Contrato de laboratório (sem cobrança)."}, adm)
            reg["contract_id"] = k_["id"]; salvar(st)
        cid = reg["contract_id"]
        if not reg.get("pop"):
            call("PUT", f"/contracts/{cid}/pop", {"pop_id": st["pop_id"]}, adm)
            reg["pop"] = True; salvar(st)
        if not reg.get("local"):
            call("PUT", f"/contracts/{cid}/location", {"latitude": c["lat"], "longitude": c["lng"]}, adm)
            reg["local"] = True; salvar(st)
        if not reg.get("service"):
            r = call("POST", f"/contracts/{cid}/service", {"device_id": st["nas_id"], "access_type": "pppoe", "pppoe_username": c["login"],
                                                          "password": c["senha"], "mac": c["mac"].upper()}, adm)
            reg["service"] = r.get("resource_id") or r.get("id") or True; salvar(st)
        print(f"cliente {c['n']:>2} {c['login']} ok")


def onus(st: dict):
    adm = login(ADMIN, st["senha_automacao"], st, "mfa_automacao")
    for c in CLIENTES:
        reg = st["clientes"][str(c["n"])]
        if reg.get("onu_id"):
            continue
        r = call("POST", f"/contracts/{reg['contract_id']}/onu", {"device_id": st["olt_id"], "serial": c["serial"], "pon_port": c["pon"],
                                                                  "line_profile": "residencial", "service_vlan": 100, "service_profile": "bridge-1ge"}, adm)
        reg["onu_id"] = r["onu_id"]; salvar(st)
        print(f"ONU {c['serial']} -> cliente {c['n']} (operação {r.get('operation_id')})")


def main():
    st = carregar()
    etapa = sys.argv[1] if len(sys.argv) > 1 else "tudo"
    if etapa in ("base", "tudo"):
        base(st)
    if etapa in ("clientes", "tudo"):
        clientes(st)
    if etapa in ("onus", "tudo"):
        onus(st)
    if etapa == "estado":
        print(json.dumps({k: v for k, v in st.items() if "senha" not in k and "token" not in k and "mfa" not in k and "secret" not in k},
                         indent=1, ensure_ascii=False)[:3000])


if __name__ == "__main__":
    main()
