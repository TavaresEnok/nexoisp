"""Driver Datacom DmOS: identidade e backup de configuração, com saídas sintéticas no formato do equipamento real
(docs/estudo-campo/recon-cli-olts.md). Nenhum dado de cliente."""
import unittest

from nexo_agent.drivers.olt_datacom import (DatacomCommandError, DatacomOltDriver, clean_running_config, parse_firmware)

FW = """show firmware
Status: Idle
Download progress: -

Version                     State
------------------------------------
10.4.0-234-1-gb36c606132    Active
10.4.0-234-1-gb36c606132    Inactive

OLT-LAB#"""

RUN = """show running-config | nomore
aaa authentication-order [ local ]
aaa user admin
 password $1$ABCDEFGH$0000000000000000000000
 group admin
!
snmp agent enabled
snmp agent version v2c
!
interface gpon 1/1/1
 description pon-teste
!
hostname OLT-LAB
OLT-LAB#"""


class FakeCli:
    def __init__(self):
        self.closed = 0

    def run(self, cmd):
        return FW if cmd.startswith("show firmware") else "OLT-LAB#"

    def dump(self, cmd):
        return RUN

    def close(self):
        self.closed += 1


class Datacom(unittest.TestCase):
    def setUp(self):
        self.clis = []

        def connect():
            c = FakeCli()
            self.clis.append(c)
            return c
        self.olt = DatacomOltDriver(connect)

    def test_parse_firmware(self):
        self.assertEqual(parse_firmware(FW), "10.4.0-234-1-gb36c606132")
        self.assertIsNone(parse_firmware("Version State\n---\n(nenhuma ativa)"))

    def test_check(self):
        r = self.olt.check()
        self.assertTrue(r["ok"])
        self.assertFalse(r["homologated"])
        self.assertEqual(r["firmware"], "10.4.0-234-1-gb36c606132")

    def test_export_config(self):
        cfg = self.olt.export_config()
        self.assertIn("aaa user admin", cfg)
        self.assertIn("interface gpon", cfg)
        self.assertTrue(self.clis[-1].closed, "a sessão de backup deve ser fechada")

    def test_export_recusa_sem_config(self):
        class Vazio(FakeCli):
            def dump(self, cmd):
                return "OLT-LAB#"
        self.olt = DatacomOltDriver(lambda: Vazio())
        with self.assertRaises(DatacomCommandError):
            self.olt.export_config()

    def test_clean_remove_linhas_volateis(self):
        c = clean_running_config("! Last commit 2026-11-10\naaa user x\n")
        self.assertNotIn("Last commit", c)
        self.assertIn("aaa user x", c)

    def test_autorizacao_recusada(self):
        with self.assertRaises(DatacomCommandError):
            self.olt.authorize("x", pon_port="1/1/1", line_profile="y", service_vlan=100, description="z")


if __name__ == "__main__":
    unittest.main()
