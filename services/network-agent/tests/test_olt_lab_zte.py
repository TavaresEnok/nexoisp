"""LABORATÓRIO ZTE — ciclo completo autorizar -> ler -> desautorizar -> re-autorizar (restaura) por TELNET REAL.

O emulador responde às leituras no formato capturado em OLT ZTE real; a ONU autorizada tem que ser reconhecida pelos
parsers validados em campo. Prova lógica e transporte; NÃO é homologação do firmware ZTE real.
"""
from nexo_agent.drivers.olt_zte import ZteCommandError, ZteOltDriver
from nexo_agent.drivers.olt_zte_emulator import ZteCli, ZteState
from tests.lab_olt import LabCase, lab_cred, readonly_cred

SN = "ZTEGC0FFEE01"  # está no 'uncfg' semeado, porta 1/1/1 (o ID 1 já é de outro cliente)
CFG = dict(pon_port="1/1/1", line_profile="T1-100M", service_profile="ZTE-F660", service_vlan=100)


class _Base(LabCase):
    STYLE = "xgspon"
    MUTANTES = ("configure terminal", "interface ", "onu ", "no onu", "description", "tcont", "gemport", "service-port",
                "pon-onu-mng", "service internet", "vlan port", "exit", "end")

    def setUp(self):
        self.state = ZteState(style=self.STYLE)
        self.start(lambda: ZteCli(self.state))
        product, firmware = (("ZXA10 C600 (emulado)", "V1.2.1 (emulador NexoISP)") if self.STYLE == "xgspon"
                             else ("ZXA10 C300 (emulado)", "V2.1.0 (emulador NexoISP)"))
        self.d = ZteOltDriver.from_device(self.device("olt_zte"), {"olt": lab_cred(product, firmware)})

    def tearDown(self):
        self.d._drop()

    def ciclo(self):
        st, onu = self.state, self.state.onu_pfx
        olt = self.state.olt_pfx
        # 0. Descoberta: a ONU nova aparece no uncfg; a de outro cliente segue intacta.
        self.assertIn(SN, [o["serial"] for o in self.d.discover()])
        self.assertFalse(self.d.read_onu(SN).authorized)

        # 1. AUTORIZAR v1 — sequência exata que chegou à OLT (ID 2: o 1 já é de outro cliente).
        self.commands.clear()
        r = self.d.authorize(SN, description="nexo:0a1b2c3d:v1", **CFG)
        self.assertEqual(r["onu_id"], 2)
        entra_pon = ([f"interface {olt}1/1/1"] if self.STYLE == "xgspon"
                     else ["interface gpon_olt-1/1/1", f"interface {olt}1/1/1"])  # C300 recusa o 1º formato
        v1 = (["configure terminal"] + entra_pon + [
            f"onu 2 type ZTE-F660 sn {SN}", "exit", f"interface {onu}1/1/1:2", "description nexo:0a1b2c3d:v1",
            "tcont 1 profile T1-100M", "gemport 1 tcont 1", "service-port 1 vport 1 user-vlan 100 vlan 100", "exit",
            f"pon-onu-mng {onu}1/1/1:2", "service internet gemport 1 vlan 100", "vlan port eth_0/1 mode tag vlan 100",
            "exit", "end"])
        self.assertEqual(self.muta(), v1)
        self.assertEqual(st.onus["1/1/1:2"]["sp"], (100, 100))

        # 2. LER pelo parser validado em campo: autorizada, online, sinal, versão v1.
        s1 = self.d.read_onu(SN)
        self.assertTrue(s1.authorized and s1.online)
        self.assertEqual((s1.pon_port, s1.applied_version), ("1/1/1", 1))
        self.assertIsNotNone(s1.rx_dbm)
        self.assertIsNotNone(s1.tx_dbm)

        # 3. DESAUTORIZAR (confere identidade antes; remove só esta ONU).
        self.commands.clear()
        self.assertEqual(self.d.deauthorize(SN)["removed"], 1)
        self.assertEqual(self.muta(), ["configure terminal"] + entra_pon + ["no onu 2", "exit", "end"])
        self.assertIn("1/1/1:1", st.onus, "a ONU de outro cliente não pode ser tocada")
        self.assertFalse(self.d.read_onu(SN).authorized)
        self.assertIn(SN, [o["serial"] for o in self.d.discover()])

        # 4. RE-AUTORIZAR v2 com a MESMA config: mesmos comandos, só a versão muda; cliente volta.
        self.commands.clear()
        self.d.authorize(SN, description="nexo:0a1b2c3d:v2", **CFG)
        self.assertEqual(self.muta(), [c.replace(":v1", ":v2") for c in v1])
        s2 = self.d.read_onu(SN)
        self.assertTrue(s2.authorized and s2.online)
        self.assertEqual((s2.pon_port, s2.applied_version), (s1.pon_port, 2))
        self.assertIsNotNone(s2.rx_dbm)

        # 5. Idempotência: desautorizar duas vezes não reenvia comando destrutivo.
        self.d.deauthorize(SN)
        self.commands.clear()
        self.assertEqual(self.d.deauthorize(SN), {"removed": 0})
        self.assertNotIn("no onu 2", self.commands)

    def travas(self):
        ro = ZteOltDriver.from_device(self.device("olt_zte"), {"olt": readonly_cred()})
        with self.assertRaises(ZteCommandError):
            ro.authorize(SN, description="nexo:0a1b2c3d:v1", **CFG)
        errado = ZteOltDriver.from_device(self.device("olt_zte"), {"olt": lab_cred("ZXA10 C600 (emulado)", "OUTRO")})
        with self.assertRaises(ZteCommandError):
            errado.authorize(SN, description="nexo:0a1b2c3d:v1", **CFG)
        errado._drop()
        self.assertNotIn("1/1/1:2", self.state.onus, "trava falhou: escreveu sem capacidade aprovada")
        # Perfil inexistente: a OLT recusa e o driver propaga o erro.
        with self.assertRaises(ZteCommandError):
            self.d.authorize(SN, description="nexo:0a1b2c3d:v1", **{**CFG, "line_profile": "NAO-EXISTE"})


class LabZteXgspon(_Base):
    STYLE = "xgspon"

    def test_ciclo_completo(self):
        self.ciclo()

    def test_travas_de_escrita(self):
        self.travas()


class LabZteC300(_Base):
    STYLE = "c300"

    def test_ciclo_completo_token_c300(self):
        self.ciclo()
