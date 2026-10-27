"""Expansão OLT/ONU: as mesmas garantias do PPPoE valem para ONUs (driver de OLT simulado)."""
import base64
import json
import os
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone

from nexo_agent.drivers.olt_demo import DemoOltDriver
from nexo_agent.envelope import Envelope
from nexo_agent.executor import Executor
from nexo_agent.store import Store
from tests.test_recuperacao import AGENT, DEVICE, KEY, PUB, TENANT, FakeCloud

SERIAL, ONU = "FHTT1A2B3C4D", "0a1b2c3d-0000-4000-8000-000000000001"


def onu_delivery(action="onu.authorize", version=1, op=None, recover=False, vlan=100, profile="residencial", port="0/1/1"):
    state = "authorized" if action == "onu.authorize" else "removed"
    env = json.dumps({
        "operation_id": op or str(uuid.uuid4()), "tenant_id": TENANT, "resource_id": ONU, "device_id": DEVICE, "agent_id": AGENT,
        "action": action, "schema_version": 1, "desired_version": version,
        "parameters": {"serial": SERIAL, "pon_port": port, "line_profile": profile, "service_vlan": vlan, "state": state, "description": f"nexo:{ONU[:8]}:v{version}"},
        "idempotency_key": "k", "valid_until": (datetime.now(timezone.utc) + timedelta(minutes=60)).isoformat(), "authorization": {"type": "user", "id": "u1"}})
    return {"attempt_id": str(uuid.uuid4()), "recover": recover, "envelope": env, "signature": base64.b64encode(KEY.sign(env.encode())).decode()}


