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

    def test_ont_id_reusado_nao_deixa_remocao_atrasada_atingir_outra_onu(self):
        """Estudo de campo: 23% das adições reusam um ONT-ID liberado no mesmo dia. A identidade é sempre o serial:
        a desautorização atrasada da ONU A não pode remover a ONU B que herdou o mesmo ID na mesma PON."""
        a, b = SN, "485754430000BEEF"
        self.assertEqual(self.olt.authorize(a, **KW)["ont_id"], 0)
        self.assertEqual(self.olt.deauthorize(a)["ont_id"], 0)
        self.assertEqual(self.olt.authorize(b, **{**KW, "description": "nexo:0b0b0b0b:v1"})["ont_id"], 0)  # B herda o ID 0
        before = list(self.state.d["sports"])
        self.assertEqual(self.olt.deauthorize(a), {"removed": 0})  # repetição atrasada da remoção de A
        st = self.olt.read_onu(b)
        self.assertTrue(st.authorized)
        self.assertEqual(st.service_vlan, 100)
        self.assertEqual(self.state.d["sports"], before)
        self.assertFalse(any(c.startswith("ont delete") or c.startswith("undo service-port") for c in self.commands()[-6:]))

    def test_vlan_do_cliente_diferente_da_vlan_de_saida(self):
        # Padrão das OLTs reais: VLAN de saída por PON e VLAN do cliente fixa na OLT (user_vlan na credencial)
        self.olt = HuaweiOltDriver(self.olt._connect, user_vlan=10)
        r = self.olt.authorize("HWTCA1B2C3D4", **KW)
        self.assertEqual((r["service_vlan"], r["user_vlan"]), (KW["service_vlan"], 10))
        self.assertIn(f"service-port vlan {KW['service_vlan']} gpon 0/1/0 ont 0 gemport 1 multi-service user-vlan 10 tag-transform translate", self.commands())
        self.assertEqual(self.state.d["sports"][-1]["user_vlan"], 10)
        self.assertEqual(self.olt.read_onu(SN).service_vlan, KW["service_vlan"])
        with self.assertRaises(ValueError):
            HuaweiOltDriver(self.olt._connect, user_vlan=5000).authorize("HWTCA1B2C3D4", **KW)
        cred = {"c": {"username": "u", "password": "p", "user_vlan": "100"}}
        self.assertEqual(HuaweiOltDriver.from_device({"credential_ref": "c", "host": "h"}, cred).user_vlan, 100)
        self.assertIsNone(HuaweiOltDriver.from_device({"credential_ref": "c", "host": "h"}, {"c": {"username": "u", "password": "p"}}).user_vlan)

    def test_perfil_de_linha_define_gemport_e_vlan_do_cliente_e_native_vlan(self):
        # Padrão real: gemport e VLAN do cliente vêm do gem mapping do perfil de linha; native-vlan na eth da ONU
        self.olt = HuaweiOltDriver(self.olt._connect, gemport=1, line_profiles={"residencial": {"gemport": 100, "user_vlan": 100}})
        r = self.olt.authorize("HWTCA1B2C3D4", **{**KW, "service_vlan": 200})
        self.assertEqual((r["gemport"], r["user_vlan"], r["service_vlan"]), (100, 100, 200))
        cmds = self.commands()
        nat = "ont port native-vlan 0 0 eth 1 vlan 100 priority 0"
        sp = "service-port vlan 200 gpon 0/1/0 ont 0 gemport 100 multi-service user-vlan 100 tag-transform translate"
        self.assertIn(nat, cmds)
        self.assertLess(cmds.index(nat), cmds.index(sp))
        self.assertEqual(self.state.d["onts"][-1]["native"], {1: 100})
        self.assertNotIn("tr069", self.state.d["onts"][-1])
        # perfil sem mapeamento cai no padrão da OLT; [] desliga o native-vlan
        self.olt.deauthorize(SN)
        self.olt = HuaweiOltDriver(self.olt._connect, native_vlan_eth=[])
        self.olt.authorize("HWTCA1B2C3D4", **KW)
        self.assertNotIn("native", self.state.d["onts"][-1])

    def test_perfil_tr069_por_olt_e_por_perfil(self):
        self.olt = HuaweiOltDriver(self.olt._connect, tr069_profile_id=2, line_profiles={"residencial-200": {"tr069_profile_id": 5}})
        self.olt.authorize("HWTCA1B2C3D4", **KW)
        self.assertIn("ont tr069-server-config 0 0 profile-id 2", self.commands())
        self.assertEqual(self.state.d["onts"][-1]["tr069"], 2)

    def test_pon_cheia_responde_falha_e_nao_quebra(self):
        fs = "0/1/0"
        for i in range(128):
            self.state.d["onts"].append({"fsp": fs, "id": i, "sn": f"{i:016X}", "line": "residencial", "srv": "bridge-1ge", "desc": "x", "at": 0})
        with self.assertRaises(Exception) as ctx:
            self.olt.authorize("HWTCA1B2C3D4", **KW)
        self.assertIn("upper limit", str(ctx.exception))

    def test_leitura_em_lote_isola_onu_com_resposta_inesperada(self):
        self.olt.authorize("HWTCA1B2C3D4", **KW)
        import nexo_agent.drivers.olt_huawei as mod
        original = mod.parse_ont_info
        def quebrado(raw):
            info = original(raw)
            if info and "ruim" in self.__dict__.get("_flag", ""):
                return None
            return info
        self._flag = "ruim"
        mod.parse_ont_info = quebrado
        try:
            self.assertEqual(self.olt.read_onus([SN, SN]), {})          # resposta incompleta: ONU fica fora, sem exceção
        finally:
            mod.parse_ont_info = original
        self.assertTrue(self.olt.read_onus([SN])[SN].authorized)

    def test_varias_service_ports_com_a_vlan_desejada_contam_como_aplicadas(self):
        from nexo_agent.drivers.olt_base import OnuState
        from types import SimpleNamespace
        from nexo_agent.executor import onu_applied
        p = SimpleNamespace(state="authorized", description="nexo:abcdef01:v3", pon_port="0/1/0", line_profile="residencial", service_vlan=200, service_profile=None)
        st = OnuState(True, "0/1/0", "residencial", None, "nexo:abcdef01:v3", True, extra={"service_vlans": [200, 300]})
        self.assertTrue(onu_applied(st, SimpleNamespace(parameters=p, desired_version=3)))
        st.extra["service_vlans"] = [300, 400]
        self.assertFalse(onu_applied(st, SimpleNamespace(parameters=p, desired_version=3)))

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
