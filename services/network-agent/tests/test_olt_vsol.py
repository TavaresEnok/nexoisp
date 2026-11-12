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

# Running-config de OLT GPON (BDCOM/Maxprint, classificada como VSOL): autorização por 'onu add ... sn',
# sem indentação, delimitada por 'interface gpon f/p'. Validado ao vivo (TC+ Itapissuma, 2026-11-12).
CONFIG_GPON = """show running-config
!
hostname gpon-olt
!
interface gpon 0/1
no onu auto-learn
onu add 1 profile default sn VSOLA0000001
onu 1 tcont 1 dba dba_1
onu add 2 profile default sn VSOLA0000002
onu add 3 profile default sn AABBCCDD1122
!
interface gpon 0/2
onu add 5 profile default sn CMSZ00000005
!
interface gigabitethernet 0/1
 description uplink
onu add 9 profile x sn NAODEVE0009
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

    def test_authorized_gpon(self):
        rows = parse_authorized(CONFIG_GPON)
        by = {r["serial"]: r for r in rows}
        self.assertEqual(len(rows), 4)  # 4 ONUs sob interface gpon; a de baixo de gigabitethernet não conta
        self.assertEqual(by["VSOLA0000001"]["pon_port"], "gpon 0/1")
        self.assertEqual(by["VSOLA0000002"]["onuid"], 2)
        self.assertEqual(by["CMSZ00000005"]["pon_port"], "gpon 0/2")
        self.assertNotIn("NAODEVE0009", by)  # 'onu add' fora de uma interface epon/gpon é ignorado


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


class DriverGpon(unittest.TestCase):
    def setUp(self):
        class FakeSessionGpon(FakeSession):
            def run(self, cmd, **k):
                return CONFIG_GPON if "running-config" in cmd and "devel" not in cmd else "gpon-olt#"
        self.olt = VsolOltDriver(lambda: FakeSessionGpon(), VSOL_PROFILE, enable_secrets=("x",))

    def test_read_gpon_por_sn(self):
        st = self.olt.read_onu("VSOLA0000002")
        self.assertTrue(st.authorized)
        self.assertEqual((st.pon_port, st.extra["onuid"]), ("gpon 0/1", 2))

    def test_read_gpon_sn_12hex(self):
        # SN de 12 hex: norm_mac o viraria MAC; a busca deve cair para o SN cru.
        st = self.olt.read_onu("AABBCCDD1122")
        self.assertTrue(st.authorized)
        self.assertEqual(st.pon_port, "gpon 0/1")


if __name__ == "__main__":
    unittest.main()