class Onu(unittest.TestCase):
    def test_resultado_olt_interrompido_nao_libera_nova_escrita_por_leitura_negativa(self):
        delivery = onu_delivery()
        env = Envelope.model_validate(json.loads(delivery["envelope"]))
        self.store.record_attempt(delivery["attempt_id"], env, delivery["envelope"])
        self.store.set_status(delivery["attempt_id"], "EXECUTING", [])
        self.ex.recover_interrupted()
        self.assertEqual(self.cloud.results, [])
        self.assertEqual(len(self.store.interrupted()), 1)
        self.ex.handle(onu_delivery(op=env.operation_id, recover=True))
        self.assertEqual(self.olt.write_count(SERIAL, "authorize"), 0)
        self.assertEqual(self.cloud.results, [])
        self.ex.handle(onu_delivery(version=2))
        self.assertEqual(self.cloud.results[-1][1]["outcome"], "FAILED")
        self.assertIn("anterior", self.cloud.results[-1][1]["error"])
        self.assertEqual(self.olt.write_count(SERIAL, "authorize"), 0)
        self.cloud.results.clear()
        # A late effect can still be confirmed, without another mutation.
        self.olt.authorize(SERIAL, pon_port="0/1/1", line_profile="residencial", service_vlan=100, description=f"nexo:{ONU[:8]}:v1")
        self.ex.recover_interrupted()
        self.assertTrue(all(r[1]["outcome"] == "SUCCEEDED" for r in self.cloud.results))
        self.assertEqual(self.olt.write_count(SERIAL, "authorize"), 1)

    def test_onu_de_outro_recurso_nao_e_adotada_ou_removida(self):
        self.olt.authorize(SERIAL, pon_port="0/1/1", line_profile="residencial", service_vlan=100, description="nexo:ffffffff:v1")
        self.ex.handle(onu_delivery())
        self.assertEqual(self.cloud.results[-1][1]["outcome"], "FAILED")
        self.assertEqual(self.olt.read_onu(SERIAL).description, "nexo:ffffffff:v1")
        self.assertEqual(self.olt.write_count(SERIAL, "authorize"), 1)
        self.assertEqual(self.olt.write_count(SERIAL, "deauthorize"), 0)

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.cloud = FakeCloud()
        self.cloud.go = {"go": True}
        self.olt = DemoOltDriver(os.path.join(self.dir, "olt.sqlite"), DEVICE)
        self.new_process()

    def new_process(self):
        self.store = Store(os.path.join(self.dir, "agent.sqlite"))
        ident = {"agent_id": AGENT, "tenant_id": TENANT, "public_key": PUB, "device_ids": {DEVICE}}
        self.ex = Executor(self.store, self.cloud, lambda d: self.olt, lambda: ident)

    def last(self):
        return self.cloud.results[-1][1]

    def test_descobre_autoriza_le_sinal_e_desautoriza(self):
        self.assertIn(SERIAL, [u["serial"] for u in self.olt.discover()])
        self.ex.handle(onu_delivery())
        out = self.last()
        self.assertEqual(out["outcome"], "SUCCEEDED")
        self.assertEqual(out["onu_observed"]["state"], "authorized")
        self.assertTrue(out["onu_observed"]["online"])
        self.assertLess(out["onu_observed"]["rx_dbm"], 0)
        self.assertNotIn(SERIAL, [u["serial"] for u in self.olt.discover()])       # saiu da lista de pendentes
        self.assertEqual(self.store.onus()[0]["serial"], SERIAL)
        self.ex.handle(onu_delivery("onu.deauthorize", version=2))
        self.assertEqual(self.last()["onu_observed"]["state"], "absent")
        self.assertIn(SERIAL, [u["serial"] for u in self.olt.discover()])          # volta a aguardar autorização

    def test_confirmacao_perdida_e_reentrega_nao_repetem_a_autorizacao(self):
        self.olt.inject("lose_ack", 1)
        op = str(uuid.uuid4())
        self.ex.handle(onu_delivery(op=op))
        self.assertEqual(self.last()["outcome"], "SUCCEEDED")
        self.ex.handle(onu_delivery(op=op, recover=True))
        self.assertEqual(self.olt.write_count(SERIAL, "authorize"), 1)

    def test_reinicio_no_meio_consulta_antes_de_repetir(self):
        d = onu_delivery()
        self.store.record_attempt(d["attempt_id"], Envelope.model_validate(json.loads(d["envelope"])), d["envelope"])
        self.store.set_status(d["attempt_id"], "EXECUTING", [])
        self.olt.authorize(SERIAL, pon_port="0/1/1", line_profile="residencial", service_vlan=100, description=f"nexo:{ONU[:8]}:v1")
        self.new_process()
        self.ex.recover_interrupted()
        self.assertEqual((self.last()["outcome"], self.last()["recovered"]), ("SUCCEEDED", True))
        self.assertEqual(self.olt.write_count(SERIAL, "authorize"), 1)

    def test_mudanca_de_vlan_reconfigura_e_obsoleta_nao_aplica(self):
        self.ex.handle(onu_delivery())
        self.ex.handle(onu_delivery(version=2, vlan=200))
        st = self.olt.read_onu(SERIAL)
        self.assertEqual((st.service_vlan, st.applied_version), (200, 2))
        self.cloud.go = {"go": False, "reason": "superseded"}
        self.ex.handle(onu_delivery("onu.deauthorize", version=3))
        self.assertTrue(self.olt.read_onu(SERIAL).authorized)

    def test_porta_errada_e_driver_incompativel_falham_sem_efeito(self):
        self.ex.handle(onu_delivery(port="0/9/9"))
        self.assertEqual(self.last()["outcome"], "FAILED")
        self.assertFalse(self.olt.read_onu(SERIAL).authorized)
        # operação de ONU entregue a um equipamento que não é OLT
        from nexo_agent.drivers.demo import DemoDriver
        self.olt = DemoDriver(os.path.join(self.dir, "nas.sqlite"), DEVICE)
        self.ex.handle(onu_delivery())
        self.assertIn("incompatível", self.last()["error"])


if __name__ == "__main__":
    unittest.main()
