"""Ferramentas de migração do SGP, contra um servidor falso local com dados SINTÉTICOS (nenhum dado real)."""
import csv
import json
import os
import sys
import tempfile
import threading
import unittest
import unittest.mock
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import amostrar_formato as am  # noqa: E402
import exportar_csv as ex  # noqa: E402
from sgp_client import SgpClient, SgpError, dig  # noqa: E402

CLIENTES = [
    {"id": 100 + i, "nome": f"Cliente Sintético {i}", "cpfcnpj": f"000.000.000-{i:02d}", "email": f"c{i}@exemplo.invalid", "senha_central": "Segredo-Sintetico-XYZ",
     "contratos": [{"id": 900 + i, "status": 1 if i % 2 == 0 else 3, "plano": "Fibra 200", "vencimento": 5 + i % 5,
                    "servicos": [{"login": f"user{i}", "senha": "Pppoe-Sintetica-ABC"}]}]} for i in range(7)
]
CLIENTES[3]["contratos"].append({"id": 999, "status": 1, "plano": "TV", "vencimento": 10, "servicos": []})
TITULOS = [{"id": f"T{i}", "cliente": {"id": 100 + (i % 7)}, "data_vencimento": "2026-10-10", "valor": "79,90", "descricao": f"Mensalidade {i}"} for i in range(5)]
CHAMADAS: list = []


