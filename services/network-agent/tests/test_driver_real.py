"""Driver mikrotik_radius: autorização local real em SQLite; a API do NAS é substituída por um dublê.
(A resposta do FreeRADIUS é provada em scripts/lab-radius.sh; sessão PPPoE real, só no laboratório com CHR.)"""
import os
import sqlite3
import tempfile
import unittest

from nexo_agent.drivers.mikrotik_radius import MikrotikRadiusDriver, RadiusStore, uptime_seconds
from nexo_agent.executor import Executor
from nexo_agent.store import Store
from tests.test_recuperacao import AGENT, DEVICE, PUB, TENANT, FakeCloud, delivery


class FakeNas:
    def __init__(self):
        self.online, self.down, self.removed = {}, False, 0

    def find(self, username):
        if self.down:
            raise ConnectionError("NAS inacessível")
        return [self.online[username]] if username in self.online else []

    def remove(self, username):
        if self.down:
            raise ConnectionError("NAS inacessível")
        self.removed += 1
        return 1 if self.online.pop(username, None) else 0


class DriverReal(unittest.TestCase):
    def setUp(self):
        d = tempfile.mkdtemp()
        db = sqlite3.connect(os.path.join(d, "radius.sqlite"))
        db.executescript("create table radcheck (id integer primary key, username text, attribute text, op text, value text);"
                         "create table radreply (id integer primary key, username text, attribute text, op text, value text);")
        db.close()
        self.nas, self.cloud = FakeNas(), FakeCloud()
        self.radius = RadiusStore(os.path.join(d, "radius.sqlite"))
        self.driver = MikrotikRadiusDriver(self.radius, self.nas)
        ident = {"agent_id": AGENT, "tenant_id": TENANT, "public_key": PUB, "device_ids": {DEVICE}}
        self.ex = Executor(Store(os.path.join(d, "agent.sqlite")), self.cloud, lambda _: self.driver, lambda: ident)

    def test_ciclo_e_nas_indisponivel(self):
        self.ex.handle(delivery())
        self.assertEqual(self.cloud.results[-1][1]["outcome"], "SUCCEEDED")  # sem cliente online: autorização liberada basta
        self.nas.online["cliente01"] = {".id": "*1", "name": "cliente01", "address": "100.64.0.9", "uptime": "1h2m3s"}
        # NAS fora do ar: a autorização local muda, mas a suspensão NÃO é dada como concluída
        self.nas.down = True
        op = delivery(action="subscriber.suspend", policy="suspended", version=2)
        self.ex.handle(op)
        self.assertEqual(self.cloud.results[-1][1]["outcome"], "FAILED")
        self.assertEqual(self.radius.read("cliente01")["policy"], "suspended")
        # nova tentativa com NAS de volta: não regrava a autorização, só trata a sessão e verifica
        self.nas.down = False
        self.ex.handle(delivery(action="subscriber.suspend", policy="suspended", version=2, op=__import__("json").loads(op["envelope"])["operation_id"]))
        out = self.cloud.results[-1][1]
        self.assertEqual(out["outcome"], "SUCCEEDED")
        self.assertIn("já aplicada nesta versão", str(out["steps"]))
        self.assertEqual((self.nas.removed, self.nas.online), (1, {}))

    def test_edicao_manual_no_radius_e_detectada_na_leitura(self):
        self.ex.handle(delivery())
        self.radius._db.execute("insert into radcheck (username, attribute, op, value) values ('cliente01','Auth-Type',':=','Reject')")
        self.assertEqual(self.driver.read("cliente01").policy, "suspended")

    def test_senha_guardada_so_como_hash_nt_e_limpeza(self):
        import sqlite3 as sq
        path = self.radius._db.execute("pragma database_list").fetchone()[2]
        r = RadiusStore(path, "nt_hash")
        r.apply("cliente02", "Senha-Teste", "plano-200m", "active", 1)
        rows = dict(sq.connect(path).execute("select attribute, value from radcheck where username = 'cliente02'").fetchall())
        self.assertEqual(list(rows), ["NT-Password"])
        self.assertRegex(rows["NT-Password"], r"^[0-9A-F]{32}$")
        self.assertNotIn("Senha-Teste", str(rows))
        # vetor conhecido do hash NT: "password" -> 8846F7EAEE8FB117AD06BDD830B7586C
        r.apply("cliente03", "password", "plano-200m", "active", 1)
        self.assertEqual(sq.connect(path).execute("select value from radcheck where username='cliente03' and attribute='NT-Password'").fetchone()[0], "8846F7EAEE8FB117AD06BDD830B7586C")
        self.assertEqual(r.read("cliente02")["policy"], "active")
        r.apply("cliente02", None, "plano-200m", "suspended", 2)   # suspender não exige o segredo de novo
        self.assertEqual(r.read("cliente02")["policy"], "suspended")
        self.assertEqual(r.cleanup(), 0)

    def test_uptime(self):
        self.assertEqual(uptime_seconds("1d2h3m4s"), 93784)
        self.assertEqual(uptime_seconds("45s"), 45)
        self.assertIsNone(uptime_seconds("?"))


