"""Driver Huawei contra o EMULADOR da CLI (não é equipamento real: valida a lógica do driver, não a compatibilidade com o firmware)."""
import os
import tempfile
import unittest

from nexo_agent.drivers.olt_huawei import (HuaweiOltDriver, OltCommandError, normalize_serial, parse_autofind, parse_ont_info, parse_optical,
                                            parse_service_ports)
from nexo_agent.drivers.olt_huawei_emulator import HuaweiCliEmulator, OltState
from nexo_agent.executor import Executor
from nexo_agent.store import Store
from tests.test_onu import onu_delivery
from tests.test_recuperacao import AGENT, DEVICE, PUB, TENANT, FakeCloud

SN, DESC = "48575443A1B2C3D4", "nexo:0a1b2c3d:v1"
KW = dict(pon_port="0/1/0", line_profile="residencial", service_profile="bridge-1ge", service_vlan=100, description=DESC)


class Huawei(unittest.TestCase):
    def setUp(self):
        self.state, self.sessions = OltState(), []
        def connect():
            self.sessions.append(HuaweiCliEmulator(self.state))
            return self.sessions[-1]
        self.olt = HuaweiOltDriver(connect)

    def commands(self):
        return [c for s in self.sessions for c in s.log]

    def test_serial_e_interpretadores(self):
        self.assertEqual(normalize_serial("HWTC-A1B2C3D4"), SN)
        self.assertEqual(normalize_serial("48575443a1b2c3d4"), SN)
        with self.assertRaises(ValueError):
            normalize_serial("ABC")
        emu = HuaweiCliEmulator(self.state)
        found = parse_autofind(emu.run("display ont autofind all"))
        self.assertEqual(found[0], {"serial": SN, "pon_port": "0/1/0", "vendor": "HWTC", "model": "HG8310M"})
        self.assertEqual(len(found), 3)
        self.assertIsNone(parse_ont_info(emu.run(f"display ont info by-sn {SN}")))
        self.assertEqual(parse_service_ports("  Failure: No service virtual port can be operated"), [])
        self.assertEqual(parse_optical("  Rx optical power(dBm)                  : -19.23\n  Tx optical power(dBm)   : 2.31"), (-19.23, 2.31))
        self.assertEqual(parse_optical("  Failure: The ONT is not online"), (None, None))

    def test_descobre_autoriza_le_e_desautoriza(self):
        self.assertIn(SN, [x["serial"] for x in self.olt.discover()])
        self.assertFalse(self.olt.read_onu(SN).authorized)
        r = self.olt.authorize("HWTCA1B2C3D4", **KW)
        self.assertEqual(r["ont_id"], 0)
        st = self.olt.read_onu(SN)
        self.assertEqual((st.authorized, st.pon_port, st.line_profile, st.service_profile, st.service_vlan, st.applied_version, st.online),
                         (True, "0/1/0", "residencial", "bridge-1ge", 100, 1, True))
        self.assertLess(st.rx_dbm, 0)
        self.assertNotIn(SN, [x["serial"] for x in self.olt.discover()])
        self.state.d["offline"].append(SN)                                   # ONU desligada: sem leitura óptica, estado offline
        st = self.olt.read_onu(SN)
        self.assertEqual((st.online, st.rx_dbm), (False, None))
        self.state.d["offline"].clear()
        self.assertEqual(self.olt.deauthorize(SN), {"removed": 1, "service_ports_removed": 1, "ont_id": 0})
        self.assertFalse(self.olt.read_onu(SN).authorized)
        self.assertEqual(self.olt.deauthorize(SN), {"removed": 0})           # repetir é inofensivo
        # ordem certa na remoção: service-port antes da ONT
        cmds = self.commands()
        self.assertLess(cmds.index("undo service-port 10"), cmds.index("ont delete 0 0"))

    def test_sessao_e_reaproveitada_e_descartada_apos_erro(self):
        self.olt.discover(); self.olt.read_onu(SN); self.olt.discover()
        self.assertEqual(len(self.sessions), 1)                               # uma conexão para três chamadas
        with self.assertRaises(OltCommandError):                              # erro no meio de 'interface gpon': sessão descartada
            self.olt.authorize(SN, **{**KW, "line_profile": "inexistente"})
        self.olt.authorize(SN, **KW)                                          # nova sessão, em modo de configuração
        self.assertEqual(len(self.sessions), 2)
        self.assertTrue(self.olt.read_onu(SN).authorized)

    def test_falhas_da_olt_viram_erro_e_nada_e_inventado(self):
        with self.assertRaisesRegex(OltCommandError, "line profile does not exist"):
            self.olt.authorize(SN, **{**KW, "line_profile": "inexistente"})
        self.assertFalse(self.olt.read_onu(SN).authorized)
        with self.assertRaises(ValueError):
            self.olt.authorize(SN, **{**KW, "service_profile": None})
        with self.assertRaises(ValueError):                                   # tentativa de injetar comando pela descrição
            self.olt.authorize(SN, **{**KW, "description": 'x" \n undo service-port 1'})
        with self.assertRaises(ValueError):
            self.olt.authorize(SN, **{**KW, "pon_port": "0/1"})
        self.assertFalse(any("undo" in c for c in self.commands()))

    def test_vlan_inexistente_deixa_ont_sem_servico_e_o_executor_converge(self):
        """ont add funciona mas o service-port falha: a leitura não confirma, a operação falha, e a nova tentativa refaz por completo."""
        d = tempfile.mkdtemp()
        cloud = FakeCloud(); cloud.go = {"go": True}
        ident = {"agent_id": AGENT, "tenant_id": TENANT, "public_key": PUB, "device_ids": {DEVICE}}
        ex = Executor(Store(os.path.join(d, "agent.sqlite")), cloud, lambda _: self.olt, lambda: ident)
        mk = lambda **k: onu_delivery(**{"profile": "residencial", "port": "0/1/0", **k})
        import json
        def with_sn(delivery, vlan):
            return delivery  # (parametrização abaixo)
        import base64
        from tests.test_recuperacao import KEY
        def deliver(version, vlan, op=None):
            x = mk(version=version, vlan=vlan, op=op)
            env = json.loads(x["envelope"]); env["parameters"]["serial"] = SN; env["parameters"]["service_profile"] = "bridge-1ge"
            raw = json.dumps(env); x["envelope"] = raw; x["signature"] = base64.b64encode(KEY.sign(raw.encode())).decode()
            return x, env["operation_id"]
        x, op = deliver(1, 999)                                               # VLAN 999 não existe na OLT
        ex.handle(x)
        self.assertEqual(cloud.results[-1][1]["outcome"], "FAILED")
        st = self.olt.read_onu(SN)
        self.assertEqual((st.authorized, st.service_vlan), (True, None))      # efeito parcial registrado, não escondido
        self.state.d["vlans"].append(999)                                     # operador cria a VLAN na OLT
        x, _ = deliver(1, 999, op)
        ex.handle(x)
        out = cloud.results[-1][1]
        self.assertEqual(out["outcome"], "SUCCEEDED")
        self.assertIn("remoção da configuração anterior", str(out["steps"]))
        self.assertEqual(self.olt.read_onu(SN).service_vlan, 999)
        self.assertEqual(out["onu_observed"]["state"], "authorized")


if __name__ == "__main__":
    unittest.main()
