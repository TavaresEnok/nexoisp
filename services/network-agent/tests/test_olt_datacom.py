"""Driver Datacom DmOS: identidade e backup de configuração, com saídas sintéticas no formato do equipamento real
(docs/estudo-campo/recon-cli-olts.md). Nenhum dado de cliente."""
import re
import unittest

from nexo_agent.drivers.olt_datacom import (DatacomCommandError, DatacomOltDriver, clean_running_config, parse_firmware,
                                            parse_onu_list, parse_optical, parse_ports)

PHYS = """Physical interface   :  gpon 1/1/1, Enabled, Physical link is Up
Link-level type      :  GPON
Physical interface   :  gpon 1/1/2, Enabled, Physical link is Up
OLT-LAB#"""

ONU_LIST = """  Itf     ONU ID   Serial Number   Oper State   Software Download State      Name
--------  ------   -------------   ----------   --------------------------   --------
1/1/1     0        ITBS8B93E41A    Up           None
1/1/1     1        CMSZ00AABBCC    Down         None
OLT-LAB#"""

OPTICAL = """ ID                    : 0
 Rx Optical Power [dBm]: -19.39
 Tx Optical Power [dBm]: 2.35
OLT-LAB#"""

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
        base = cmd.split("|")[0].strip()  # o driver anexa '| nomore'
        if base.startswith("show firmware"):
            return FW
        if "optical-info" in base:
            return OPTICAL
        m = re.match(r"show interface gpon (\S+) onu$", base)
        if m:
            # só a porta 1/1/1 tem ONUs; as outras devolvem só o cabeçalho (varredura de portas).
            return ONU_LIST if m.group(1) == "1/1/1" else "  Itf  ONU ID  Serial  Oper State\n------  ------\nOLT-LAB#"
        return "OLT-LAB#"

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

    def test_read_onu(self):
        st = self.olt.read_onu("ITBS8B93E41A")
        self.assertTrue(st.authorized and st.online)
        self.assertEqual((st.rx_dbm, st.tx_dbm), (-19.39, 2.35))
        self.assertEqual(st.pon_port, "1/1/1")
        self.assertEqual(st.extra["onu_id"], 0)
        # ONU "Down" na lista fica offline
        self.assertFalse(self.olt.read_onu("CMSZ00AABBCC").online)
        # desconhecida -> não autorizada
        self.assertFalse(self.olt.read_onu("AUSENTE000000").authorized)


class DatacomParsers(unittest.TestCase):
    def test_parse_ports(self):
        self.assertEqual(parse_ports(PHYS), ["1/1/1", "1/1/2"])

    def test_parse_onu_list(self):
        rows = parse_onu_list(ONU_LIST)
        self.assertEqual(len(rows), 2)
        self.assertEqual((rows[0]["serial"], rows[0]["onu_id"], rows[0]["oper"]), ("ITBS8B93E41A", 0, "up"))

    def test_parse_optical(self):
        self.assertEqual(parse_optical(OPTICAL), (-19.39, 2.35))


if __name__ == "__main__":
    unittest.main()
