#!/usr/bin/env python3
"""Exporta cliente/contrato/login PPPoE e faturas do IXCSoft para o CSV do NexoISP (docs/importacao-csv.md).

O IXC é relacional, então aqui há JUNÇÃO: cada ASSINANTE é um `cliente_contrato` com os dados do `cliente`
(identidade/endereço) e do `radusuarios` (login/senha/ip/mac) daquele contrato; o PLANO vem de `vd_contratos`.
Cada FATURA é um `fn_areceber`, ligada ao assinante pelo id do contrato. Só leitura; a saída tem dados pessoais e
fica fora do repositório (~/nexo-ixc-saida, 600).

Uso:  IXC_URL=... IXC_TOKEN=... python3 exportar_csv.py [--saida DIR] [--so assinantes|titulos] [--max N]
"""
from __future__ import annotations
import argparse
import csv
import os
import sys

from ixc_client import IxcClient, IxcError

COLUNAS = {
    "assinantes": ["id_externo", "nome", "cpf_cnpj", "email", "telefone", "logradouro", "numero", "bairro", "cidade", "uf", "cep",
                   "observacoes", "situacao", "plano", "vencimento_dia", "pppoe_usuario", "pppoe_senha", "mac", "ip_fixo", "inicio_contrato"],
    "titulos": ["id_externo", "id_externo_assinante", "id_externo_contrato", "vencimento", "valor", "competencia", "descricao",
                "situacao", "pago_em", "valor_pago", "forma_pagamento"],
}
SIT_CONTRATO = {"A": "ativo"}          # qualquer outro (I, etc.) -> inativo
SIT_TITULO = {"A": "aberto", "R": "pago", "C": "cancelado"}


def _g(d: dict, *chaves: str) -> str:
    for k in chaves:
        v = d.get(k)
        if v not in (None, ""):
            return str(v)
    return ""


def indexar(cliente: IxcClient, tabela: str, chave: str, cap: int = 0) -> dict:
    idx: dict[str, dict] = {}
    for n, reg in enumerate(cliente.pages(tabela, rp=200), 1):
        k = str(reg.get(chave) or "")
        if k and k not in idx:       # primeiro registro por chave
            idx[k] = reg
        if cap and n >= cap:
            break
    return idx


def exportar(cliente: IxcClient, saida: str, so: str | None = None, maximo: int = 0) -> dict:
    os.makedirs(saida, mode=0o700, exist_ok=True)
    resumo: dict = {}
    planos = {str(r.get("id")): _g(r, "nome", "descricao") for r in cliente.pages("vd_contratos", rp=200)}
    if not so or so == "assinantes":
        rad = indexar(cliente, "radusuarios", "id_contrato", cap=maximo * 4 if maximo else 0)
        clientes = indexar(cliente, "cliente", "id", cap=maximo * 4 if maximo else 0)
        caminho = os.path.join(saida, "assinantes.csv")
        avisos = {"sem_cliente": 0, "sem_login": 0}
        n = 0
        with open(caminho, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=COLUNAS["assinantes"], delimiter=";")
            w.writeheader()
            for ct in cliente.pages("cliente_contrato", rp=200):
                cli = clientes.get(str(ct.get("id_cliente")))
                if cli is None:
                    avisos["sem_cliente"] += 1
                    cli = {}
                ru = rad.get(str(ct.get("id"))) or {}
                if not ru:
                    avisos["sem_login"] += 1
                w.writerow({
                    "id_externo": _g(ct, "id"),
                    "nome": _g(cli, "razao", "nome_social"),
                    "cpf_cnpj": _g(cli, "cnpj_cpf"),
                    "email": _g(cli, "email"),
                    "telefone": _g(cli, "telefone_celular", "whatsapp", "fone"),
                    "logradouro": _g(cli, "endereco"),
                    "numero": _g(cli, "numero"),
                    "bairro": _g(cli, "bairro"),
                    "cidade": "",   # IXC guarda cidade/uf como id (FK); resolver pela tabela 'cidade' é um passo à parte
                    "uf": "",
                    "cep": _g(cli, "cep"),
                    "observacoes": "",
                    "situacao": SIT_CONTRATO.get(_g(ct, "status"), "inativo"),
                    "plano": planos.get(_g(ct, "id_vd_contrato"), ""),
                    "vencimento_dia": "",   # IXC não tem dia fixo no contrato; inferível do vencimento das faturas
                    "pppoe_usuario": _g(ru, "login"),
                    "pppoe_senha": _g(ru, "senha"),
                    "mac": _g(ru, "mac"),
                    "ip_fixo": _g(ru, "ip") if _g(ru, "fixar_ip") in ("S", "1", "sim") else "",
                    "inicio_contrato": _g(ct, "data_ativacao", "data"),
                })
                n += 1
                if maximo and n >= maximo:
                    break
        os.chmod(caminho, 0o600)
        resumo["assinantes"] = {"arquivo": caminho, "linhas": n, "avisos": avisos}
    if not so or so == "titulos":
        caminho = os.path.join(saida, "titulos.csv")
        n = 0
        with open(caminho, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=COLUNAS["titulos"], delimiter=";")
            w.writeheader()
            for t in cliente.pages("fn_areceber", rp=200):
                w.writerow({
                    "id_externo": _g(t, "id"),
                    "id_externo_assinante": _g(t, "id_contrato"),
                    "id_externo_contrato": _g(t, "id_contrato"),
                    "vencimento": _g(t, "data_vencimento"),
                    "valor": _g(t, "valor"),
                    "competencia": "",
                    "descricao": _g(t, "obs", "documento"),
                    "situacao": SIT_TITULO.get(_g(t, "status"), "aberto"),
                    "pago_em": _g(t, "pagamento_data", "baixa_data"),
                    "valor_pago": _g(t, "valor_recebido", "pagamento_valor"),
                    "forma_pagamento": _g(t, "forma_recebimento"),
                })
                n += 1
                if maximo and n >= maximo:
                    break
        os.chmod(caminho, 0o600)
        resumo["titulos"] = {"arquivo": caminho, "linhas": n}
    return resumo


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--saida", default=os.path.expanduser("~/nexo-ixc-saida"))
    ap.add_argument("--so", choices=["assinantes", "titulos"])
    ap.add_argument("--max", type=int, default=0)
    a = ap.parse_args(argv)
    try:
        resumo = exportar(IxcClient(), a.saida, a.so, a.max)
    except IxcError as e:
        print(f"erro: {e}", file=sys.stderr)
        return 2
    for tipo, r in resumo.items():
        print(f"{tipo}: {r['linhas']} linha(s) em {r['arquivo']}")
        for k, v in r.get("avisos", {}).items():
            print(f"  aviso: {k} = {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
