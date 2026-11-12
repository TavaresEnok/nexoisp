"""LABORATÓRIO Datacom DmOS — ciclo autorizar -> ler -> desautorizar -> re-autorizar (restaura) por TELNET REAL.

Leituras no formato capturado em DmOS real; configuração transacional (commit/abort) como o DmOS. Prova lógica,
transporte e atomicidade; NÃO é homologação do firmware Datacom real.
"""
import copy

from nexo_agent.drivers.olt_datacom import DatacomCommandError, DatacomOltDriver
from nexo_agent.drivers.olt_datacom_emulator import DatacomCli, DatacomState
from tests.lab_olt import LabCase, lab_cred, readonly_cred

SN = "DTCMC0FFEE01"
CFG = dict(pon_port="1/1/1", line_profile="ROUTER_701", service_vlan=100)


class LabDatacom(LabCase):
    MUTANTES = ("config", "interface gpon", "onu ", "no onu", "serial-number", "line-profile", "name ", "exit",
                "service-port", "no service-port", "commit", "abort", "end")

    def setUp(self):
        self.state = DatacomState()
        self.start(lambda: DatacomCli(self.state))
        self.d = DatacomOltDriver.from_device(self.device("olt_datacom"), {"olt": lab_cred("Datacom DmOS", "10.8.0-emulador")})

    def tearDown(self):
        self.d._drop()

    def test_ciclo_completo(self):
        st = self.state
        self.assertFalse(self.d.read_onu(SN).authorized)

        # 1. AUTORIZAR v1 (ONU 1: a 0 é de outro cliente; service-port 2: a 1 já existe).
        self.commands.clear()
        r = self.d.authorize(SN, description="nexo:0a1b2c3d:v1", **CFG)
        self.assertEqual((r["onu_id"], r["service_port"]), (1, 2))
        v1 = ["config", "interface gpon 1/1/1", "onu 1", f"serial-number {SN}", "line-profile ROUTER_701",
              "name nexo:0a1b2c3d:v1", "exit", "exit",
              "service-port 2 gpon 1/1/1 onu 1 gem 1 match vlan vlan-id 100 action vlan replace vlan-id 100", "commit", "end"]
        self.assertEqual(self.muta(), v1)

        # 2. LER pelo parser validado em campo (lista + optical-info): autorizada, online, sinal, versão v1.
        s1 = self.d.read_onu(SN)
        self.assertTrue(s1.authorized and s1.online)
        self.assertEqual((s1.pon_port, s1.applied_version), ("1/1/1", 1))
        self.assertIsNotNone(s1.rx_dbm)
        self.assertIsNotNone(s1.tx_dbm)

        # 3. DESAUTORIZAR: service-port sai ANTES da ONU (o DmOS recusaria referência pendente), numa transação.
        self.commands.clear()
        r = self.d.deauthorize(SN)
        self.assertEqual((r["removed"], r["service_ports_removed"]), (1, 1))
        self.assertEqual(self.muta(), ["config", "no service-port 2", "interface gpon 1/1/1", "no onu 1", "exit", "commit", "end"])
        self.assertIn(("1/1/1", 0), st.cfg["onus"], "a ONU de outro cliente não pode ser tocada")
        self.assertIn(1, st.cfg["sps"], "o service-port de outro cliente não pode ser tocado")
        self.assertFalse(self.d.read_onu(SN).authorized)

        # 4. RE-AUTORIZAR v2 com a MESMA config: mesmos comandos, só a versão muda; cliente volta.
        self.commands.clear()
        self.d.authorize(SN, description="nexo:0a1b2c3d:v2", **CFG)
        self.assertEqual(self.muta(), [c.replace(":v1", ":v2") for c in v1])
        s2 = self.d.read_onu(SN)
        self.assertTrue(s2.authorized and s2.online)
        self.assertEqual((s2.pon_port, s2.applied_version), (s1.pon_port, 2))
        self.assertIsNotNone(s2.rx_dbm)

        # 5. Idempotência.
        self.d.deauthorize(SN)
        self.assertEqual(self.d.deauthorize(SN), {"removed": 0})

    def test_falha_no_commit_nao_deixa_efeito_parcial(self):
        antes = copy.deepcopy(self.state.cfg)
        with self.assertRaises(DatacomCommandError):
            self.d.authorize(SN, description="nexo:0a1b2c3d:v1", **{**CFG, "line_profile": "NAO_EXISTE"})
        self.assertIn("abort", self.commands, "o driver tem que descartar a candidata")
        self.assertEqual(self.state.cfg, antes, "commit recusado não pode deixar nada aplicado")
        # VLAN inexistente: mesmo comportamento.
        with self.assertRaises(DatacomCommandError):
            self.d.authorize(SN, description="nexo:0a1b2c3d:v1", **{**CFG, "service_vlan": 999})
        self.assertEqual(self.state.cfg, antes)

    def test_travas_de_escrita(self):
        ro = DatacomOltDriver.from_device(self.device("olt_datacom"), {"olt": readonly_cred()})
        with self.assertRaises(DatacomCommandError):
            ro.authorize(SN, description="nexo:0a1b2c3d:v1", **CFG)
        errado = DatacomOltDriver.from_device(self.device("olt_datacom"), {"olt": lab_cred("Datacom DmOS", "9.9.9-outro")})
        with self.assertRaises(DatacomCommandError):
            errado.authorize(SN, description="nexo:0a1b2c3d:v1", **CFG)
        errado._drop()
        self.assertNotIn(("1/1/1", 1), self.state.cfg["onus"], "trava falhou: escreveu sem capacidade aprovada")
