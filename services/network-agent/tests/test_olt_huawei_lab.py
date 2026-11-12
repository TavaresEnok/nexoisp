"""LABORATÓRIO de provisionamento Huawei — prova do ciclo completo em transporte REAL.

Prova, contra o emulador de OLT Huawei por SSH de verdade (netmiko -> paramiko), o ciclo que o dono pediu:
autorizar -> ler (online + sinal) -> desautorizar -> re-autorizar restaurando a MESMA configuração (o cliente
volta a navegar). Cada comando mutante que chega ao equipamento (emulado) é GRAVADO e conferido byte a byte,
para que não seja "um laboratório falho": prova-se que os comandos reais trafegam e são confirmados.

NÃO é homologação em equipamento físico — o emulador replica o conjunto de comandos e as falhas do MA5600, mas
não prova compatibilidade de firmware real. A autorização em cliente real só é liberada numa ONU de teste, em
janela, depois desta prova de laboratório.
"""
from pathlib import Path
import socket
import tempfile
import threading
import unittest

import paramiko

from nexo_agent.drivers import olt_huawei_emulator as emu
from nexo_agent.drivers.olt_huawei import HuaweiOltDriver
from nexo_agent.ssh_trust import fingerprint, install_key

# Valores exatos do `display version` do emulador (o driver os exige em expected_product/firmware para liberar escrita).
EMU_PRODUCT = "MA5800-X7 (emulado)"
EMU_FIRMWARE = "MA5800V100R019C10 (emulador NexoISP)"
SERIAL = "48575443A1B2C3D4"  # ONT presente no autofind semeado (porta 0/1/0)
# Comandos que ALTERAM o equipamento (o filtro ignora o prelúdio de sessão e as leituras 'display ...').
_MUTANTES = ("interface gpon", "ont add", "ont delete", "ont port native-vlan", "ont tr069", "service-port", "undo service-port")


def _listen(handler):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(4)
    sock.settimeout(20)

    def loop():
        while True:
            try:
                conn, _ = sock.accept()
            except OSError:
                return
            threading.Thread(target=handler, args=(conn,), daemon=True).start()

    threading.Thread(target=loop, daemon=True).start()
    return sock, sock.getsockname()[1]


