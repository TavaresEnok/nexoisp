"""Ferramentas de migração do IXC, com cliente FALSO em memória (nenhum dado real, nenhuma rede)."""
import csv
import os
import sys
import tempfile
import unittest
import unittest.mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import exportar_csv as ex  # noqa: E402
from ixc_client import IxcClient, IxcError  # noqa: E402

TABELAS = {
    "vd_contratos": [{"id": 50, "nome": "Fibra 400"}, {"id": 51, "nome": "Fibra 700"}],
    "cliente": [{"id": 1, "razao": "Fulano Sintético", "cnpj_cpf": "000.000.000-00", "email": "f@exemplo.invalid",
                 "telefone_celular": "83999990000", "endereco": "Rua X", "numero": "10", "bairro": "Centro", "cidade": "321", "uf": "7", "cep": "58000-000"},
                {"id": 2, "razao": "Beltrano Sintético", "cnpj_cpf": "000.000.000-11", "email": "", "endereco": "Rua Y", "cep": "58000-001"}],
    "cliente_contrato": [{"id": 900, "id_cliente": 1, "status": "A", "id_vd_contrato": 50, "data_ativacao": "2025-01-10"},
                         {"id": 901, "id_cliente": 2, "status": "I", "id_vd_contrato": 51, "data_ativacao": "2024-05-01"},
                         {"id": 902, "id_cliente": 99, "status": "A", "id_vd_contrato": 50, "data_ativacao": "2025-02-02"}],
    "radusuarios": [{"id": 1, "id_contrato": 900, "login": "user1", "senha": "SENHA-SINTETICA", "mac": "02:4E:58:00:00:01", "ip": "100.64.0.9", "fixar_ip": "S"},
                    {"id": 2, "id_contrato": 901, "login": "user2", "senha": "SENHA-SINTETICA-2", "mac": "", "ip": "10.0.0.2", "fixar_ip": "N"}],
    "fn_areceber": [{"id": "F1", "id_cliente": 1, "id_contrato": 900, "data_vencimento": "2026-10-10", "valor": "99.90", "status": "R",
                     "pagamento_data": "2026-10-09", "valor_recebido": "99.90", "forma_recebimento": "pix", "obs": "Mensalidade"},
                    {"id": "F2", "id_cliente": 1, "id_contrato": 900, "data_vencimento": "2026-11-10", "valor": "99.90", "status": "A"}],
}


class FakeIxc:
    def pages(self, tabela, rp=100, **kw):
        yield from TABELAS.get(tabela, [])


class Cliente(unittest.TestCase):
    def test_trava_de_seguranca(self):
        with unittest.mock.patch.dict(os.environ, {}, clear=True), self.assertRaises(IxcError):
            IxcClient("", "")
        with self.assertRaises(IxcError):
            IxcClient("http://ixc.exemplo.com.br", "59:abc")      # texto claro fora de localhost
        c = IxcClient("https://ixc.exemplo.com.br", "59:abc")
        with self.assertRaises(IxcError):
            c.listar("cliente_contrato_add")                      # tabela fora da lista de consulta
        with self.assertRaises(IxcError):
            c.listar("usuarios")


class Exportador(unittest.TestCase):
    def test_junta_cliente_contrato_login_e_liga_titulos(self):
        d = tempfile.mkdtemp()
        r = ex.exportar(FakeIxc(), d)
        self.assertEqual(r["assinantes"]["linhas"], 3)
        self.assertEqual(r["assinantes"]["avisos"]["sem_cliente"], 1)   # contrato 902 aponta para cliente inexistente
        rows = list(csv.DictReader(open(os.path.join(d, "assinantes.csv"), encoding="utf-8"), delimiter=";"))
        self.assertEqual(list(rows[0].keys()), ex.COLUNAS["assinantes"])
        a = {x["id_externo"]: x for x in rows}
        self.assertEqual((a["900"]["nome"], a["900"]["situacao"], a["900"]["plano"], a["900"]["pppoe_usuario"]), ("Fulano Sintético", "ativo", "Fibra 400", "user1"))
        self.assertEqual((a["900"]["ip_fixo"], a["900"]["mac"]), ("100.64.0.9", "02:4E:58:00:00:01"))   # fixar_ip=S -> vai; senha não é conferida aqui
        self.assertEqual((a["901"]["situacao"], a["901"]["ip_fixo"]), ("inativo", ""))                    # status I; fixar_ip=N -> sem ip
        self.assertEqual((a["900"]["cidade"], a["900"]["uf"]), ("", ""))                                  # FK numérica não vira nome
        tit = {x["id_externo"]: x for x in csv.DictReader(open(os.path.join(d, "titulos.csv"), encoding="utf-8"), delimiter=";")}
        self.assertEqual((tit["F1"]["id_externo_assinante"], tit["F1"]["situacao"], tit["F1"]["forma_pagamento"]), ("900", "pago", "pix"))
        self.assertEqual(tit["F2"]["situacao"], "aberto")                                                 # status A -> aberto
        self.assertEqual(oct(os.stat(os.path.join(d, "titulos.csv")).st_mode & 0o777), "0o600")

    def test_max_limita(self):
        d = tempfile.mkdtemp()
        r = ex.exportar(FakeIxc(), d, maximo=1)
        self.assertEqual(r["assinantes"]["linhas"], 1)


if __name__ == "__main__":
    unittest.main()
