"""Suspensão por perfil de bloqueio (agente 0.4.0): a conta continua autenticando, mas com o perfil de bloqueio do NAS.
Usa o RADIUS local real em SQLite e um NAS dublê, como test_driver_real."""
import json
import os
import sqlite3
import tempfile
import unittest

from pydantic import ValidationError

from nexo_agent.drivers.mikrotik_radius import MikrotikRadiusDriver, RadiusStore
from nexo_agent.envelope import Suspension
from nexo_agent.executor import Executor
from nexo_agent.store import Store
from tests.test_driver_real import FakeNas
from tests.test_recuperacao import AGENT, DEVICE, PUB, TENANT, FakeCloud, delivery

BLOQ = "nexo-bloqueado"


class SuspensaoPorPerfil(unittest.TestCase):
    def setUp(self):
        d = tempfile.mkdtemp()
        self.path = os.path.join(d, "radius.sqlite")
        db = sqlite3.connect(self.path)
        db.executescript("create table radcheck (id integer primary key, username text, attribute text, op text, value text);"
                         "create table radreply (id integer primary key, username text, attribute text, op text, value text);")
        db.close()
        self.nas, self.cloud = FakeNas(), FakeCloud()
        self.radius = RadiusStore(self.path)
        self.driver = MikrotikRadiusDriver(self.radius, self.nas)
        ident = {"agent_id": AGENT, "tenant_id": TENANT, "public_key": PUB, "device_ids": {DEVICE}}
        self.ex = Executor(Store(os.path.join(d, "agent.sqlite")), self.cloud, lambda _: self.driver, lambda: ident)

    def rows(self, table):
        return sqlite3.connect(self.path).execute(f"select attribute, value from {table} where username = 'cliente01' order by attribute").fetchall()

    def test_ciclo_completo_com_sessao_online(self):
        self.ex.handle(delivery())
        self.nas.online["cliente01"] = {".id": "*1", "name": "cliente01", "address": "100.64.0.9", "uptime": "1h"}
        # suspende por perfil: a sessão com o perfil do plano é derrubada; a autorização continua válida, sem Reject
        op = delivery(action="subscriber.suspend", policy="suspended", version=2, block_profile=BLOQ)
        self.ex.handle(op)
        self.assertEqual(self.cloud.results[-1][1]["outcome"], "SUCCEEDED", self.cloud.results[-1][1])
        self.assertEqual(self.nas.removed, 1)
        self.assertNotIn(("Auth-Type", "Reject"), self.rows("radcheck"))
        self.assertIn(("Mikrotik-Group", BLOQ), self.rows("radreply"))
        st = self.driver.read("cliente01")
        self.assertEqual((st.policy, st.profile), ("suspended", BLOQ))
        # o CPE reconecta já no perfil de bloqueio: reentregar a mesma suspensão não derruba de novo
        self.nas.online["cliente01"] = {".id": "*2", "name": "cliente01", "address": "10.24.0.5", "uptime": "2s"}
        self.nas.removed = 0
        self.ex.handle(delivery(action="subscriber.suspend", policy="suspended", version=2, block_profile=BLOQ,
                                op=json.loads(op["envelope"])["operation_id"]))
        self.assertEqual(self.nas.removed, 0)
        # reativação: a sessão negociada com o perfil de bloqueio cai para renegociar com o do plano
        self.ex.handle(delivery(action="subscriber.resume", policy="active", version=3))
        self.assertEqual(self.cloud.results[-1][1]["outcome"], "SUCCEEDED", self.cloud.results[-1][1])
        self.assertEqual(self.nas.removed, 1)
        self.assertIn(("Mikrotik-Group", "plano-200m"), self.rows("radreply"))
        self.assertEqual(self.driver.read("cliente01").policy, "active")

    def test_troca_manual_do_perfil_aparece_como_ativa(self):
        self.ex.handle(delivery())
        self.ex.handle(delivery(action="subscriber.suspend", policy="suspended", version=2, block_profile=BLOQ))
        self.assertEqual(self.driver.read("cliente01").policy, "suspended")
        sqlite3.connect(self.path).execute("update radreply set value = 'plano-200m' where username = 'cliente01'").connection.commit()
        st = self.driver.read("cliente01")
        self.assertEqual((st.policy, st.profile), ("active", "plano-200m"))   # divergência: a API vê suspensa x ativa

    def test_suspensao_por_rejeicao_continua_igual(self):
        self.ex.handle(delivery())
        self.ex.handle(delivery(action="subscriber.suspend", policy="suspended", version=2))
        self.assertIn(("Auth-Type", "Reject"), self.rows("radcheck"))
        self.assertIn(("Mikrotik-Group", "plano-200m"), self.rows("radreply"))

    def test_schema_do_envelope(self):
        Suspension(mode="profile", session="disconnect", profile=BLOQ)
        with self.assertRaises(ValidationError):
            Suspension(mode="profile", session="disconnect")
        with self.assertRaises(ValidationError):
            Suspension(mode="reject", session="disconnect", profile=BLOQ)
        with self.assertRaises(ValidationError):
            Suspension(mode="profile", session="disconnect", profile="nome com espaço")

    def test_banco_do_radius_anterior_recebe_a_coluna(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "r.sqlite")
        db = sqlite3.connect(p)
        db.executescript("create table radcheck (id integer primary key, username text, attribute text, op text, value text);"
                         "create table radreply (id integer primary key, username text, attribute text, op text, value text);"
                         "create table nexo_accounts (username text primary key, policy text not null, profile text not null, prev_profile text,"
                         " applied_version integer not null, updated_at real not null);"
                         "insert into nexo_accounts values ('antigo','active','plano-200m',null,1,0);")
        db.commit()
        db.close()
        r = RadiusStore(p)
        r.apply("antigo", "x", "plano-200m", "suspended", 2, None, BLOQ)
        self.assertEqual(r.read("antigo")["policy"], "suspended")


if __name__ == "__main__":
    unittest.main()