class LabProvisionamentoHuawei(unittest.TestCase):
    def setUp(self):
        self.state = emu.OltState()  # autofind semeado: SERIAL em 0/1/0; perfis residencial/bridge-1ge; vlan 100
        self.commands = []
        self.key = paramiko.RSAKey.generate(2048)
        self.sock, self.port = _listen(
            lambda conn: emu.ssh_client(conn, self.state, self.key, on_command=self.commands.append))
        self.tmp = tempfile.TemporaryDirectory()
        kh = str(Path(self.tmp.name) / "known_hosts")
        # Pino a chave do host do emulador (em produção o fingerprint é conferido fora de banda).
        install_key(kh, "127.0.0.1", self.port, f"ssh-rsa {self.key.get_base64()}", fingerprint(self.key),
                    "Chave do emulador de laboratório, conferida nesta prova")
        self.driver = HuaweiOltDriver.from_device(
            {"host": "127.0.0.1", "api_port": self.port, "credential_ref": "olt"},
            {"olt": {"username": emu.LAB_USER[0], "password": emu.LAB_USER[1], "known_hosts_file": kh,
                     "allow_writes": True, "expected_product": EMU_PRODUCT, "expected_firmware": EMU_FIRMWARE,
                     "gemport": 1}})

    def tearDown(self):
        self.sock.close()
        self.tmp.cleanup()

    def _muta(self):
        return [c for c in self.commands if c.startswith(_MUTANTES)]

    def test_escrita_exige_allow_writes_e_firmware(self):
        # A mesma OLT sem allow_writes recusa qualquer escrita (trava de segurança).
        kh = str(Path(self.tmp.name) / "kh2")
        install_key(kh, "127.0.0.1", self.port, f"ssh-rsa {self.key.get_base64()}", fingerprint(self.key),
                    "Chave do emulador para a prova de trava de escrita")
        ro = HuaweiOltDriver.from_device(
            {"host": "127.0.0.1", "api_port": self.port, "credential_ref": "olt"},
            {"olt": {"username": emu.LAB_USER[0], "password": emu.LAB_USER[1], "known_hosts_file": kh}})
        from nexo_agent.drivers.olt_huawei import OltCommandError
        with self.assertRaises(OltCommandError):
            ro.authorize(SERIAL, pon_port="0/1/0", line_profile="residencial", service_profile="bridge-1ge",
                         service_vlan=100, description="nexo:0a1b2c3d:v1")
        # e firmware divergente também trava
        bad = HuaweiOltDriver.from_device(
            {"host": "127.0.0.1", "api_port": self.port, "credential_ref": "olt"},
            {"olt": {"username": emu.LAB_USER[0], "password": emu.LAB_USER[1], "known_hosts_file": kh,
                     "allow_writes": True, "expected_product": EMU_PRODUCT, "expected_firmware": "OUTRO"}})
        with self.assertRaises(OltCommandError):
            bad.authorize(SERIAL, pon_port="0/1/0", line_profile="residencial", service_profile="bridge-1ge",
                          service_vlan=100, description="nexo:0a1b2c3d:v1")

    def test_ciclo_completo_autorizar_ler_desautorizar_reautorizar_restaura(self):
        d = self.driver

        # 0. Identidade e descoberta (a ONT aparece no autofind, ainda não autorizada).
        chk = d.check()
        self.assertEqual((chk["product"], chk["firmware"]), (EMU_PRODUCT, EMU_FIRMWARE))
        self.assertIn(SERIAL, [o["serial"] for o in d.discover()])
        self.assertFalse(d.read_onu(SERIAL).authorized)

        # 1. AUTORIZAR (v1). Confere a sequência exata de comandos mutantes que chegou à OLT.
        self.commands.clear()
        r1 = d.authorize(SERIAL, pon_port="0/1/0", line_profile="residencial", service_profile="bridge-1ge",
                         service_vlan=100, description="nexo:0a1b2c3d:v1")
        oid = r1["ont_id"]
        esperado_v1 = [
            "interface gpon 0/1",
            f'ont add 0 sn-auth "{SERIAL}" omci ont-lineprofile-name "residencial" ont-srvprofile-name "bridge-1ge" desc "nexo:0a1b2c3d:v1"',
            f"ont port native-vlan 0 {oid} eth 1 vlan 100 priority 0",
            f"service-port vlan 100 gpon 0/1/0 ont {oid} gemport 1 multi-service user-vlan 100 tag-transform translate",
        ]
        self.assertEqual(self._muta(), esperado_v1)

        # 2. LER de volta: online, com sinal, perfis/vlan corretos e versão v1 legível na própria OLT.
        s1 = d.read_onu(SERIAL)
        self.assertTrue(s1.authorized and s1.online)
        self.assertEqual((s1.pon_port, s1.line_profile, s1.service_vlan, s1.service_profile), ("0/1/0", "residencial", 100, "bridge-1ge"))
        self.assertEqual(s1.applied_version, 1)
        self.assertIsNotNone(s1.rx_dbm)
        self.assertIsNotNone(s1.tx_dbm)

        # 3. DESAUTORIZAR: 'undo service-port' SEMPRE antes de 'ont delete' (senão a OLT recusa).
        self.commands.clear()
        rdel = d.deauthorize(SERIAL)
        self.assertEqual(rdel["removed"], 1)
        self.assertEqual(rdel["service_ports_removed"], 1)
        muta_del = self._muta()
        self.assertTrue(any(c.startswith("undo service-port") for c in muta_del))
        self.assertIn(f"ont delete 0 {oid}", muta_del)
        i_undo = next(i for i, c in enumerate(muta_del) if c.startswith("undo service-port"))
        i_del = muta_del.index(f"ont delete 0 {oid}")
        self.assertLess(i_undo, i_del, "undo service-port tem que vir antes do ont delete")

        # 4. LER: não autorizada e de volta ao autofind (a ONT caiu, como o cliente desconectado).
        self.assertFalse(d.read_onu(SERIAL).authorized)
        self.assertIn(SERIAL, [o["serial"] for o in d.discover()])

        # 5. RE-AUTORIZAR (v2) com a MESMA configuração: o cliente volta a navegar.
        self.commands.clear()
        d.authorize(SERIAL, pon_port="0/1/0", line_profile="residencial", service_profile="bridge-1ge",
                    service_vlan=100, description="nexo:0a1b2c3d:v2")
        # Conjunto de comandos idêntico ao v1, só mudando o marcador de versão.
        self.assertEqual(self._muta(), [c.replace(":v1", ":v2") for c in esperado_v1])

        # 6. LER: restaurado — mesmos perfis/vlan de antes, online com sinal, agora na versão v2.
        s2 = d.read_onu(SERIAL)
        self.assertTrue(s2.authorized and s2.online)
        self.assertEqual((s2.pon_port, s2.line_profile, s2.service_vlan, s2.service_profile),
                         (s1.pon_port, s1.line_profile, s1.service_vlan, s1.service_profile))
        self.assertEqual(s2.applied_version, 2)
        self.assertIsNotNone(s2.rx_dbm)

        # 7. DESAUTORIZAR idempotente: repetir não é erro nem reenvia comando destrutivo.
        self.commands.clear()
        d.deauthorize(SERIAL)
        self.assertEqual(d.deauthorize(SERIAL), {"removed": 0})


if __name__ == "__main__":
    unittest.main()
