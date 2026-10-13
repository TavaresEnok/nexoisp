"""Agente 0.5.0: desconexão pedida (subscriber.disconnect) e atributos opcionais de rede por plano e por NAS."""
import os
import sqlite3
import tempfile
import unittest

from nexo_agent.drivers.demo import DemoDriver
from nexo_agent.drivers.mikrotik_radius import MikrotikRadiusDriver, RadiusStore
from nexo_agent.executor import Executor
from nexo_agent.store import Store
from tests.test_driver_real import FakeNas
from tests.test_recuperacao import AGENT, DEVICE, PUB, TENANT, FakeCloud, delivery

RATE = "100M/50M 120M/60M 80M/40M 10/10"


class Base(unittest.TestCase):
    def setUp(self):
        d = tempfile.mkdtemp()
        self.path = os.path.join(d, "radius.sqlite")
        db = sqlite3.connect(self.path)
        db.executescript("create table radcheck (id integer primary key, username text, attribute text, op text, value text);"
                         "create table radreply (id integer primary key, username text, attribute text, op text, value text);")
        db.close()
        self.nas, self.cloud = FakeNas(), FakeCloud()
        self.driver = MikrotikRadiusDriver(RadiusStore(self.path), self.nas)
        ident = {"agent_id": AGENT, "tenant_id": TENANT, "public_key": PUB, "device_ids": {DEVICE}}
        self.ex = Executor(Store(os.path.join(d, "agent.sqlite")), self.cloud, lambda _: self.driver, lambda: ident)

    def rows(self, table):
        return dict(sqlite3.connect(self.path).execute(f"select attribute, value from {table} where username = 'cliente01'").fetchall())

    def last(self):
        return self.cloud.results[-1][1]


class Desconexao(Base):
    def test_derruba_a_sessao_antiga_sem_mudar_a_autorizacao(self):
        self.ex.handle(delivery())
        self.nas.online["cliente01"] = {"address": "10.0.0.2", "uptime": "2h"}       # sessão anterior à operação
        self.ex.handle(delivery(action="subscriber.disconnect", version=2, extra={"reconnect": True}))
        self.assertEqual(self.last()["outcome"], "SUCCEEDED", self.last())
        self.assertEqual(self.nas.removed, 1)
        st = self.driver.read("cliente01")
        self.assertEqual((st.policy, st.profile, st.applied_version), ("active", "plano-200m", 2))
        self.assertNotIn("Auth-Type", self.rows("radcheck"))                       # continua podendo reconectar

    def test_sem_sessao_conclui_sem_comando_no_nas(self):
        self.ex.handle(delivery())
        self.ex.handle(delivery(action="subscriber.disconnect", version=2, extra={"reconnect": True}))
        self.assertEqual(self.last()["outcome"], "SUCCEEDED", self.last())
        self.assertEqual(self.nas.removed, 0)

    def test_nas_fora_do_ar_nao_e_dado_como_concluido(self):
        self.ex.handle(delivery())
        self.nas.down = True
        self.ex.handle(delivery(action="subscriber.disconnect", version=2, extra={"reconnect": True}))
        self.assertNotEqual(self.last()["outcome"], "SUCCEEDED")

    def test_reconnect_so_vale_na_acao_de_desconexao(self):
        self.ex.handle(delivery(extra={"reconnect": True}))
        self.assertEqual(self.last()["outcome"], "FAILED")
        self.ex.handle(delivery(action="subscriber.disconnect", version=2))
        self.assertEqual(self.last()["outcome"], "FAILED")
        self.assertIn("envelope rejeitado", self.last()["error"])

    def test_driver_de_demonstracao(self):
        d = tempfile.mkdtemp()
        demo = DemoDriver(os.path.join(d, "nas.sqlite"), DEVICE, reconnect_after_s=3600)
        ident = {"agent_id": AGENT, "tenant_id": TENANT, "public_key": PUB, "device_ids": {DEVICE}}
        ex = Executor(Store(os.path.join(d, "agent.sqlite")), self.cloud, lambda _: demo, lambda: ident)
        ex.handle(delivery())
        demo._db.execute("insert or replace into sessions values (?,?,?,?,?)", (DEVICE, "cliente01", "100.64.0.9", "plano-200m", 1.0))   # sessão antiga
        ex.handle(delivery(action="subscriber.disconnect", version=2, extra={"reconnect": True}))
        self.assertEqual(self.last()["outcome"], "SUCCEEDED", self.last())
        self.assertEqual(demo.write_count("cliente01", "disconnect"), 1)


class AtributosDeRede(Base):
    EXTRA = {"rate_limit": RATE, "address_pool": "pool-clientes", "simultaneous_use": 1, "acct_interim": 300}

    def test_grava_le_e_remove(self):
        self.ex.handle(delivery(extra=self.EXTRA))
        self.assertEqual(self.last()["outcome"], "SUCCEEDED", self.last())
        rep, chk = self.rows("radreply"), self.rows("radcheck")
        self.assertEqual((rep["Mikrotik-Rate-Limit"], rep["Framed-Pool"], rep["Acct-Interim-Interval"]), (RATE, "pool-clientes", "300"))
        self.assertEqual(chk["Simultaneous-Use"], "1")
        self.assertEqual(self.driver.read("cliente01").attrs, self.EXTRA)
        # intenção sem os atributos: saem do RADIUS (volta a valer o perfil do NAS)
        self.ex.handle(delivery(version=2))
        self.assertEqual(self.last()["outcome"], "SUCCEEDED", self.last())
        self.assertNotIn("Mikrotik-Rate-Limit", self.rows("radreply"))
        self.assertNotIn("Simultaneous-Use", self.rows("radcheck"))
        self.assertEqual(self.driver.read("cliente01").attrs, {})

    def test_suspensa_por_perfil_nao_recebe_velocidade_nem_pool_do_plano(self):
        self.ex.handle(delivery(extra=self.EXTRA))
        self.ex.handle(delivery(action="subscriber.suspend", policy="suspended", version=2, block_profile="bloqueio", extra=self.EXTRA))
        self.assertEqual(self.last()["outcome"], "SUCCEEDED", self.last())
        rep = self.rows("radreply")
        self.assertEqual(rep["Mikrotik-Group"], "bloqueio")
        self.assertNotIn("Mikrotik-Rate-Limit", rep)
        self.assertNotIn("Framed-Pool", rep)
        self.assertEqual(rep["Acct-Interim-Interval"], "300")                      # o do NAS continua valendo

    def test_valores_fora_do_formato_sao_recusados(self):
        for bad in ({"rate_limit": "rapido"}, {"rate_limit": "100M/50M; /tool fetch"}, {"address_pool": "pool com espaço"}, {"simultaneous_use": 0}, {"acct_interim": 5}):
            self.ex.handle(delivery(extra=bad))
            self.assertEqual(self.last()["outcome"], "FAILED", bad)
            self.assertIn("envelope rejeitado", self.last()["error"])


if __name__ == "__main__":
    unittest.main()
