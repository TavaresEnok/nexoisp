#!/usr/bin/env python3
"""Completa o provedor de laboratório IgaraNet para que o painel pareça o de um provedor em operação.

Tudo é FICTÍCIO e criado só pela API do painel (o mesmo caminho da interface). Etapas idempotentes, com progresso em
~/.local/share/nexoisp/igaranet/estado.json (chave "povoar").  Uso: python3 povoar.py [etapa ...]  (sem argumento: todas)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import provisionar as P  # noqa: E402

CL = P.CLIENTES
ETAPAS = []


def etapa(fn):
    ETAPAS.append(fn)
    return fn


def feito(st, chave) -> bool:
    return chave in st.setdefault("povoar", {})


def marcar(st, chave, valor=True):
    st.setdefault("povoar", {})[chave] = valor
    P.salvar(st)


@etapa
def assinantes(st, t):
    """Dados pessoais, contatos, observações, endereço de instalação com referência."""
    for c in CL:
        reg = st["clientes"][str(c["n"])]
        k = f"assinante:{c['n']}"
        if feito(st, k):
            continue
        P.call("PATCH", f"/subscribers/{reg['subscriber_id']}", {
            "birth_date": c["nascimento"], "rg": c["rg"], "rg_issuer": c["rg_orgao"], "mother_name": c["mae"],
            "notes": f"Cliente desde {c['cliente_desde'][:7].replace('-', '/')}. Referência: {c['referencia']}. Assinante FICTÍCIO do laboratório."}, t)
        contatos = [{"kind": "whatsapp", "value": c["whatsapp"], "label": "Titular", "purpose": "general", "allow_notices": True},
                    {"kind": "email", "value": c["email"], "label": "E-mail de cobrança", "purpose": "billing", "allow_notices": True}]
        if c.get("telefone_fixo"):
            contatos.append({"kind": "landline", "value": c["telefone_fixo"], "label": "Residencial", "purpose": "technical"})
        P.call("PUT", f"/subscribers/{reg['subscriber_id']}/contacts", {"contacts": contatos}, t)
        P.call("PUT", f"/contracts/{reg['contract_id']}/install-address", {
            "street": c["logradouro"], "number": c["numero"], "district": c["bairro"], "city": c["cidade"], "state": c["uf"], "zip": c["cep"]}, t)
        marcar(st, k)
    print("assinantes: dados pessoais, contatos e endereço de instalação completos")


EQUIPE = [  # nome, e-mail, papel
    ("Marcos Albuquerque", "marcos.noc@igaranet.lab", "noc"),
    ("Priscila Andrade", "priscila.atendimento@igaranet.lab", "attendant"),
    ("Renata Moura", "renata.atendimento@igaranet.lab", "attendant"),
    ("Cláudio Ferraz", "claudio.financeiro@igaranet.lab", "finance"),
    ("José Carlos Silva", "jose.tecnico@igaranet.lab", "noc"),
    ("Anderson Lima", "anderson.tecnico@igaranet.lab", "noc"),
]
TAGS = ["Fibra", "Comodato", "Fidelidade 12 meses", "Cliente VIP", "Indicação", "Condomínio", "Home office"]
CATALOGOS = {
    "ticket_type": ["Sem conexão", "Lentidão", "Wi-Fi", "Mudança de endereço", "Troca de senha"],
    "classification": ["Técnico", "Comercial", "Financeiro"],
    "root_cause": ["Fibra rompida na drop", "Conector sujo", "Roteador travado", "ONU queimada (surto)", "Cliente desligou equipamento"],
    "origin": ["WhatsApp", "Telefone", "Loja", "Portal do assinante"],
    "os_reason": ["Instalação nova", "Reparo de fibra", "Troca de equipamento", "Mudança de cômodo", "Retirada de equipamento"],
    "end_reason": ["Mudança de cidade", "Insatisfação com o serviço", "Questão financeira", "Mudou de provedor"],
    "note_type": ["Contato com cliente", "Observação técnica", "Negociação"],
}


@etapa
def configuracao(st, t):
    """Equipe, etiquetas, catálogos de atendimento/OS, blocos de IP e município ANATEL."""
    pv = st.setdefault("povoar", {})
    pv.setdefault("usuarios", {})
    for nome, email, papel in EQUIPE:
        if email in pv["usuarios"]:
            continue
        try:
            u = P.call("POST", "/users", {"name": nome, "email": email, "role": papel, "password": "Igara#Lab2026"}, t)
            pv["usuarios"][email] = u.get("id")
        except P.ApiError as e:
            if e.status != 409:
                raise
            pv["usuarios"][email] = None
        P.salvar(st)
    pv.setdefault("tags", {})
    existentes = {x["name"]: x["id"] for x in P.lista(P.call("GET", "/tags", token=t))}
    for nome in TAGS:
        if nome not in existentes:
            existentes[nome] = P.call("POST", "/tags", {"name": nome}, t)["id"]
    pv["tags"] = {k: v for k, v in existentes.items() if k in TAGS}
    P.salvar(st)
    if not feito(st, "catalogos"):
        for kind, nomes in CATALOGOS.items():
            for nome in nomes:
                try:
                    P.call("POST", "/catalogs", {"kind": kind, "name": nome}, t)
                except P.ApiError as e:
                    if e.status != 409:
                        raise
        marcar(st, "catalogos")
    if not feito(st, "ipam"):
        P.call("POST", "/ipam/pools", {"name": "CGNAT clientes PPPoE", "cidr": "100.64.10.0/24", "kind": "cgnat", "device_id": st["nas_id"],
                                       "notes": "Pool igaranet-clientes do BRAS-IGARASSU"}, t)
        P.call("POST", "/ipam/pools", {"name": "Bloco público (documentação)", "cidr": "203.0.113.0/24", "kind": "public",
                                       "notes": "Faixa de documentação RFC 5737 usada como bloco público fictício"}, t)
        P.call("POST", "/ipam/pools", {"name": "Gerência de equipamentos", "cidr": "10.0.137.0/24", "kind": "management",
                                       "notes": "BRAS 10.0.137.2, OLT 10.0.137.3, agente 10.0.137.4"}, t)
        marcar(st, "ipam")
    if not feito(st, "anatel"):
        P.call("PUT", "/anatel/municipalities", {"name": "Igarassu", "state": "PE", "ibge_code": "2606804"}, t)
        marcar(st, "anatel")
    # etiquetas nos contratos
    for c in CL:
        k = f"tags:{c['n']}"
        if feito(st, k):
            continue
        tags = [pv["tags"]["Fibra"], pv["tags"]["Comodato"]]
        if c["fidelidade"]:
            tags.append(pv["tags"]["Fidelidade 12 meses"])
        if c["n"] % 9 == 0:
            tags.append(pv["tags"]["Cliente VIP"])
        if c["n"] % 6 == 2:
            tags.append(pv["tags"]["Home office"])
        if c["n"] % 7 == 3:
            tags.append(pv["tags"]["Indicação"])
        P.call("PUT", f"/contracts/{st['clientes'][str(c['n'])]['contract_id']}/tags", {"tag_ids": tags}, t)
        marcar(st, k)
    for pid in st["planos"].values():  # régua: aviso com 3 dias de atraso, bloqueio com 15
        P.call("PUT", f"/plans/{pid}/dunning", {"warn_after_days": 3, "reduce_after_days": None, "block_after_days": 15, "reduced_profile": None}, t)
    if not feito(st, "manutencao"):
        r = P.call("POST", "/maintenance-notices", {
            "title": "Manutenção preventiva na OLT de Igarassu", "severity": "degraded", "device_id": st["olt_id"],
            "message": "Limpeza de conectores e atualização de firmware na OLT do POP Centro. Pode haver quedas rápidas entre 2h e 4h.",
            "starts_at": "2026-11-20T05:00:00.000Z", "ends_at": "2026-11-20T07:00:00.000Z"}, t)
        marcar(st, "manutencao", r.get("id"))
    print("configuração: equipe, etiquetas, catálogos, IPAM, ANATEL, régua dos planos e aviso de manutenção")


def _cnpj(base12: str) -> str:
    n = [int(x) for x in base12]
    for pesos in ([5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]):
        r = sum(a * b for a, b in zip(n, pesos)) % 11
        n.append(0 if r < 2 else 11 - r)
    return "".join(map(str, n))


@etapa
def comercial(st, t):
    """Empresa (razão social fictícia), tecnologia e fidelidade dos planos, juros/multa, vencimentos e fidelidade dos contratos."""
    pv = st["povoar"]
    if not feito(st, "empresa"):
        r = P.call("POST", "/companies", {"name": "IgaraNet Telecomunicações Ltda (fictícia)", "document": _cnpj("471126150001"), "is_default": True}, t)
        marcar(st, "empresa", r["id"])
    for pid in st["planos"].values():
        P.call("PUT", f"/plans/{pid}/technology", {"access_technology": "FTTH"}, t)
        P.call("PUT", f"/plans/{pid}/loyalty", {"months": 12, "penalty_model": "monthly", "penalty_cents": 3000}, t)
    cfg = P.call("GET", "/finance/settings", token=t)
    P.call("PUT", "/finance/settings", {"gateway": "none", "billing_auto": False, "auto_suspend": False, "suspend_after_days": None,
                                        "auto_resume_on_payment": cfg.get("auto_resume_on_payment", False), "late_fee_percent": 2,
                                        "interest_monthly_percent": 1}, t)
    for c in CL:
        k = f"comercial:{c['n']}"
        if feito(st, k):
            continue
        cid = st["clientes"][str(c["n"])]["contract_id"]
        P.call("PUT", f"/contracts/{cid}/company", {"company_id": pv["empresa"]}, t)
        P.call("PATCH", f"/contracts/{cid}", {"due_day": c["vencimento"]}, t)
        if c["fidelidade"]:
            P.call("PUT", f"/contracts/{cid}/loyalty", {"months": 12, "penalty_model": "monthly", "penalty_cents": 3000,
                                                       "from": max(c["cliente_desde"], "2025-12-01")}, t)
        marcar(st, k)
    print("comercial: empresa, planos FTTH com fidelidade, multa 2% + juros 1%, vencimentos e fidelidades")


def _bairros():
    from collections import defaultdict
    g = defaultdict(list)
    for c in CL:
        g[(c["bairro"], c["pon"])].append(c)
    return g


POP = (-7.8340, -34.9063)


@etapa
def rede(st, t):
    """Modelos/template de ONU, CEO no POP, 12 CTOs (uma por bairro e PON), cabos com traçado e drops dos 30 clientes."""
    pv = st["povoar"]
    if not feito(st, "onu_modelos"):
        m1 = P.call("POST", "/olt/onu-models", {"code": "EG8145V5", "vendor": "Huawei", "mode": "Router", "description": "ONT GPON com Wi-Fi dual band",
                                               "ports": "4 GE + 1 POTS + USB", "wifi": "2,4 GHz e 5 GHz (802.11ac)", "profile": "residencial",
                                               "compatible_olts": ["OLT-HUAWEI-IGARASSU"]}, t)
        m2 = P.call("POST", "/olt/onu-models", {"code": "HG8310M", "vendor": "Huawei", "mode": "Bridge", "description": "ONU GPON bridge 1 porta",
                                               "ports": "1 GE", "wifi": "", "profile": "residencial", "compatible_olts": ["OLT-HUAWEI-IGARASSU"]}, t)
        P.call("POST", "/olt/onu-templates", {"name": "Residencial PPPoE VLAN 100", "vendor": "Huawei", "mode": "Bridge", "model_ids": [m1["id"], m2["id"]],
                                              "compatible_olts": ["OLT-HUAWEI-IGARASSU"], "gpon": "ont-lineprofile residencial / ont-srvprofile bridge-1ge",
                                              "wan": "VLAN 100, PPPoE no roteador do cliente", "notes": "Padrão da IgaraNet para planos residenciais."}, t)
        marcar(st, "onu_modelos")
    if not feito(st, "ceo"):
        b = P.call("POST", "/ftth/boxes", {"name": "CEO-POP-CENTRO", "kind": "ceo", "ports": 48, "device_id": st["olt_id"], "address": "POP Igarassu Centro",
                                           "latitude": POP[0] + 0.0004, "longitude": POP[1] + 0.0003, "notes": "Emenda de saída do POP"}, t)
        marcar(st, "ceo", b["id"])
    pv.setdefault("ctos", {})
    for (bairro, pon), cs in sorted(_bairros().items()):
        nome = f"CTO-{bairro.upper().replace(' ', '-')[:14]}-{'01' if pon.endswith('/0') else '02'}"
        if nome not in pv["ctos"]:
            lat = sum(c["lat"] for c in cs) / len(cs); lng = sum(c["lng"] for c in cs) / len(cs)
            b = P.call("POST", "/ftth/boxes", {"name": nome, "kind": "cto", "ports": 8, "parent_id": pv["ceo"], "device_id": st["olt_id"], "pon_port": pon,
                                               "address": f"Poste na {cs[0]['logradouro']}, {bairro}", "latitude": round(lat, 6), "longitude": round(lng, 6),
                                               "notes": "Splitter 1:8 conectorizado"}, t)
            pv["ctos"][nome] = {"id": b["id"], "lat": lat, "lng": lng, "clientes": [c["n"] for c in cs]}
            P.salvar(st)
        cto = pv["ctos"][nome]
        ck = f"cabo:{nome}"
        if not feito(st, ck):
            meio = ((POP[0] + cto["lat"]) / 2 + 0.0006, (POP[1] + cto["lng"]) / 2 - 0.0005)
            cabo = P.call("POST", "/ftth/cables", {"pop_id": st["pop_id"], "name": f"CB-{nome[4:]}", "kind": "aerial", "fiber_count": 12,
                                                    "a_box_id": pv["ceo"], "b_box_id": cto["id"],
                                                    "path": [{"lat": POP[0] + 0.0004, "lng": POP[1] + 0.0003}, {"lat": meio[0], "lng": meio[1]},
                                                             {"lat": cto["lat"], "lng": cto["lng"]}], "notes": "Cabo AS-80 12 fibras"}, t)
            try:  # fibra 1 do cabo no splitter (porta 1 da CTO usada como entrada)
                P.call("POST", f"/ftth/boxes/{pv['ceo']}/fusions", {"a_cable_id": cabo["id"], "a_fiber": 1, "b_port": len(pv["ctos"]), "loss_db": 0.05}, t)
            except P.ApiError as e:
                print("fusão não registrada:", e.status, e.body)
            marcar(st, ck, cabo["id"])
        for porta, n in enumerate(cto["clientes"], start=1):
            dk = f"drop:{n}"
            if not feito(st, dk):
                P.call("POST", f"/ftth/boxes/{cto['id']}/drops", {"port": porta, "contract_id": st["clientes"][str(n)]["contract_id"],
                                                                   "note": "Drop flat 1 fibra"}, t)
                marcar(st, dk)
    print(f"rede: modelos de ONU, CEO, {len(pv['ctos'])} CTOs, cabos e 30 drops")


ITENS = {  # nome: (sku, unidade, serializado, mínimo, custo em centavos)
    "ONT Huawei EG8145V5": ("ONT-EG8145V5", "un", True, 5, 18900),
    "ONU Huawei HG8310M": ("ONU-HG8310M", "un", True, 5, 8900),
    "Cabo drop flat 1 fibra": ("DROP-FLAT-1F", "m", False, 1000, 45),
    "Conector SC/APC fast": ("CON-SCAPC", "un", False, 50, 250),
    "Esticador para drop": ("ESTIC-DROP", "un", False, 50, 120),
    "Roteador Wi-Fi 6 AX1500": ("ROT-AX1500", "un", False, 3, 21900),
}


@etapa
def estoque(st, t):
    """Depósitos, fornecedores, itens, compra recebida (gera contas a pagar) e as ONUs por número de série."""
    pv = st["povoar"]
    if not feito(st, "depositos"):
        d1 = P.call("POST", "/stock/warehouses", {"name": "Almoxarifado Centro", "address": "Rua Barbosa Lima, 120 - Centro, Igarassu"}, t)
        d2 = P.call("POST", "/stock/warehouses", {"name": "Carro técnico 01", "address": "Fiat Strada da equipe de campo"}, t)
        f1 = P.call("POST", "/stock/suppliers", {"name": "FibraNorte Distribuidora (fictícia)", "document": _cnpj("123456780001"),
                                                 "email": "vendas@fibranorte.lab", "phone": "81 3000-1000"}, t)
        f2 = P.call("POST", "/stock/suppliers", {"name": "Recife Equipamentos de Rede (fictícia)", "document": _cnpj("987654320001"),
                                                 "email": "comercial@recifeeq.lab", "phone": "81 3000-2000"}, t)
        marcar(st, "depositos", {"almox": d1["id"], "carro": d2["id"], "forn1": f1["id"], "forn2": f2["id"]})
    dep = pv["depositos"]
    pv.setdefault("itens", {})
    for nome, (sku, un, serial, minimo, _) in ITENS.items():
        if nome not in pv["itens"]:
            pv["itens"][nome] = P.call("POST", "/stock/items", {"name": nome, "sku": sku, "unit": un, "min_qty": minimo, "serialized": serial}, t)["id"]
            P.salvar(st)
    if not feito(st, "compra"):
        itens = [{"item_id": pv["itens"][n], "qty": q, "unit_cost_cents": ITENS[n][4]}
                 for n, q in (("Cabo drop flat 1 fibra", 6000), ("Conector SC/APC fast", 300), ("Esticador para drop", 200), ("Roteador Wi-Fi 6 AX1500", 10))]
        compra = P.call("POST", "/stock/purchases", {"supplier_id": dep["forn1"], "warehouse_id": dep["almox"], "expected_at": "2026-10-28",
                                                     "note": "Reposição mensal de material de instalação", "items": itens}, t)
        P.call("POST", f"/stock/purchases/{compra['id']}/status", {"status": "ordered"}, t)
        P.call("POST", f"/stock/purchases/{compra['id']}/receive", {"due_date": "2026-11-28", "installments": 2}, t)
        compra2 = P.call("POST", "/stock/purchases", {"supplier_id": dep["forn2"], "warehouse_id": dep["almox"], "expected_at": "2026-11-25",
                                                      "note": "Roteadores para planos 700 Mega", "items": [{"item_id": pv["itens"]["Roteador Wi-Fi 6 AX1500"], "qty": 20, "unit_cost_cents": 20900}]}, t)
        P.call("POST", f"/stock/purchases/{compra2['id']}/status", {"status": "ordered"}, t)
        marcar(st, "compra")
    if not feito(st, "series"):
        por_modelo = {"ONT Huawei EG8145V5": [], "ONU Huawei HG8310M": []}
        for c in CL:
            por_modelo["ONT Huawei EG8145V5" if c["n"] % 3 else "ONU Huawei HG8310M"].append(c["serial"])
        por_modelo["ONT Huawei EG8145V5"] += [f"48575443{0x1A2C0000 + i:08X}" for i in range(1, 7)]   # reservas no almoxarifado
        por_modelo["ONU Huawei HG8310M"] += [f"48575443{0x1A2D0000 + i:08X}" for i in range(1, 5)]
        for nome, series in por_modelo.items():
            P.call("POST", f"/stock/items/{pv['itens'][nome]}/units", {"serials": series, "note": "Lote recebido do fornecedor"}, t)
        marcar(st, "series")
    if not feito(st, "entrada_principal"):  # saldo inicial do depósito principal (de onde as OS consomem material)
        for nome, q in (("Cabo drop flat 1 fibra", 8000), ("Conector SC/APC fast", 400), ("Esticador para drop", 300), ("Roteador Wi-Fi 6 AX1500", 6)):
            P.call("POST", f"/stock/items/{pv['itens'][nome]}/movements", {"kind": "in", "qty": q, "unit_cost_cents": ITENS[nome][4],
                                                                          "note": "Saldo inicial do estoque principal"}, t)
        marcar(st, "entrada_principal")
    print("estoque: depósitos, fornecedores, itens, compras e 40 ONUs com série")


def _pdf(titulo: str, linhas: list) -> str:
    """PDF mínimo de uma página com texto (contrato FICTÍCIO), em base64."""
    import base64
    def esc(x):
        return x.encode("latin-1", "replace").decode("latin-1").replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    corpo = "BT /F1 16 Tf 50 790 Td (" + esc(titulo) + ") Tj ET\n" + "".join(
        f"BT /F1 10 Tf 50 {760 - 16 * i} Td ({esc(l)}) Tj ET\n" for i, l in enumerate(linhas))
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            f"<< /Length {len(corpo.encode('latin-1'))} >>\nstream\n{corpo}endstream",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"]
    out, offs = "%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offs.append(len(out.encode("latin-1")))
        out += f"{i} 0 obj\n{o}\nendobj\n"
    x = len(out.encode("latin-1"))
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n" + "".join(f"{o:010d} 00000 n \n" for o in offs)
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF\n"
    return base64.b64encode(out.encode("latin-1")).decode()


def _uuid():
    import uuid
    return str(uuid.uuid4())


def _tecnicos(st):
    u = st["povoar"]["usuarios"]
    return [u["jose.tecnico@igaranet.lab"], u["anderson.tecnico@igaranet.lab"]]


def _os_ate(t, os_id, final, resolucao):
    for s_ in ("scheduled", "en_route", "in_progress"):
        try:
            P.call("POST", f"/work-orders/{os_id}/status", {"status": s_}, t)
        except P.ApiError:
            pass
    if final:
        P.call("POST", f"/work-orders/{os_id}/status", {"status": final, **({"resolution": resolucao} if final == "done" else {})}, t)


@etapa
def operacao(st, t):
    """SLA, kit de instalação, OS de instalação concluídas (checklist, materiais, ONU em comodato), contrato em PDF e anotações."""
    pv = st["povoar"]
    tec = _tecnicos(st)
    if not feito(st, "sla"):
        P.call("POST", "/sla-policies", {"name": "Reparo residencial 24 h", "applies_to": "work_order", "kind": "repair", "resolution_minutes": 1440}, t)
        P.call("POST", "/sla-policies", {"name": "Instalação em 72 h", "applies_to": "work_order", "kind": "install", "resolution_minutes": 4320, "business_hours": True}, t)
        P.call("POST", "/sla-policies", {"name": "Atendimento prioridade alta 4 h", "applies_to": "ticket", "priority": "high", "resolution_minutes": 240}, t)
        P.call("POST", "/sla-policies", {"name": "Atendimento normal 24 h", "applies_to": "ticket", "priority": "normal", "resolution_minutes": 1440}, t)
        kit = P.call("POST", "/install-kits", {"name": "Kit instalação FTTH", "items": [
            {"item_id": pv["itens"]["Conector SC/APC fast"], "qty": 2}, {"item_id": pv["itens"]["Esticador para drop"], "qty": 2}]}, t)
        marcar(st, "sla", kit.get("id"))
    unidades = {u["serial"]: u for u in P.lista(P.call("GET", "/stock/units", token=t))}
    pv.setdefault("os", {})
    for c in CL:
        k = f"inst:{c['n']}"
        if feito(st, k):
            continue
        reg = st["clientes"][str(c["n"])]
        parcial = pv.setdefault("os_parcial", {})
        if str(c["n"]) in parcial:  # OS criada numa execução interrompida: refaz só os passos seguintes
            oid = parcial[str(c["n"])]
        else:
            oid = None
        o = {"id": oid} if oid else P.call("POST", "/work-orders", {"kind": "install", "subscriber_id": reg["subscriber_id"], "contract_id": reg["contract_id"],
                                            "description": f"Instalação FTTH {c['plano']} — {c['referencia']}", "assignee_id": tec[c["n"] % 2],
                                            "estimated_minutes": 120, "address_origin": "contract"}, t)
        oid = o["id"]
        parcial[str(c["n"])] = oid; P.salvar(st)
        P.call("POST", f"/work-orders/{oid}/checklist", {"items": ["Medir potência na CTO", "Lançar drop e fixar esticadores", "Conectorizar e medir na ONU",
                                                                    "Autorizar ONU e testar navegação", "Orientar o cliente sobre o Wi-Fi"]}, t)
        det = P.call("GET", f"/work-orders/{oid}", token=t)
        itens = det.get("checklist") or (det.get("work_order") or {}).get("checklist") or []
        for it in itens:
            try:
                P.call("POST", f"/work-orders/{oid}/checklist/{it['id']}", {"done": True}, t)
            except (P.ApiError, KeyError):
                pass
        P.call("POST", f"/work-orders/{oid}/materials", {"intention_id": _uuid(), "item_id": pv["itens"]["Cabo drop flat 1 fibra"], "qty": 40 + c["n"] * 3 % 90}, t)
        try:
            P.call("POST", f"/work-orders/{oid}/kit", {"kit_id": pv["sla"]}, t)
        except P.ApiError as e:
            print("kit:", e.status, e.body)
        u = unidades.get(c["serial"])
        if u:
            P.call("POST", f"/work-orders/{oid}/units", {"unit_id": u["id"], "mode": "comodato"}, t)
        P.call("POST", f"/work-orders/{oid}/notes", {"note": f"Potência na CTO -17,8 dBm; na ONU {c['rx_dbm']} dBm. Cliente orientado."}, t)
        _os_ate(t, oid, "done", f"Instalação concluída. ONU {c['serial']} em comodato, PPPoE {c['login']} navegando.")
        pv["os"][str(c["n"])] = oid
        marcar(st, k)
        # contrato assinado (PDF fictício) e anotação de boas-vindas
        P.call("POST", f"/subscribers/{reg['subscriber_id']}/documents", {"kind": "contract", "name": "Contrato de prestação de serviço (assinado).pdf",
               "contract_id": reg["contract_id"], "content_base64": _pdf("IgaraNet - Contrato de Prestacao de Servico (FICTICIO)", [
                   f"Assinante: {c['nome']}  CPF: {c['cpf']}", f"Endereco: {c['logradouro']}, {c['numero']} - {c['bairro']}, Igarassu/PE",
                   f"Plano: {c['plano']}  Vencimento: dia {c['vencimento']}", f"Inicio: {c['cliente_desde']}  Fidelidade: {'12 meses' if c['fidelidade'] else 'sem'}",
                   "Documento gerado para o laboratorio IgaraNet. Nao tem valor legal."])}, t)
        P.call("POST", f"/subscribers/{reg['subscriber_id']}/notes", {"body": f"Cliente veio por {'indicação de vizinho' if c['n'] % 7 == 3 else 'anúncio no Instagram'}. Prefere contato por WhatsApp.",
                                                                     "contract_id": reg["contract_id"]}, t)
    print("operação: SLA, kit, 30 OS de instalação concluídas com comodato, contratos em PDF e anotações")


REPAROS = [  # cliente, tipo, prioridade, assunto, mensagem, situação da OS (None = sem OS)
    (18, "repair", "high", "Internet caindo à noite", "Cliente relata quedas várias vezes à noite. Sinal na OLT -28,9 dBm.", "scheduled"),
    (7, "repair", "normal", "Lentidão no Wi-Fi do quarto", "Velocidade baixa longe do roteador; sinal óptico -27,4 dBm.", "open"),
    (25, "repair", "normal", "Sem conexão desde ontem", "LED LOS vermelho na ONU. Possível drop rompida após poda de árvore.", "en_route"),
    (12, None, "low", "Troca de senha do Wi-Fi", "Cliente pediu ajuda para trocar a senha da rede.", None),
    (4, None, "normal", "Dúvida sobre fidelidade", "Quer saber a multa caso mude de plano.", None),
    (21, None, "normal", "Mudança de endereço", "Vai se mudar para o bairro Triunfo no mês que vem.", None),
    (9, "repair", "normal", "Roteador reiniciando", "Equipamento reinicia sozinho; trocado em visita.", "done"),
    (15, None, "low", "Segunda via da fatura", "Solicitou segunda via por WhatsApp.", None),
]


@etapa
def atendimento(st, t):
    """Chamados (abertos, aguardando e encerrados) e OS de reparo em várias situações."""
    pv = st["povoar"]
    tec = _tecnicos(st)
    for n, kind, prio, assunto, msg, situacao in REPAROS:
        k = f"chamado:{n}:{assunto}"
        if feito(st, k):
            continue
        reg = st["clientes"][str(n)]
        parcial = pv.setdefault("chamado_parcial", {})
        if k in parcial:
            tk = {"id": parcial[k]}
        else:
            tk = P.call("POST", "/tickets", {"subscriber_id": reg["subscriber_id"], "contract_id": reg["contract_id"], "subject": assunto,
                                             "category": "technical" if kind else "commercial", "priority": prio, "body": msg}, t)
            parcial[k] = tk["id"]; P.salvar(st)
            P.call("POST", f"/tickets/{tk['id']}/messages", {"body": "Olá! Recebemos sua solicitação e já estamos verificando.", "internal": False}, t)
            P.call("POST", f"/tickets/{tk['id']}/messages", {"body": f"Conferido no painel: {msg}", "internal": True}, t)
        if kind:
            import datetime as _dt
            quando = (_dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(days={"scheduled": 1, "en_route": 0, "done": -2, "open": 2}[situacao],
                                                                             hours=2)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
            o = P.call("POST", "/work-orders", {"kind": kind, "subscriber_id": reg["subscriber_id"], "contract_id": reg["contract_id"], "ticket_id": tk["id"],
                                                "description": f"{assunto}: {msg}", "assignee_id": tec[n % 2], "estimated_minutes": 60, "address_origin": "contract",
                                                **({"scheduled_for": quando} if situacao != "open" else {})}, t)
            if situacao != "open":  # criada com data: já nasce agendada
                alvo = {"scheduled": [], "en_route": ["en_route"], "done": ["en_route", "in_progress"]}[situacao]
                for s_ in alvo:
                    P.call("POST", f"/work-orders/{o['id']}/status", {"status": s_}, t)
                if situacao == "done":
                    P.call("POST", f"/work-orders/{o['id']}/status", {"status": "done", "resolution": "Roteador substituído; cliente navegando normalmente."}, t)
                    P.call("POST", f"/tickets/{tk['id']}/status", {"status": "closed"}, t)
        elif n in (12, 15):
            P.call("POST", f"/tickets/{tk['id']}/status", {"status": "closed"}, t)
        marcar(st, k, tk["id"])
    print("atendimento: chamados e OS de reparo")


LEADS = [
    ("Paulo Henrique Bezerra", "81 99811-2201", "Rua do Canal", "Cruz de Rebouças", "Instagram", "IgaraNet 500 Mega", "proposal"),
    ("Mariana Costa Leite", "81 99722-3302", "Rua das Flores", "Saramandaia", "Indicação", "IgaraNet 300 Mega", "contacted"),
    ("Condomínio Jardim Igarassu", "81 3543-9900", "Avenida Principal", "Cruz de Rebouças", "Visita comercial", "IgaraNet 700 Mega", "new"),
    ("Roberto Farias Lins", "81 99633-4403", "Rua Esperança", "Triunfo", "Site", "IgaraNet 300 Mega", "new"),
    ("Cláudia Menezes", "81 99544-5504", "Rua Santo Antônio", "Santo Antônio", "Panfleto", "IgaraNet 500 Mega", "lost"),
    ("Padaria Pão de Igarassu", "81 3543-7711", "Rua do Comércio", "Santo Antônio", "Visita comercial", "IgaraNet 700 Mega", "proposal"),
]


@etapa
def crm(st, t):
    """Prospectos em vários estágios do funil."""
    for nome, fone, rua, bairro, origem, plano, estagio in LEADS:
        k = f"lead:{nome}"
        if feito(st, k):
            continue
        ld = P.call("POST", "/leads", {"name": nome, "phone": fone, "address_street": rua, "address_district": bairro, "address_city": "Igarassu",
                                       "address_state": "PE", "address_zip": "53610-000", "source": origem, "plan_id": st["planos"][plano],
                                       "notes": "Prospecto FICTÍCIO do laboratório."}, t)
        P.call("POST", f"/leads/{ld['id']}/notes", {"note": "Primeiro contato feito; aguardando viabilidade da CTO mais próxima."}, t)
        if estagio != "new":
            P.call("POST", f"/leads/{ld['id']}/stage", {"stage": estagio, **({"lost_reason": "Fechou com outro provedor"} if estagio == "lost" else {})}, t)
        marcar(st, k, ld["id"])
    print("crm: prospectos")


INADIMPLENTES = {5: 2, 14: 1, 23: 1, 29: 3}   # cliente: meses em aberto (os mais recentes)


def _psql(sql: str) -> list:
    import subprocess
    r = subprocess.run(["sudo", "docker", "exec", "nexoisp-painel-db-1", "psql", "-U", "nexo_owner", "-d", "nexo", "-At", "-F", "\t", "-c", sql],
                       capture_output=True, text=True, check=True)
    return [ln.split("\t") for ln in r.stdout.splitlines() if ln]


@etapa
def financeiro(st, t):
    """Mensalidades de 12/2025 a 11/2026 geradas pelo faturamento (sem gateway) e baixas manuais com datas e formas variadas."""
    import datetime as dt
    import random
    datas(st, t)   # as mensalidades dependem do início (retroativo) dos contratos
    pv = st["povoar"]
    if "fatura_teste" in pv and not feito(st, "fatura_teste_cancelada"):
        try:
            P.call("POST", f"/invoices/{pv['fatura_teste']}/cancel", {"reason": "Fatura de teste do laboratório"}, t)
        except P.ApiError:
            pass
        marcar(st, "fatura_teste_cancelada")
    for comp in ["2025-12"] + [f"2026-{m:02d}" for m in range(1, 12)]:
        if not feito(st, f"comp:{comp}"):
            r = P.call("POST", "/finance/generate", {"competence": comp}, t)
            marcar(st, f"comp:{comp}", r.get("created"))
    hoje = dt.date(2026, 11, 16)
    por_contrato = {v["contract_id"]: int(k) for k, v in st["clientes"].items()}
    linhas = _psql(f"select id, contract_id, due_date, amount_cents from invoices where tenant_id='{st['tenant_id']}' and status='open' "
                   "and kind='monthly' order by contract_id, due_date")
    from collections import defaultdict
    abertas = defaultdict(list)
    for iid, cid, due, amt in linhas:
        abertas[cid].append((iid, dt.date.fromisoformat(due), int(amt)))
    rnd = random.Random(2026)
    metodos = ["PIX", "PIX", "PIX", "Boleto", "Boleto", "Dinheiro na loja", "Cartão de débito"]
    pagas = 0
    for cid, faturas in abertas.items():
        n = por_contrato.get(cid)
        manter = INADIMPLENTES.get(n, 0)
        vencidas = [f for f in faturas if f[1] <= hoje]
        for iid, due, amt in vencidas[:len(vencidas) - manter] if manter else vencidas:
            if rnd.random() < 0.08 and due < hoje - dt.timedelta(days=20):   # alguns pagam com atraso (com multa e juros)
                pago = due + dt.timedelta(days=rnd.randint(3, 15)); fees = True
            else:
                pago = due - dt.timedelta(days=rnd.randint(0, 6)); fees = False
            pago = min(pago, hoje)
            try:
                P.call("POST", f"/invoices/{iid}/manual-payment", {"intent_id": _uuid(), "amount_cents": amt, "paid_at": pago.isoformat(),
                                                                  "method": rnd.choice(metodos), "note": "Baixa registrada pelo financeiro",
                                                                  **({"apply_fees": True} if fees else {})}, t)
                pagas += 1
            except P.ApiError as e:
                print("baixa recusada", iid[:8], e.status, e.body)
    for (iid,) in _psql(f"select id from invoices where tenant_id='{st['tenant_id']}' and status='reconciling'"):
        P.call("POST", f"/invoices/{iid}/resolve", {"decision": "paid", "note": "Pago com atraso; multa e juros dispensados pelo financeiro."}, t)
    print(f"financeiro: {len(linhas)} faturas em aberto antes da baixa, {pagas} baixas registradas; inadimplentes: {sorted(INADIMPLENTES)}")


ADICIONAIS = {"IP fixo": 3000, "Ponto Wi-Fi mesh extra": 2490, "Suporte técnico premium": 1990, "Streaming IgaraPlay": 1490}
MODELOS_AVISO = {
    "Lembrete de vencimento": "Olá, {nome}! Sua fatura IgaraNet de {valor} vence em {vencimento}. Pague por PIX ou boleto.",
    "Fatura em atraso": "Olá, {nome}. Identificamos fatura em aberto de {valor}. Regularize para evitar bloqueio.",
    "Manutenção programada": "IgaraNet informa: manutenção programada na sua região. Pode haver instabilidade rápida.",
    "Boas-vindas": "Bem-vindo(a) à IgaraNet, {nome}! Qualquer dúvida, fale conosco pelo WhatsApp.",
}


@etapa
def extras(st, t):
    """Produtos adicionais (alguns contratados), modelos de aviso, token de API e OS na agenda de hoje."""
    import datetime as dt
    pv = st["povoar"]
    pv.setdefault("adicionais", {})
    for nome, preco in ADICIONAIS.items():
        if nome not in pv["adicionais"]:
            pv["adicionais"][nome] = P.call("POST", "/addons", {"name": nome, "price_cents": preco}, t)["id"]
            P.salvar(st)
    for n, nome in ((3, "IP fixo"), (9, "Ponto Wi-Fi mesh extra"), (9, "Suporte técnico premium"), (18, "Streaming IgaraPlay"),
                    (22, "Ponto Wi-Fi mesh extra"), (27, "Streaming IgaraPlay"), (30, "IP fixo")):
        k = f"addon:{n}:{nome}"
        if not feito(st, k):
            P.call("POST", f"/contracts/{st['clientes'][str(n)]['contract_id']}/addons", {"product_id": pv["adicionais"][nome], "quantity": 1,
                                                                                         "from_competence": "2026-12"}, t)
            marcar(st, k)
    if not feito(st, "modelos_aviso"):
        for nome, corpo in MODELOS_AVISO.items():
            P.call("POST", "/notice-templates", {"name": nome, "body": corpo}, t)
        marcar(st, "modelos_aviso")
    if not feito(st, "token_api"):
        r = P.call("POST", "/api-tokens", {"name": "Site institucional (laboratório)", "scopes": ["subscribers:read", "tickets:write"],
                                           "rate_limit_per_min": 120, "expires_in_days": 365}, t)
        marcar(st, "token_api", r.get("id"))
    if not feito(st, "agenda_hoje"):
        hoje = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
        tec = _tecnicos(st)
        for n, kind, desc, h in ((21, "address_change", "Mudança de endereço para o Triunfo: lançar nova drop na CTO-TRIUNFO-02", 3),
                                 (7, "repair", "Revisar conectores da drop (sinal -27 dBm) e reposicionar roteador", 5)):
            reg = st["clientes"][str(n)]
            P.call("POST", "/work-orders", {"kind": kind, "subscriber_id": reg["subscriber_id"], "contract_id": reg["contract_id"], "description": desc,
                                            "assignee_id": tec[n % 2], "estimated_minutes": 90, "address_origin": "contract",
                                            "scheduled_for": (hoje + dt.timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M:%S.000Z")}, t)
        marcar(st, "agenda_hoje")
    print("extras: adicionais, modelos de aviso, token de API e agenda do dia")


@etapa
def datas(st, t):
    """Datas históricas (só neste provedor de laboratório; a API não aceita cadastro retroativo): contratos e assinantes
    desde 2023–2026, OS de instalação no dia da ativação e mensalidades criadas 12 dias antes do vencimento."""
    cl = {c["n"]: c for c in CL}
    T = st["tenant_id"]
    sql = ["begin;"]
    for n, reg in st["clientes"].items():
        d = cl[int(n)]["cliente_desde"]
        sql.append(f"update contracts set start_date='{d}', created_at='{d} 10:00-03' where id='{reg['contract_id']}' and tenant_id='{T}';")
        sql.append(f"update subscribers set created_at='{d} 09:30-03' where id='{reg['subscriber_id']}' and tenant_id='{T}';")
        oid = st.get("povoar", {}).get("os", {}).get(n)
        if oid:
            sql.append(f"update work_orders set created_at='{d} 08:00-03', scheduled_for='{d} 09:00-03', en_route_at='{d} 09:10-03', "
                       f"started_at='{d} 09:40-03', finished_at='{d} 11:30-03', updated_at='{d} 11:30-03', sla_due_at=null, sla_breached_at=null "
                       f"where id='{oid}' and tenant_id='{T}';")
    sql.append(f"update invoices set created_at=(due_date - 12)::timestamptz + interval '6 hours' where tenant_id='{T}' and kind='monthly';")
    sql.append("commit;")
    import subprocess
    subprocess.run(["sudo", "docker", "exec", "-i", "nexoisp-painel-db-1", "psql", "-U", "nexo_owner", "-d", "nexo", "-q", "-v", "ON_ERROR_STOP=1"],
                   input="\n".join(sql), text=True, check=True)
    print("datas: históricos ajustados")


def main():
    st = P.carregar()
    t = P.login(P.ADMIN, st["senha_automacao"], st, "mfa_automacao")
    pedidas = sys.argv[1:]
    for fn in ETAPAS:
        if not pedidas or fn.__name__ in pedidas:
            fn(st, t)


if __name__ == "__main__":
    main()
