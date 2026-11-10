"""Driver ZTE ZXA10: parsers e caminho de leitura/backup, com saídas sintéticas no formato do equipamento real
(docs/estudo-campo/recon-cli-olts.md). Nenhum dado de cliente."""
import unittest

from nexo_agent.drivers.olt_zte import (ZteCommandError, ZteOltDriver, clean_running_config, normalize_index, onu_interface,
                                        parse_card, parse_onu_detail, parse_onu_state, parse_power, parse_uncfg)

CARD = """
Rack Shelf Slot CfgType RealType Port  HardVer SoftVer         Status
-------------------------------------------------------------------------------
1    1     0    PRWH    PRWH     0     V1.0.0                  INSERVICE
1    1     2    GTGH    GTGHK    16    V1.0.0  V2.1.0          INSERVICE
1    1     11   SCXNT   SCXNT00  5     V1.0.0  V2.1.0          INSERVICE
OLT_LAB#"""

STATE = """
OnuIndex   Admin State  OMCC State  Phase State  Channel
--------------------------------------------------------------
1/2/1:1     enable       enable      working      1(GPON)
1/2/1:2     enable       disable     DyingGasp    1(GPON)
OLT_LAB#"""

DETAIL = """
ONU interface:         gpon-onu_1/2/1:1
  Name:                ONU-1:1
  Type:                ZTE-F601
  State:               ready
  Phase state:         working
  Config state:        success
  Admin state:         enable
  Authentication mode: sn
  Serial number:       ZTEGFC000001
  Description:         0000_-_cliente.ficticio
  ONU Distance:        11454m
  Online Duration:     51h 25m 27s
 --More--
  FEC:                 none
OLT_LAB#"""

ONU_RX = """
Onu                 Rx power
------------------------------------
gpon-onu_1/2/1:1    -23.660(dbm)
OLT_LAB#"""

ATTEN = """
           OLT                  ONU              Attenuation
--------------------------------------------------------------------------
 up      Rx :-26.162(dbm)      Tx:2.740(dbm)        28.902(dB)
 down    Tx :6.272(dbm)        Rx:-23.660(dbm)      29.932(dB)
OLT_LAB#"""

RUNNING = """
Building configuration...
olleh
timestamp_write: 16:17:11 11/10/2026
config-version 2.1
!
add-card rackno 1 shelfno 1 slotno 2 GTGH
!
interface gpon-olt_1/2/1
!
OLT_LAB#"""

UNCFG_EMPTY = "\n%Code 62310-GPONSRV : No related information to show.\nOLT_LAB#"
UNCFG = """
OnuIndex            Model          SN             State
gpon-olt_1/2/1      ZTE-F601       ZTEGFC0000AA   unknown
OLT_LAB#"""


class FakeCli:
    def __init__(self):
        self.closed = 0

    def run(self, cmd):
        if cmd == "terminal length 0":
            return "OLT_LAB#"
        if cmd == "show card":
            return CARD
        if cmd == "show gpon onu state":
            return STATE
        if cmd == "show gpon onu uncfg":
            return UNCFG_EMPTY
        if cmd.startswith("show gpon onu detail-info"):
            return DETAIL
        if cmd.startswith("show pon power onu-rx"):
            return ONU_RX
        if cmd.startswith("show pon power attenuation"):
            return ATTEN
        if cmd.startswith("show gpon onu by-sn"):
            return "  search result: gpon-onu_1/2/1:1\nOLT_LAB#"
        return "OLT_LAB#"

    def dump(self, cmd):
        return RUNNING

    def close(self):
        self.closed += 1


class Parsers(unittest.TestCase):
    def test_card(self):
        cards = parse_card(CARD)
        self.assertEqual(len(cards), 3)
        self.assertTrue(any(c["cfg_type"] == "GTGH" and c["real_type"] == "GTGHK" for c in cards))
        self.assertEqual(cards[0]["status"], "INSERVICE")

    def test_state(self):
        st = parse_onu_state(STATE)
        self.assertEqual([r["index"] for r in st], ["1/2/1:1", "1/2/1:2"])
        self.assertEqual(st[1]["phase"], "dyinggasp")

    def test_detail(self):
        info = parse_onu_detail(DETAIL)
        self.assertEqual((info["index"], info["serial"], info["type"], info["phase_state"]),
                         ("1/2/1:1", "ZTEGFC000001", "ZTE-F601", "working"))
        self.assertEqual(info["config_state"], "success")
        self.assertIsNone(parse_onu_detail("\n%Error: nope\n"))

    def test_power(self):
        self.assertEqual(parse_power(ONU_RX, ATTEN), (-23.660, 2.740))
        # sem onu-rx, cai para o bloco "down Rx:" da atenuação
        self.assertEqual(parse_power("", ATTEN), (-23.660, 2.740))

    def test_uncfg(self):
        self.assertEqual(parse_uncfg(UNCFG_EMPTY), [])
        found = parse_uncfg(UNCFG)
        self.assertEqual(found, [{"pon_port": "1/2/1", "serial": "ZTEGFC0000AA"}])

    def test_running_config_sem_linhas_volateis(self):
        c = clean_running_config(RUNNING)
        self.assertNotIn("timestamp_write", c)
        self.assertNotIn("Building configuration", c)
        self.assertIn("add-card", c)
        # mesma config com timestamp diferente => mesmo texto limpo
        other = RUNNING.replace("16:17:11 11/10/2026", "09:00:00 11/17/2026")
        self.assertEqual(clean_running_config(RUNNING), clean_running_config(other))

    def test_index_helpers(self):
        self.assertEqual(normalize_index("gpon-onu_1/2/1:1"), "1/2/1:1")
        self.assertEqual(onu_interface("1/2/1:1"), "gpon-onu_1/2/1:1")


class Driver(unittest.TestCase):
    def setUp(self):
        self.clis = []

        def connect():
            c = FakeCli()
            self.clis.append(c)
            return c
        self.olt = ZteOltDriver(connect)

    def test_check(self):
        r = self.olt.check()
        self.assertTrue(r["ok"])
        self.assertFalse(r["homologated"])
        self.assertIn("GPON", r["detail"])

    def test_export_config(self):
        cfg = self.olt.export_config()
        self.assertIn("add-card", cfg)
        self.assertNotIn("timestamp_write", cfg)
        self.assertTrue(self.clis[-1].closed, "a sessão de backup deve ser fechada")

    def test_read_por_indice(self):
        st = self.olt.read_onu("1/2/1:1")
        self.assertTrue(st.authorized and st.online)
        self.assertEqual((st.rx_dbm, st.tx_dbm), (-23.660, 2.740))
        self.assertEqual(st.pon_port, "1/2/1")
        self.assertEqual(st.extra["serial"], "ZTEGFC000001")

    def test_read_por_serial_mapeia_interface(self):
        st = self.olt.read_onu("ZTEGFC000001")
        self.assertTrue(st.authorized)
        self.assertEqual(st.extra["index"], "1/2/1:1")

    def test_autorizacao_recusada(self):
        with self.assertRaises(ZteCommandError):
            self.olt.authorize("ZTEGFC000001", pon_port="1/2/1", line_profile="x", service_vlan=100, description="y")


if __name__ == "__main__":
    unittest.main()