class Falso(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = urllib.parse.parse_qs(self.rfile.read(int(self.headers.get("Content-Length", 0))).decode())
        CHAMADAS.append((self.path, {k: v[0] for k, v in body.items()}))
        if body.get("token", [""])[0] != "tok-sintetico" or body.get("app", [""])[0] != "app-sintetico":
            self.send_response(403)
            self.end_headers()
            return
        off, lim = int(body.get("offset", ["0"])[0]), int(body.get("limit", ["100"])[0])
        src = {"/api/ura/clientes/": CLIENTES, "/api/ura/titulos/": TITULOS}.get(self.path)
        if src is None:
            self.send_response(404)
            self.end_headers()
            return
        out = json.dumps({"total": len(src), "lista": src[off:off + lim]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(out)


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), Falso)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.srv.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def cliente(self):
        return SgpClient(self.url, "tok-sintetico", "app-sintetico", pause_s=0)


class Cliente(Base):
    def test_so_rotas_de_consulta_e_so_https(self):
        c = self.cliente()
        with self.assertRaises(SgpError):
            c.post("/api/ura/contato/add/", {"nome": "x"})          # escrita: recusada antes de sair
        with self.assertRaises(SgpError):
            c.post("/api/ura/contrato/edit/", {})
        with self.assertRaises(SgpError):
            SgpClient("http://sgp.exemplo.com.br", "t", "a")        # texto claro fora de localhost
        with unittest.mock.patch.dict(os.environ, {}, clear=True), self.assertRaises(SgpError):
            SgpClient("", "", "")                                       # sem credencial no ambiente
        self.assertFalse(any(p in ("/api/ura/contato/add/", "/api/ura/contrato/edit/") for p, _ in CHAMADAS))

    def test_credencial_invalida_vira_erro_claro_sem_vazar_o_token(self):
        c = SgpClient(self.url, "outro", "app-sintetico", pause_s=0)
        with self.assertRaises(SgpError) as e:
            c.post("/api/ura/clientes/", {"limit": 1})
        self.assertIn("403", str(e.exception))
        self.assertNotIn("outro", str(e.exception))

    def test_dig(self):
        self.assertEqual(dig({"a": [{"b": 7}]}, "a.0.b"), 7)
        self.assertIsNone(dig({"a": []}, "a.3.b"))
        self.assertEqual(dig({"x": 1}, ""), {"x": 1})


class Amostrador(Base):
    def test_formato_sem_nenhum_valor(self):
        d = tempfile.mkdtemp()
        saida = os.path.join(d, "f.json")
        os.environ.update(SGP_URL=self.url, SGP_TOKEN="tok-sintetico", SGP_APP="app-sintetico")
        self.assertEqual(am.main(["--saida", saida, "/api/ura/clientes/", "/api/ura/titulos/", "/api/ura/pops/"]), 0)
        txt = open(saida, encoding="utf-8").read()
        for v in ("Sintético", "Segredo-Sintetico", "Pppoe-Sintetica", "000.000.000", "exemplo.invalid", "user3"):
            self.assertNotIn(v, txt)                                   # nenhum valor
        f = json.loads(txt)
        self.assertEqual(f["/api/ura/clientes/"]["lista"][0]["cpfcnpj"], "str:cpf")
        self.assertEqual(f["/api/ura/clientes/"]["lista"][0]["email"], "str:email")
        self.assertEqual(f["/api/ura/clientes/"]["lista"][0]["senha_central"], "<campo sensível: valor não lido>")
        self.assertEqual(f["/api/ura/clientes/"]["lista"][0]["contratos"][0]["servicos"][0]["senha"], "<campo sensível: valor não lido>")
        self.assertIn("erro", f["/api/ura/pops/"])                      # rota inexistente no servidor falso: registrada, não fatal
        self.assertEqual(oct(os.stat(saida).st_mode & 0o777), "0o600")
        self.assertEqual(am.classify("02:4E:58:00:00:02"), "mac")


MAPA = {
    "assinantes": {
        "endpoint": "/api/ura/clientes/", "lista": "lista", "paginacao": {"tamanho": 3},
        "colunas": {"id_externo": "id", "nome": "nome", "cpf_cnpj": "cpfcnpj", "email": "email", "situacao": "contratos.0.status", "plano": "contratos.0.plano",
                    "vencimento_dia": "contratos.0.vencimento", "pppoe_usuario": "contratos.0.servicos.0.login", "pppoe_senha": "contratos.0.servicos.0.senha"},
        "transformacoes": {"situacao": {"1": "ativo", "7": "ativo", "*": "inativo"}},
        "avisar_se_lista_maior": {"contratos": 1},
    },
    "titulos": {
        "endpoint": "/api/ura/titulos/", "lista": "lista", "paginacao": {"tamanho": 2},
        "colunas": {"id_externo": "id", "id_externo_assinante": "cliente.id", "vencimento": "data_vencimento", "valor": "valor", "descricao": "descricao"},
    },
}


class Exportador(Base):
    def test_gera_o_csv_intermediario_com_paginacao_e_avisos(self):
        d = tempfile.mkdtemp()
        r = ex.exportar(self.cliente(), MAPA, d)
        self.assertEqual(r["assinantes"]["linhas"], 7)
        self.assertEqual(r["titulos"]["linhas"], 5)
        self.assertEqual(r["assinantes"]["avisos"], {"varios_contratos": 1})   # um cliente com 2 contratos: só o primeiro entra
        rows = list(csv.DictReader(open(os.path.join(d, "assinantes.csv"), encoding="utf-8"), delimiter=";"))
        self.assertEqual(list(rows[0].keys()), ex.COLUNAS["assinantes"])        # mesmas colunas, na ordem de samples/assinantes.csv
        self.assertEqual((rows[0]["id_externo"], rows[0]["situacao"], rows[0]["pppoe_usuario"]), ("100", "ativo", "user0"))
        self.assertEqual(rows[1]["situacao"], "inativo")                         # status 3 (cancelado) -> inativo
        tit = list(csv.DictReader(open(os.path.join(d, "titulos.csv"), encoding="utf-8"), delimiter=";"))
        self.assertEqual((tit[0]["id_externo"], tit[0]["id_externo_assinante"], tit[0]["valor"]), ("T0", "100", "79,90"))
        self.assertEqual(oct(os.stat(os.path.join(d, "assinantes.csv")).st_mode & 0o777), "0o600")

    def test_campos_nao_confirmados_impedem_a_execucao(self):
        mapa = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "mapeamento.exemplo.json"), encoding="utf-8"))
        with self.assertRaises(ex.MapeamentoInvalido) as e:
            ex.validar(mapa, "assinantes")
        self.assertIn("não confirmados", str(e.exception))
        ruim = json.loads(json.dumps(MAPA))
        ruim["assinantes"]["colunas"]["telefone_inexistente"] = "x"
        with self.assertRaises(ex.MapeamentoInvalido):
            ex.validar(ruim, "assinantes")
        ruim = json.loads(json.dumps(MAPA))
        del ruim["titulos"]["colunas"]["valor"]
        with self.assertRaises(ex.MapeamentoInvalido):
            ex.validar(ruim, "titulos")

    def test_exemplo_tem_todas_as_colunas_do_importador(self):
        mapa = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "mapeamento.exemplo.json"), encoding="utf-8"))
        for tipo in ("assinantes", "titulos"):
            self.assertTrue(set(mapa[tipo]["colunas"]) <= set(ex.COLUNAS[tipo]))
            self.assertTrue(ex.OBRIGATORIAS[tipo] <= set(mapa[tipo]["colunas"]))


if __name__ == "__main__":
    unittest.main()
