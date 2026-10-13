from __future__ import annotations
#!/usr/bin/env python3
"""Exporta clientes/contratos/serviços e títulos em aberto do SGP para o CSV intermediário do NexoISP (docs/importacao-csv.md).

Uso:  SGP_URL=... SGP_TOKEN=... SGP_APP=... python3 exportar_csv.py mapeamento.json [--saida DIR] [--so assinantes|titulos]

O mapeamento diz onde cada coluna está na resposta do SGP. Valores "?" são campos NÃO CONFIRMADOS: o programa recusa rodar
até alguém preenchê-los (use amostrar_formato.py para descobrir os caminhos). A saída tem dados pessoais: fica fora do
repositório (padrão ~/nexo-sgp-saida) com permissão 600.
"""
import argparse
import csv
import json
import os
import sys

from sgp_client import SgpClient, SgpError, dig

COLUNAS = {
    "assinantes": ["id_externo", "nome", "cpf_cnpj", "email", "telefone", "logradouro", "numero", "bairro", "cidade", "uf", "cep",
                   "observacoes", "situacao", "plano", "vencimento_dia", "pppoe_usuario", "pppoe_senha"],
    "titulos": ["id_externo", "id_externo_assinante", "vencimento", "valor", "competencia", "descricao"],
}
OBRIGATORIAS = {"assinantes": {"id_externo", "nome"}, "titulos": {"id_externo", "id_externo_assinante", "vencimento", "valor"}}


class MapeamentoInvalido(Exception):
    pass


def validar(mapa: dict, tipo: str):
    sec = mapa.get(tipo)
    if not isinstance(sec, dict):
        raise MapeamentoInvalido(f"mapeamento sem a seção '{tipo}'")
    cols = sec.get("colunas", {})
    desconhecidas = set(cols) - set(COLUNAS[tipo])
    if desconhecidas:
        raise MapeamentoInvalido(f"colunas desconhecidas em '{tipo}': {sorted(desconhecidas)}")
    faltam = [c for c in OBRIGATORIAS[tipo] if c not in cols]
    if faltam:
        raise MapeamentoInvalido(f"colunas obrigatórias sem mapeamento em '{tipo}': {faltam}")
    abertas = sorted(c for c, v in cols.items() if str(v).strip() in ("?", ""))
    if abertas:
        raise MapeamentoInvalido(f"campos não confirmados em '{tipo}' (valor '?'): {abertas}. Rode amostrar_formato.py e preencha.")
    if not sec.get("endpoint") or str(sec["endpoint"]).startswith("?"):
        raise MapeamentoInvalido(f"endpoint não definido em '{tipo}'")


def _valor(reg: dict, caminho: str, transforms: dict, coluna: str):
    v = dig(reg, caminho)
    if v is None:
        return ""
    tr = transforms.get(coluna)
    if tr:
        return tr.get(str(v), tr.get("*", ""))
    return v


def linhas(cliente: SgpClient, mapa: dict, tipo: str, avisos: dict):
    sec = mapa[tipo]
    cols, consts, transforms = sec["colunas"], sec.get("constantes", {}), sec.get("transformacoes", {})
    pag = sec.get("paginacao", {})
    # a mesma rota pode devolver o mesmo registro em páginas vizinhas se o cadastro mudar durante a leitura: deduplica pela chave
    vistos: set[str] = set()
    for reg in cliente.pages(sec["endpoint"], sec.get("parametros", {}), sec.get("lista", ""), pag.get("tamanho", 100),
                             pag.get("parametro_offset", "offset"), pag.get("parametro_limite", "limit")):
        row = {c: consts.get(c, "") for c in COLUNAS[tipo]}
        for c, caminho in cols.items():
            row[c] = _valor(reg, caminho, transforms, c)
        chave = str(row["id_externo"])
        if not chave:
            avisos["sem_id"] = avisos.get("sem_id", 0) + 1
            continue
        if chave in vistos:
            avisos["repetidos"] = avisos.get("repetidos", 0) + 1
            continue
        vistos.add(chave)
        lim = sec.get("avisar_se_lista_maior", {})
        for caminho, maximo in lim.items():
            lst = dig(reg, caminho)
            if isinstance(lst, list) and len(lst) > maximo:
                avisos["varios_" + caminho] = avisos.get("varios_" + caminho, 0) + 1
        yield row


def exportar(cliente: SgpClient, mapa: dict, saida: str, so: str | None = None) -> dict:
    os.makedirs(saida, mode=0o700, exist_ok=True)
    resumo: dict = {}
    for tipo in ("assinantes", "titulos"):
        if so and so != tipo:
            continue
        if tipo not in mapa:
            continue
        validar(mapa, tipo)
        avisos: dict = {}
        caminho = os.path.join(saida, f"{tipo}.csv")
        n = 0
        with open(caminho, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=COLUNAS[tipo], delimiter=";")
            w.writeheader()
            for row in linhas(cliente, mapa, tipo, avisos):
                w.writerow(row)
                n += 1
        os.chmod(caminho, 0o600)
        resumo[tipo] = {"arquivo": caminho, "linhas": n, "avisos": avisos}
    return resumo


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("mapeamento")
    ap.add_argument("--saida", default=os.path.expanduser("~/nexo-sgp-saida"))
    ap.add_argument("--so", choices=["assinantes", "titulos"])
    a = ap.parse_args(argv)
    mapa = json.load(open(a.mapeamento, encoding="utf-8"))
    try:
        resumo = exportar(SgpClient(), mapa, a.saida, a.so)
    except (MapeamentoInvalido, SgpError) as e:
        print(f"erro: {e}", file=sys.stderr)
        return 2
    for tipo, r in resumo.items():
        print(f"{tipo}: {r['linhas']} linha(s) em {r['arquivo']}")
        for k, v in r["avisos"].items():
            print(f"  aviso: {k} = {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
