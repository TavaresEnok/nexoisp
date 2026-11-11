"""Driver VSOL (EPON): seleção de comando de backup e leitura de ONUs autorizadas a partir do running-config."""
import unittest
from nexo_agent.drivers.olt_vsol import VSOL_PROFILE, VsolOltDriver, norm_mac, parse_authorized

CONFIG = """show running-config
!
hostname epon-olt
!
interface epon 0/1
 pon enable
 confirm onu mac a0:b1:c2:d3:e4:f5 onuid 1
 confirm onu mac aabb.ccdd.eeff onuid 3
!
interface epon 0/2
 confirm onu mac 00:11:22:33:44:55 onuid 1
!
"""


class FakeChan:
    def write(self, t): pass


class FakeSession:
    def __init__(self): self.closed = 0; self.chan = FakeChan()
    def read_idle(self, idle=2.0, maxt=60, page=True): return "epon-olt#"
    def run(self, cmd, **k):
        return CONFIG if "running-config" in cmd and "devel" not in cmd else "epon-olt#"
    def dump(self, cmd, **k): return self.run(cmd)
    def close(self): self.closed += 1


class Parsers(unittest.TestCase):
    def test_norm_mac(self):
        self.assertEqual(norm_mac("aabb.ccdd.eeff"), "AA:BB:CC:DD:EE:FF")
        self.assertEqual(norm_mac("a0:b1:c2:d3:e4:f5"), "A0:B1:C2:D3:E4:F5")

    def test_authorized(self):
        rows = parse_authorized(CONFIG)
        self.assertEqual(len(rows), 3)
        by = {r["serial"]: r for r in rows}
        self.assertEqual(by["A0:B1:C2:D3:E4:F5"]["pon_port"], "epon 0/1")
        self.assertEqual(by["00:11:22:33:44:55"]["pon_port"], "epon 0/2")
        self.assertEqual(by["AA:BB:CC:DD:EE:FF"]["onuid"], 3)


class Driver(unittest.TestCase):
    def setUp(self):
        self.olt = VsolOltDriver(lambda: FakeSession(), VSOL_PROFILE, enable_secrets=("x",))

    def test_read_autorizada(self):
        st = self.olt.read_onu("aabb.ccdd.eeff")  # aceita formato pontilhado
        self.assertTrue(st.authorized)
        self.assertEqual(st.extra["onuid"], 3)
        self.assertIsNone(st.online)  # EPON sem leitura operacional via CLI

    def test_read_ausente(self):
        self.assertFalse(self.olt.read_onu("de:ad:be:ef:00:00").authorized)


if __name__ == "__main__":
    unittest.main()
