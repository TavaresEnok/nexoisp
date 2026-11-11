"""Driver FiberHome AN5516: leitura de ONU (auth table + optical), saídas sintéticas no formato real."""
import unittest
from nexo_agent.drivers.olt_fiberhome import FIBERHOME_PROFILE, FiberHomeOltDriver, parse_auth_table, parse_optical_table

AUTH = """show authorization slot all pon all
-----  ONU Auth Table, SLOT = 6, PON = 1, ITEM = 3 -----
Slot Pon Onu OnuType        ST Lic OST PhyId        PhyPwd     LogicId
---- --- --- -------------- -- --- --- ------------ ---------- -------
6    1   1   5506-01-A1     A  1   up  FHTT0A1B2C3D GD4B16E52
6    1   2   5506-01-A1     A  1   dn  FHTT0A1B2C3E 123456
6    2   5   5506-01-A1     P  1   dn  CMSZ00112233
Admin\\onu#"""

OPT = """show onu optical-info slot all pon all onu all
SLOT PON ONU OST RxPower TxPower OLT Rx ONU  Temperature
---- --- --- --- ------- ------- ----------  -----------
6    1   1   up  -22.15  2.40    -23.01      45
6    1   2   dn  -       -       -           -
Admin\\onu#"""


class FakeChan:
    def __init__(self): self.writes = []
    def write(self, t): self.writes.append(t)


class FakeSession:
    def __init__(self): self.chan = FakeChan(); self.closed = 0
    def read_idle(self, idle=2.0, maxt=60, page=True): return "Admin#"
    def run(self, cmd, **k): return "Admin\\onu#"
    def dump(self, cmd, **k):
        return AUTH if "authorization" in cmd else (OPT if "optical" in cmd else "Admin\\onu#")
    def close(self): self.closed += 1


class Parsers(unittest.TestCase):
    def test_auth(self):
        rows = parse_auth_table(AUTH)
        self.assertEqual(len(rows), 3)
        r = {x["serial"]: x for x in rows}
        self.assertTrue(r["FHTT0A1B2C3D"]["authorized"] and r["FHTT0A1B2C3D"]["online"])
        self.assertFalse(r["FHTT0A1B2C3E"]["online"])
        self.assertFalse(r["CMSZ00112233"]["authorized"])  # P = preauthorized

    def test_optical(self):
        o = parse_optical_table(OPT)
        self.assertEqual(o[(6, 1, 1)], (-22.15, 2.40))
        self.assertEqual(o[(6, 1, 2)], (None, None))


class Driver(unittest.TestCase):
    def setUp(self):
        self.olt = FiberHomeOltDriver(lambda: FakeSession(), FIBERHOME_PROFILE, enable_secrets=("p",))

    def test_read_onu_online_com_sinal(self):
        st = self.olt.read_onu("FHTT0A1B2C3D")
        self.assertTrue(st.authorized and st.online)
        self.assertEqual((st.rx_dbm, st.tx_dbm), (-22.15, 2.40))
        self.assertEqual(st.pon_port, "6/1")

    def test_read_onu_offline_e_ausente(self):
        self.assertFalse(self.olt.read_onu("FHTT0A1B2C3E").online)
        self.assertFalse(self.olt.read_onu("DEADBEEF0000").authorized)


if __name__ == "__main__":
    unittest.main()