if __name__ == "__main__":
    unittest.main()


class VerificacaoDaSessao(unittest.TestCase):
    """A operação só conclui quando a sessão em uso também reflete a intenção — para liberar/trocar plano, não só para suspender."""

    def setUp(self):
        import nexo_agent.executor as ex
        ex.SESSION_SETTLE_S = 0.01
        d = tempfile.mkdtemp()
        db = sqlite3.connect(os.path.join(d, "radius.sqlite"))
        db.executescript("create table radcheck (id integer primary key, username text, attribute text, op text, value text);"
                         "create table radreply (id integer primary key, username text, attribute text, op text, value text);")
        db.close()
        self.nas, self.cloud = FakeNas(), FakeCloud()
        self.radius = RadiusStore(os.path.join(d, "radius.sqlite"))
        self.driver = MikrotikRadiusDriver(self.radius, self.nas)
        ident = {"agent_id": AGENT, "tenant_id": TENANT, "public_key": PUB, "device_ids": {DEVICE}}
        self.ex = Executor(Store(os.path.join(d, "agent.sqlite")), self.cloud, lambda _: self.driver, lambda: ident)

    def plano(self, version, profile, op=None):
        import json
        d = delivery(version=version, op=op)
        env = json.loads(d["envelope"]); env["parameters"]["profile"] = profile
        from tests.test_recuperacao import KEY
        import base64
        d["envelope"] = json.dumps(env); d["signature"] = base64.b64encode(KEY.sign(d["envelope"].encode())).decode()
        return d

    def outcome(self):
        return self.cloud.results[-1][1]["outcome"]

    def test_troca_de_plano_nao_conclui_enquanto_a_sessao_continua_no_perfil_antigo(self):
        self.ex.handle(delivery())
        self.nas.online["cliente01"] = {".id": "*1", "name": "cliente01", "address": "100.64.0.9", "uptime": "1h"}
        self.nas.remove = lambda username: 0          # o NAS responde, mas a sessão continua lá
        op = self.plano(2, "plano-500m")
        self.ex.handle(op)
        self.assertEqual(self.outcome(), "FAILED")    # antes era dada como concluída só com a autorização local certa
        self.assertEqual(self.radius.read("cliente01")["profile"], "plano-500m")
        del self.nas.remove                            # NAS volta a derrubar a sessão
        import json
        self.ex.handle(self.plano(2, "plano-500m", op=json.loads(op["envelope"])["operation_id"]))
        out = self.cloud.results[-1][1]
        self.assertEqual(out["outcome"], "SUCCEEDED")
        self.assertIn("já aplicada nesta versão", str(out["steps"]))   # não regravou a autorização: só tratou a sessão
        self.assertEqual(self.nas.online, {})

    def test_sessao_desconhecida_nao_e_tratada_como_sessao_inexistente(self):
        self.nas.down = True
        self.ex.handle(delivery())                    # conta nova: não pode haver sessão antiga; a autorização basta
        self.assertEqual(self.outcome(), "SUCCEEDED")
        op = self.plano(2, "plano-500m")              # conta existente + NAS sem resposta: não dá para afirmar que a sessão mudou
        self.ex.handle(op)
        self.assertEqual(self.outcome(), "FAILED")
        self.assertIn("desconhecida", str(self.cloud.results[-1][1]["steps"]))
        self.nas.down = False
        import json
        self.ex.handle(self.plano(2, "plano-500m", op=json.loads(op["envelope"])["operation_id"]))
        self.assertEqual(self.outcome(), "SUCCEEDED")   # sem cliente online de verdade: agora se sabe que não há sessão


