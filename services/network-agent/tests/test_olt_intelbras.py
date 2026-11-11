"""Driver Intelbras OLT8820: leitura de ONU (inventory) e autofind (onu show), com saídas sintéticas no formato real."""
import unittest

from nexo_agent.drivers.olt_intelbras import INTELBRAS_PROFILE, IntelbrasOltDriver, parse_discovered, parse_inventory, parse_status

INVENTORY = """onu inventory
gpon 1 onu 9    8B6A9709  ITBS    R1      PONR1_v2.0      1.0-200813
gpon 1 onu 12   2CED4534  ITBS    110Gb   PON110B_v3.0    1.0-200522
gpon 8 onu 66   FCB84877  ALCL    NOCLE   3FE49937        3FE49568
intelbras-olt>"""

ONU_SHOW = """onu show

Free slots in GPON Link 1:
=======================================
 95   96   97

Discovered serial numbers
==============================================
sernoID   Vendor  Serial Number   Model       Time Discovered
1   CMSZ    CMSZ0A1B2C3D   HG8546   2026-11-10 10:00
2   ITBS    ITBS99887766   ONU120   2026-11-10 10:05

Free slots in GPON Link 2:
=======================================
 60   64   65
intelbras-olt>"""

STATUS = """onu status
     Serial    OperStatus  Config   OLT Rx     ONU Rx     Distance
ONU  Number
18  2CED4534  Active      OK       -25.85 dBm  -21.08 dBm  0.593   0:16:13:48  no
20  8B6AE5E1  Inactive    -        -           -           -
intelbras-olt>"""


class FakeChan:
    def __init__(self):
        self.writes = []

    def write(self, t):
        self.writes.append(t)


class FakeSession:
    def __init__(self):
        self.chan = FakeChan()
        self.closed = 0

    def read_idle(self, idle=2.0, maxt=60, page=True):
        return "intelbras-olt>"

    def run(self, cmd, **k):
        return ONU_SHOW if cmd == "onu show" else "intelbras-olt>"

    def dump(self, cmd, **k):
        if cmd == "onu status":
            return STATUS
        return INVENTORY if cmd == "onu inventory" else "intelbras-olt>"

    def close(self):
        self.closed += 1


class Parsers(unittest.TestCase):
    def test_inventory(self):
        rows = parse_inventory(INVENTORY)
        self.assertEqual(len(rows), 3)
        r = [x for x in rows if x["serial"] == "2CED4534"][0]
        self.assertEqual((r["link"], r["onu_id"], r["vendor"], r["model"]), (1, 12, "ITBS", "110Gb"))

    def test_discovered(self):
        d = parse_discovered(ONU_SHOW)
        self.assertEqual({x["serial"] for x in d}, {"CMSZ0A1B2C3D", "ITBS99887766"})

    def test_status(self):
        rows = parse_status(STATUS)
        r = {x["serial"]: x for x in rows}
        self.assertTrue(r["2CED4534"]["online"])
        self.assertEqual((r["2CED4534"]["rx_dbm"], r["2CED4534"]["tx_dbm"]), (-21.08, -25.85))
        self.assertFalse(r["8B6AE5E1"]["online"])


class Driver(unittest.TestCase):
    def setUp(self):
        self.olt = IntelbrasOltDriver(lambda: FakeSession(), INTELBRAS_PROFILE, enable_secrets=("x",))

    def test_read_onu_online_com_sinal(self):
        st = self.olt.read_onu("2CED4534")
        self.assertTrue(st.authorized and st.online)
        self.assertEqual((st.rx_dbm, st.tx_dbm), (-21.08, -25.85))
        self.assertEqual(st.extra["onu_id"], 18)

    def test_read_onu_offline_e_ausente(self):
        self.assertFalse(self.olt.read_onu("8B6AE5E1").online)
        self.assertFalse(self.olt.read_onu("DEADBEEF").authorized)

    def test_discover(self):
        self.assertEqual(len(self.olt.discover()), 2)


if __name__ == "__main__":
    unittest.main()
