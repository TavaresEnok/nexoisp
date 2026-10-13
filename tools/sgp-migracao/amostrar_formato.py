from __future__ import annotations
#!/usr/bin/env python3
"""Descobre o FORMATO das respostas da API do SGP (chaves e tipos), sem guardar nenhum valor.

Uso:  SGP_URL=https://seu.sgp.net.br SGP_TOKEN=... SGP_APP=... python3 amostrar_formato.py [--saida arquivo.json] [rota ...]
Sem rotas, amostra todas as de consulta permitidas. Pede 2 registros por rota. O resultado serve para preencher o mapeamento
(mapeamento.exemplo.json) e para escrever, depois, uma camada de compatibilidade fiel. Não contém dados de cliente.
"""
import argparse
import json
import os
import re
import sys

from sgp_client import ALLOWED, SENSITIVE_KEY_HINTS, SgpClient, SgpError

_CLASSES = [
    ("cpf", re.compile(r"^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$")),
    ("cnpj", re.compile(r"^\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}$")),
    ("email", re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")),
    ("data", re.compile(r"^\d{4}-\d{2}-\d{2}$|^\d{2}/\d{2}/\d{4}$")),
    ("data_hora", re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}")),
    ("uuid", re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-")),
    ("url", re.compile(r"^https?://")),
    ("so_digitos", re.compile(r"^\d+$")),
    ("decimal", re.compile(r"^\d+[.,]\d+$")),
    ("ip", re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")),
    ("mac", re.compile(r"^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$")),
]


def classify(s: str) -> str:
    if s == "":
        return "texto_vazio"
    for name, rx in _CLASSES:
        if rx.match(s):
            return name
    return "texto"


def shape(v, key: str = ""):
    if any(h in key.lower() for h in SENSITIVE_KEY_HINTS):
        return "<campo sensível: valor não lido>"
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, int):
        return "int"
    if isinstance(v, float):
        return "float"
    if isinstance(v, str):
        return f"str:{classify(v)}"
    if isinstance(v, list):
        merged: dict = {}
        elems = [shape(x) for x in v[:5]]
        if not elems:
            return ["vazia"]
        if all(isinstance(e, dict) for e in elems):
            for e in elems:
                for k, s in e.items():
                    merged.setdefault(k, s)
            return [merged]
        return [elems[0]]
    if isinstance(v, dict):
        return {k: shape(x, k) for k, x in v.items()}
    return "?"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("rotas", nargs="*")
    ap.add_argument("--saida", default=os.path.expanduser("~/nexo-sgp-saida/formato.json"))
    a = ap.parse_args(argv)
    rotas = a.rotas or sorted(ALLOWED)
    c = SgpClient()
    out: dict = {}
    for r in rotas:
        try:
            out[r] = shape(c.post(r, {"limit": 2, "offset": 0}))
            print(f"ok      {r}")
        except SgpError as e:
            out[r] = {"erro": str(e)}
            print(f"falhou  {e}")
    os.makedirs(os.path.dirname(a.saida), mode=0o700, exist_ok=True)
    with open(a.saida, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    os.chmod(a.saida, 0o600)
    print(f"\nformato gravado em {a.saida} (sem valores)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
