"""LABORATÓRIO FiberHome AN5516 — ciclo autorizar -> ler -> desautorizar -> re-autorizar (restaura) por TELNET REAL.

Leituras (tabela de autorização e opticalpower-info) no formato capturado em AN5516 real; a ONU autorizada tem que
ser reconhecida pelos parsers validados em campo. Prova lógica e transporte; NÃO é homologação do firmware real.
Limite real documentado: a whitelist FiberHome não tem descrição -> não há marcador de versão no equipamento.
"""
from nexo_agent.drivers.olt_cli_backup import CliBackupError
from nexo_agent.drivers.olt_fiberhome import FiberHomeOltDriver
from nexo_agent.drivers.olt_fiberhome_emulator import FiberHomeCli, FiberHomeState
from tests.lab_olt import LabCase, lab_cred, readonly_cred

SN = "FHTTC0FFEE01"
CFG = dict(pon_port="1/1", line_profile="default", service_profile="5506-01-A1", service_vlan=1001)


class LabFiberHome(LabCase):
    MUTANTES = ("cd ", "set whitelist", "set epon", "apply onu")

    def setUp(self):
        self.state = FiberHomeState()
        self.start(lambda: FiberHomeCli(self.state))
        self.d = FiberHomeOltDriver.from_device(self.device("olt_fiberhome"), {"olt": lab_cred("AN5516-06 (emulado)", "RP1000 (emulador NexoISP)")})

    def test_ciclo_completo(self):
        st = self.state
        self.assertIn(SN, [o["serial"] for o in self.d.discover()])
        self.assertFalse(self.d.read_onu(SN).authorized)

        # 1. AUTORIZAR (ONU 2: a 1 é de outro cliente) — whitelist + VLAN na árvore lan.
        self.commands.clear()
        r = self.d.authorize(SN, description="nexo:0a1b2c3d:v1", **CFG)
        self.assertEqual(r["onu_id"], 2)
        v1 = ["cd onu", f"set whitelist phy_addr address {SN} password null action add slot 1 pon 1 onu 2 type 5506-01-A1",
              "cd lan", "set epon slot 1 pon 1 onu 2 port 1 service number 1",
              "set epon slot 1 pon 1 onu 2 port 1 service 1 vlan_mode tag 0 33024 1001", "apply onu 1 1 2 vlan", "cd .."]
        self.assertEqual(self.muta(), v1)
        self.assertEqual((st.auth[SN]["vlan"], st.auth[SN]["applied"]), (1001, True), "serviço aplicado (o cliente navega)")

        # 2. LER pelos parsers validados em campo: autorizada, online, sinal. Sem marcador de versão (limite do FiberHome).
        s1 = self.d.read_onu(SN)
        self.assertTrue(s1.authorized and s1.online)
        self.assertEqual(s1.pon_port, "1/1")
        self.assertIsNotNone(s1.rx_dbm)
        self.assertIsNotNone(s1.tx_dbm)
        self.assertIsNone(s1.applied_version)

        # 3. DESAUTORIZAR (remove só esta ONU; ela volta à descoberta).
        self.commands.clear()
        self.assertEqual(self.d.deauthorize(SN)["removed"], 1)
        self.assertEqual(self.muta(), ["cd onu", f"set whitelist phy_addr address {SN} password null action delete slot 1 pon 1 onu 2 type 5506-01-A1"])
        self.assertIn("FHTT00000001", st.auth, "a ONU de outro cliente não pode ser tocada")
        self.assertFalse(self.d.read_onu(SN).authorized)
        self.assertIn(SN, [o["serial"] for o in self.d.discover()])

        # 4. RE-AUTORIZAR com a MESMA config: comandos idênticos; cliente volta a navegar.
        self.commands.clear()
        self.d.authorize(SN, description="nexo:0a1b2c3d:v2", **CFG)
        self.assertEqual(self.muta(), v1)
        s2 = self.d.read_onu(SN)
        self.assertTrue(s2.authorized and s2.online)
        self.assertEqual(s2.pon_port, s1.pon_port)
        self.assertEqual((st.auth[SN]["vlan"], st.auth[SN]["applied"]), (1001, True))

        # 5. Idempotência.
        self.d.deauthorize(SN)
        self.assertEqual(self.d.deauthorize(SN), {"removed": 0})

    def test_travas_e_efeito_parcial(self):
        ro = FiberHomeOltDriver.from_device(self.device("olt_fiberhome"), {"olt": readonly_cred()})
        with self.assertRaises(CliBackupError):
            ro.authorize(SN, description="nexo:0a1b2c3d:v1", **CFG)
        errado = FiberHomeOltDriver.from_device(self.device("olt_fiberhome"), {"olt": lab_cred("AN5516-06 (emulado)", "OUTRO")})
        with self.assertRaises(CliBackupError):
            errado.authorize(SN, description="nexo:0a1b2c3d:v1", **CFG)
        self.assertNotIn(SN, self.state.auth, "trava falhou: escreveu sem capacidade aprovada")
        # VLAN inexistente: o FiberHome NÃO é transacional — a whitelist entra e a VLAN falha. O driver propaga o erro e
        # o efeito parcial fica visível (ONU autorizada sem serviço) para o executor consultar e convergir.
        with self.assertRaises(CliBackupError):
            self.d.authorize(SN, description="nexo:0a1b2c3d:v1", **{**CFG, "service_vlan": 999})
        self.assertIn(SN, self.state.auth)
        self.assertIsNone(self.state.auth[SN]["vlan"])
