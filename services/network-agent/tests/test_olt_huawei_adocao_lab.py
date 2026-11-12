"""LABORATÓRIO de MIGRAÇÃO Huawei — adotar ONUs provisionadas pelo SGP SEM derrubar o cliente.

O SGP grava as ONUs como `ont add P ID sn-auth "SN" omci ont-lineprofile-id 100 ont-srvprofile-id 100 desc "importacao_sgp"`.
Para o NexoISP passar a reconhecê-las, basta trocar a DESCRIÇÃO para o nosso marcador (`ont modify P ID desc ...`):
a ONU, os perfis e os service-ports ficam intactos. Esta prova roda por SSH real contra o emulador e confere,
comando a comando, que NADA destrutivo (ont delete / undo service-port / ont add) chega ao equipamento.
"""
from pathlib import Path
import tempfile
import unittest

import paramiko

from nexo_agent.drivers import olt_huawei_emulator as emu
from nexo_agent.drivers.olt_huawei import HuaweiOltDriver, OltCommandError, parse_config_onts
from nexo_agent.ssh_trust import fingerprint, install_key
from tests.test_olt_huawei_lab import EMU_FIRMWARE, EMU_PRODUCT, _listen

SGP_SN = "48575443DEAD0001"      # ONU fictícia "do SGP", online, navegando
OUTRA_SN = "48575443DEAD0002"    # outra ONU fictícia já marcada por OUTRO recurso nosso
_DESTRUTIVOS = ("ont delete", "undo service-port", "ont add", "service-port")


class LabAdocaoSgpHuawei(unittest.TestCase):
    def setUp(self):
        self.state = emu.OltState()
        self.state.d["onts"] += [
            {"fsp": "0/1/2", "id": 7, "sn": SGP_SN, "line": "sgp-100", "srv": "sgp-100", "line_id": 100, "srv_id": 100,
             "desc": "importacao_sgp", "at": 0},
            {"fsp": "0/1/2", "id": 8, "sn": OUTRA_SN, "line": "residencial", "srv": "bridge-1ge", "desc": "nexo:ffff0000:v3", "at": 0},
        ]
        self.state.d["sports"].append({"index": 900, "vlan": 100, "fsp": "0/1/2", "ont": 7, "gem": 1, "user_vlan": 100})
        self.commands = []
        self.key = paramiko.RSAKey.generate(2048)
        self.sock, self.port = _listen(lambda conn: emu.ssh_client(conn, self.state, self.key, on_command=self.commands.append))
        self.tmp = tempfile.TemporaryDirectory()
        self.kh = str(Path(self.tmp.name) / "known_hosts")
        install_key(self.kh, "127.0.0.1", self.port, f"ssh-rsa {self.key.get_base64()}", fingerprint(self.key),
                    "Chave do emulador de laboratório, conferida nesta prova")
        self.driver = self._driver(allow_writes=True)

    def _driver(self, **extra):
        cred = {"username": emu.LAB_USER[0], "password": emu.LAB_USER[1], "known_hosts_file": self.kh,
                "expected_product": EMU_PRODUCT, "expected_firmware": EMU_FIRMWARE}
        cred.update(extra)
        return HuaweiOltDriver.from_device({"host": "127.0.0.1", "api_port": self.port, "credential_ref": "olt"}, {"olt": cred})

    def tearDown(self):
        self.sock.close()
        self.tmp.cleanup()

    def test_running_config_do_sgp_com_perfil_por_id(self):
        cfg = self.driver.export_config()
        self.assertIn('ont add 2 7 sn-auth "48575443DEAD0001" omci ont-lineprofile-id 100 ont-srvprofile-id 100 desc "importacao_sgp"', cfg)
        rows = {r["serial"]: r for r in parse_config_onts(cfg)}
        self.assertEqual((rows[SGP_SN]["pon_port"], rows[SGP_SN]["ont_id"], rows[SGP_SN]["description"]), ("0/1/2", 7, "importacao_sgp"))

    def test_adota_onu_do_sgp_sem_derrubar(self):
        d = self.driver
        # 1. Inventário: só a ONU do SGP é "estrangeira" (a outra já tem marcador nosso).
        self.assertEqual([o["serial"] for o in d.foreign_onus()], [SGP_SN])
        antes = d.read_onu(SGP_SN)
        self.assertTrue(antes.authorized and antes.online)
        self.assertIsNone(antes.applied_version)

        # 2. ADOTAR: exatamente entrar na PON, trocar a descrição e sair. Nada destrutivo.
        self.commands.clear()
        r = d.adopt(SGP_SN, "nexo:0a1b2c3d:v1")
        self.assertEqual((r["adopted"], r["pon_port"], r["ont_id"], r["previous_description"]), (1, "0/1/2", 7, "importacao_sgp"))
        muta = [c for c in self.commands if c.startswith(("interface gpon", "ont ", "service-port", "undo"))]
        self.assertEqual(muta, ["interface gpon 0/1", 'ont modify 2 7 desc "nexo:0a1b2c3d:v1"'])
        self.assertFalse([c for c in self.commands if c.startswith(_DESTRUTIVOS)])

        # 3. O cliente continua navegando: online, mesma PON/perfis, service-port intacto, agora reconhecido como v1.
        depois = d.read_onu(SGP_SN)
        self.assertTrue(depois.authorized and depois.online)
        self.assertEqual((depois.pon_port, depois.line_profile, depois.service_vlan), (antes.pon_port, antes.line_profile, antes.service_vlan))
        self.assertEqual(depois.applied_version, 1)
        self.assertEqual([s["index"] for s in self.state.d["sports"] if s["ont"] == 7], [900])
        self.assertEqual(d.foreign_onus(), [])

        # 4. Idempotente: repetir não envia nada.
        self.commands.clear()
        self.assertEqual(d.adopt(SGP_SN, "nexo:0a1b2c3d:v1")["adopted"], 0)
        self.assertFalse([c for c in self.commands if c.startswith("ont modify")])

    def test_recusas(self):
        # ONU já de outro recurso nosso: não sequestra.
        with self.assertRaises(OltCommandError):
            self.driver.adopt(OUTRA_SN, "nexo:0a1b2c3d:v1")
        # Descrição que não é marcador do sistema: recusa antes de conectar.
        with self.assertRaises(ValueError):
            self.driver.adopt(SGP_SN, "cliente_joao")
        # ONU inexistente.
        with self.assertRaises(OltCommandError):
            self.driver.adopt("48575443DEAD00FF", "nexo:0a1b2c3d:v1")
        # Sem allow_writes: nenhuma escrita.
        with self.assertRaises(OltCommandError):
            self._driver().adopt(SGP_SN, "nexo:0a1b2c3d:v1")
        self.assertEqual(next(o for o in self.state.d["onts"] if o["sn"] == SGP_SN)["desc"], "importacao_sgp")
        self.assertFalse([c for c in self.commands if c.startswith("ont modify")])


if __name__ == "__main__":
    unittest.main()
