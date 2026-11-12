"""LABORATÓRIO VSOL GPON — ciclo autorizar -> ler -> desautorizar -> re-autorizar (restaura) por TELNET REAL.

O emulador devolve o running-config no formato capturado na OLT VSOL real; a ONU criada pela escrita tem que ser
reconhecida pelo parser validado em campo. Prova lógica e transporte; NÃO é homologação do firmware VSOL real.
"""
from nexo_agent.drivers.olt_cli_backup import CliBackupError
from nexo_agent.drivers.olt_vsol import VsolOltDriver
from nexo_agent.drivers.olt_vsol_emulator import VsolCli, VsolState
from tests.lab_olt import LabCase, lab_cred, readonly_cred

SN = "VSOLC0FFEE01"
CFG = dict(pon_port="gpon 0/1", line_profile="default", service_profile="dba_100M", service_vlan=2301)


class LabVsol(LabCase):
    MUTANTES = ("configure terminal", "interface gpon", "onu ", "exit")

    def setUp(self):
        self.state = VsolState()
        self.start(lambda: VsolCli(self.state))
        self.d = VsolOltDriver.from_device(self.device("olt_vsol"), {"olt": lab_cred("V1600G1 (emulado)", "V2.1.6R (emulador NexoISP)")})

    def test_ciclo_completo(self):
        st = self.state
        self.assertFalse(self.d.read_onu(SN).authorized)

        # 1. AUTORIZAR v1 (ONU 2: a 1 é de outro cliente) — as linhas reais de config do VSOL.
        self.commands.clear()
        r = self.d.authorize(SN, description="nexo:0a1b2c3d:v1", **CFG)
        self.assertEqual(r["onu_id"], 2)
        v1 = ["configure terminal", "interface gpon 0/1", f"onu add 2 profile default sn {SN}", "onu 2 tcont 1 dba dba_100M",
              "onu 2 gemport 1 tcont 1 gemport_name gem_1", "onu 2 service srv_1 gemport 1 vlan 2301",
              "onu 2 service-port 1 gemport 1 uservlan 2301 vlan 2301", "onu 2 portvlan eth 1 mode tag vlan 2301",
              "onu 2 desc nexo:0a1b2c3d:v1", "exit", "exit"]
        self.assertEqual(self.muta(), v1)

        # 2. LER pelo parser validado em campo (running-config): autorizada, porta, versão v1.
        s1 = self.d.read_onu(SN)
        self.assertTrue(s1.authorized)
        self.assertEqual((s1.pon_port, s1.applied_version, s1.extra["onuid"]), ("gpon 0/1", 1, 2))
        self.assertEqual(st.onus[("0/1", 2)]["sp"], (2301, 2301), "serviço completo (o cliente navega)")

        # 3. DESAUTORIZAR.
        self.commands.clear()
        self.assertEqual(self.d.deauthorize(SN)["removed"], 1)
        self.assertEqual(self.muta(), ["configure terminal", "interface gpon 0/1", "onu delete 2", "exit", "exit"])
        self.assertIn(("0/1", 1), st.onus, "a ONU de outro cliente não pode ser tocada")
        self.assertFalse(self.d.read_onu(SN).authorized)

        # 4. RE-AUTORIZAR v2 com a MESMA config: mesmos comandos, só a versão muda.
        self.commands.clear()
        self.d.authorize(SN, description="nexo:0a1b2c3d:v2", **CFG)
        self.assertEqual(self.muta(), [c.replace(":v1", ":v2") for c in v1])
        s2 = self.d.read_onu(SN)
        self.assertTrue(s2.authorized)
        self.assertEqual((s2.pon_port, s2.applied_version), (s1.pon_port, 2))

        # 5. Idempotência.
        self.d.deauthorize(SN)
        self.assertEqual(self.d.deauthorize(SN), {"removed": 0})

    def test_travas_e_recusas(self):
        ro = VsolOltDriver.from_device(self.device("olt_vsol"), {"olt": readonly_cred()})
        with self.assertRaises(CliBackupError):
            ro.authorize(SN, description="nexo:0a1b2c3d:v1", **CFG)
        errado = VsolOltDriver.from_device(self.device("olt_vsol"), {"olt": lab_cred("V1600G1 (emulado)", "OUTRO")})
        with self.assertRaises(CliBackupError):
            errado.authorize(SN, description="nexo:0a1b2c3d:v1", **CFG)
        self.assertNotIn(("0/1", 2), self.state.onus, "trava falhou: escreveu sem capacidade aprovada")
        with self.assertRaises(CliBackupError):  # EPON: escrita recusada (sem base de campo)
            self.d.authorize("AA:BB:CC:DD:EE:01", description="nexo:0a1b2c3d:v1", **{**CFG, "pon_port": "epon 0/1"})
        with self.assertRaises(CliBackupError):  # VLAN inexistente: a OLT recusa e o driver propaga
            self.d.authorize(SN, description="nexo:0a1b2c3d:v1", **{**CFG, "service_vlan": 999})
