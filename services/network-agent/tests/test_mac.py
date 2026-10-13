"""Vínculo de MAC à conta PPPoE (agente 0.4.0): comparação gravada no RADIUS local e conferida na leitura."""
import os
import sqlite3
import tempfile
import unittest

from nexo_agent.drivers.mikrotik_radius import MikrotikRadiusDriver, RadiusStore
from nexo_agent.executor import Executor
from nexo_agent.store import Store
from tests.test_driver_real import FakeNas
from tests.test_recuperacao import AGENT, DEVICE, PUB, TENANT, FakeCloud, delivery

MAC = "02:4E:58:00:00:02"


class VinculoDeMac(unittest.TestCase):
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

    def checks(self):
        return sqlite3.connect(self.path).execute("select attribute, op, value from radcheck where username = 'cliente01' and attribute = 'Calling-Station-Id'").fetchall()

    def test_vincula_troca_e_remove(self):
        self.ex.handle(delivery(mac=MAC))
        self.assertEqual(self.cloud.results[-1][1]["outcome"], "SUCCEEDED", self.cloud.results[-1][1])
        self.assertEqual(self.checks(), [("Calling-Station-Id", "==", MAC)])
        self.assertEqual(self.driver.read("cliente01").mac, MAC)
        # troca de equipamento: uma única linha, com o MAC novo
        novo = "02:4E:58:00:00:09"
        self.ex.handle(delivery(action="subscriber.provision", version=2, mac=novo))
        self.assertEqual(self.checks(), [("Calling-Station-Id", "==", novo)])
        # sem MAC na intenção: o vínculo é removido (e a mudança conta como intenção ainda não aplicada)
        self.ex.handle(delivery(action="subscriber.provision", version=3))
        self.assertEqual(self.checks(), [])
        self.assertIsNone(self.driver.read("cliente01").mac)

    def test_mac_fora_do_formato_e_recusado_pelo_envelope(self):
        self.ex.handle(delivery(mac="aa-bb-cc-dd-ee-ff"))
        self.assertEqual(self.cloud.results[-1][1]["outcome"], "FAILED")
        self.assertIn("envelope rejeitado", self.cloud.results[-1][1]["error"])


if __name__ == "__main__":
    unittest.main()