class IpFixo(unittest.TestCase):
    """Framed-IP-Address: gravado junto da autorização, lido de volta e removido quando a intenção deixa de trazê-lo."""

    def setUp(self):
        d = tempfile.mkdtemp()
        db = sqlite3.connect(os.path.join(d, "radius.sqlite"))
        db.executescript("create table radcheck (id integer primary key, username text, attribute text, op text, value text);"
                         "create table radreply (id integer primary key, username text, attribute text, op text, value text);")
        db.close()
        self.path = os.path.join(d, "radius.sqlite")
        self.nas, self.cloud = FakeNas(), FakeCloud()
        self.driver = MikrotikRadiusDriver(RadiusStore(self.path), self.nas)
        ident = {"agent_id": AGENT, "tenant_id": TENANT, "public_key": PUB, "device_ids": {DEVICE}}
        self.ex = Executor(Store(os.path.join(d, "agent.sqlite")), self.cloud, lambda _id: self.driver, lambda: ident)

    def reply(self):
        db = sqlite3.connect(self.path)
        return dict(db.execute("select attribute, value from radreply where username = 'cliente01'").fetchall())

    def test_ip_fixo_aplicado_verificado_e_removido(self):
        self.cloud.go["secret"] = "s3nh4"
        self.ex.handle(delivery("subscriber.provision", version=1, framed_ip="100.64.0.5"))
        self.assertEqual(self.cloud.results[-1][1]["outcome"], "SUCCEEDED")
        self.assertEqual(self.reply(), {"Mikrotik-Group": "plano-200m", "Framed-IP-Address": "100.64.0.5"})
        self.assertEqual(self.driver.read("cliente01").framed_ip, "100.64.0.5")

        # sessão online com o endereço antigo é derrubada para reconectar com o fixo
        self.nas.online["cliente01"] = {"name": "cliente01", "address": "100.64.0.200", "uptime": "1m"}
        self.ex.handle(delivery("subscriber.resume", version=2, policy="active", framed_ip="100.64.0.9"))
        self.assertEqual(self.reply()["Framed-IP-Address"], "100.64.0.9")
        self.assertEqual(self.nas.removed, 1)

        # suspender mantém o endereço; liberar o IP (intenção sem o campo) remove o atributo
        self.ex.handle(delivery("subscriber.suspend", version=3, policy="suspended", framed_ip="100.64.0.9"))
        self.assertEqual(self.reply()["Framed-IP-Address"], "100.64.0.9")
        self.ex.handle(delivery("subscriber.resume", version=4, policy="active"))
        self.assertEqual(self.cloud.results[-1][1]["outcome"], "SUCCEEDED")
        self.assertNotIn("Framed-IP-Address", self.reply())
        self.assertIsNone(self.driver.read("cliente01").framed_ip)

    def test_endereco_invalido_e_recusado_pelo_schema(self):
        self.ex.handle(delivery("subscriber.provision", version=1, framed_ip="100.64.0.5; drop"))
        self.assertNotEqual(self.cloud.results[-1][1]["outcome"], "SUCCEEDED")
        self.assertEqual(self.reply(), {})
