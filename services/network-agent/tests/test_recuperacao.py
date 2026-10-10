"""Regressões essenciais do agente: confirmação perdida, reinício e reentrega NÃO causam repetição cega.
Usa o driver de demonstração e uma nuvem falsa em memória (o protocolo real é coberto no teste da API)."""
import base64
import json
import os
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from nexo_agent.drivers.demo import DemoDriver
from nexo_agent.executor import Executor
from nexo_agent.store import Store

KEY = Ed25519PrivateKey.generate()
PUB = base64.b64encode(KEY.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
AGENT, TENANT, DEVICE = "agent-1", "tenant-1", "device-1"


class FakeCloud:
    def __init__(self):
        self.results, self.go, self.fail_result = [], {"go": True, "secret": "s3nha-demo"}, 0

    def begin(self, attempt_id):
        return self.go

    def progress(self, *a):
        return {}

    def result(self, attempt_id, outcome):
        if self.fail_result > 0:
            self.fail_result -= 1
            raise ConnectionError("nuvem indisponível")
        self.results.append((attempt_id, outcome))
        return {"ack": True}


def delivery(action="subscriber.provision", policy="active", version=1, op=None, recover=False, valid_min=60, agent=AGENT, framed_ip=None):
    env = json.dumps({
        "operation_id": op or str(uuid.uuid4()), "tenant_id": TENANT, "resource_id": "res-1", "device_id": DEVICE, "agent_id": agent,
        "action": action, "schema_version": 1, "desired_version": version,
        "parameters": {"username": "cliente01", "profile": "plano-200m", "policy": policy, "secret_ref": None,
                       "suspension": {"mode": "reject", "session": "disconnect"} if policy == "suspended" else None,
                       **({"framed_ip": framed_ip} if framed_ip else {})},
        "idempotency_key": "k", "valid_until": (datetime.now(timezone.utc) + timedelta(minutes=valid_min)).isoformat(),
        "authorization": {"type": "user", "id": "u1"}})
    return {"attempt_id": str(uuid.uuid4()), "recover": recover, "envelope": env, "signature": base64.b64encode(KEY.sign(env.encode())).decode()}


class Recuperacao(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.cloud = FakeCloud()
        self.driver = DemoDriver(os.path.join(self.dir, "nas.sqlite"), DEVICE, reconnect_after_s=0)
        self.new_process()

    def new_process(self):
        """Simula (re)início do agente sobre o mesmo SQLite."""
        self.store = Store(os.path.join(self.dir, "agent.sqlite"))
        ident = {"agent_id": AGENT, "tenant_id": TENANT, "public_key": PUB, "device_ids": {DEVICE}}
        self.ex = Executor(self.store, self.cloud, lambda d: self.driver, lambda: ident)

    def writes(self):
        return self.driver.write_count("cliente01", "authorization")

    def test_confirmacao_perdida_verifica_em_vez_de_repetir(self):
        self.driver.inject("lose_ack", 1)
        self.ex.handle(delivery())
        self.assertEqual(self.cloud.results[-1][1]["outcome"], "SUCCEEDED")
        self.assertEqual(self.writes(), 1)
        self.assertIn("incerto", [s["status"] for s in self.cloud.results[-1][1]["steps"]])

    def test_reinicio_apos_aplicar_sem_relatar_nao_repete(self):
        d = delivery()
        self.cloud.fail_result = 99  # nuvem cai depois do comando aplicado
        self.ex.handle(d)
        self.assertEqual(self.writes(), 1)
        self.assertEqual(self.cloud.results, [])
        self.cloud.fail_result = 0
        self.new_process()
        self.ex.recover_interrupted()
        self.ex.flush_outbox()  # resultado guardado localmente é reenviado
        self.assertEqual([r[1]["outcome"] for r in self.cloud.results], ["SUCCEEDED"])
        self.assertEqual(self.writes(), 1)

    def test_queda_no_meio_da_execucao_consulta_no_reinicio(self):
        d = delivery()
        env = json.loads(d["envelope"])
        from nexo_agent.envelope import Envelope
        e = Envelope.model_validate(env)
        # processo morreu logo após aplicar: tentativa ficou EXECUTING sem resultado
        self.store.record_attempt(d["attempt_id"], e, d["envelope"])
        self.store.set_status(d["attempt_id"], "EXECUTING", [])
        self.driver.apply_authorization("cliente01", secret="x", profile="plano-200m", policy="active", version=1)
        self.new_process()
        self.ex.recover_interrupted()
        self.assertEqual(self.cloud.results[-1][1]["outcome"], "SUCCEEDED")
        self.assertTrue(self.cloud.results[-1][1]["recovered"])
        self.assertEqual(self.writes(), 1)
        # e se o efeito NÃO ocorreu, informa NOT_APPLIED (a nuvem decide se ainda vale repetir)
        d2 = delivery(action="subscriber.suspend", policy="suspended", version=2)
        self.store.record_attempt(d2["attempt_id"], Envelope.model_validate(json.loads(d2["envelope"])), d2["envelope"])
        self.store.set_status(d2["attempt_id"], "EXECUTING", [])
        self.new_process()
        self.ex.recover_interrupted()
        self.assertEqual(self.cloud.results[-1][1]["outcome"], "NOT_APPLIED")
        self.assertEqual(self.driver.read("cliente01").policy, "active")

    def test_reentrega_da_mesma_operacao_reutiliza_evidencia(self):
        op = str(uuid.uuid4())
        self.ex.handle(delivery(op=op))
        self.ex.handle(delivery(op=op, recover=True))
        self.assertEqual([r[1]["outcome"] for r in self.cloud.results], ["SUCCEEDED", "SUCCEEDED"])
        self.assertEqual(self.writes(), 1)

    def test_incerta_entregue_para_recuperacao_consulta_antes(self):
        op = str(uuid.uuid4())
        # efeito aplicado por um executor anterior cujo registro local se perdeu
        self.driver.apply_authorization("cliente01", secret="x", profile="plano-200m", policy="active", version=1)
        self.ex.handle(delivery(op=op, recover=True))
        self.assertEqual(self.cloud.results[-1][1]["outcome"], "SUCCEEDED")
        self.assertEqual(self.writes(), 1)

    def test_intencao_obsoleta_nao_e_aplicada(self):
        self.ex.handle(delivery())
        self.cloud.go = {"go": False, "reason": "superseded"}
        self.ex.handle(delivery(action="subscriber.suspend", policy="suspended", version=2))
        self.assertEqual(self.driver.read("cliente01").policy, "active")
        self.assertEqual(self.writes(), 1)

    def test_suspender_e_reativar_tratam_sessao(self):
        self.ex.handle(delivery())
        self.assertIsNotNone(self.driver.read("cliente01").session)  # CPE simulado conectou
        self.ex.handle(delivery(action="subscriber.suspend", policy="suspended", version=2))
        st = self.driver.read("cliente01")
        self.assertEqual((st.policy, st.session), ("suspended", None))
        self.ex.handle(delivery(action="subscriber.resume", policy="active", version=3))
        self.assertEqual(self.driver.read("cliente01").policy, "active")
        self.assertEqual([r[1]["outcome"] for r in self.cloud.results], ["SUCCEEDED"] * 3)

    def test_downgrade_sobre_banco_local_mais_novo_e_recusado(self):
        self.store.set_kv("schema_version", "99")
        with self.assertRaises(RuntimeError):
            self.new_process()

    def test_envelope_adulterado_vencido_ou_de_outro_agente_e_rejeitado(self):
        d = delivery()
        d["envelope"] = d["envelope"].replace("plano-200m", "plano-1000m")
        self.ex.handle(d)
        self.ex.handle(delivery(valid_min=-1))
        self.ex.handle(delivery(agent="outro-agente"))
        self.assertEqual([r[1]["outcome"] for r in self.cloud.results], ["FAILED"] * 3)
        self.assertEqual(self.writes(), 0)


if __name__ == "__main__":
    unittest.main()
