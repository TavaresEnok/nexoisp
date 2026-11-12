"""Driver FiberHome AN5516: leitura de ONU (auth table + óptica por ONU), saídas sintéticas no formato real."""
import unittest
from nexo_agent.drivers.olt_fiberhome import FIBERHOME_PROFILE, FiberHomeOltDriver, parse_auth_table, parse_optical_power

AUTH = """show authorization slot all pon all
-----  ONU Auth Table, SLOT = 6, PON = 1, ITEM = 3 -----
Slot Pon Onu OnuType        ST Lic OST PhyId        PhyPwd     LogicId
---- --- --- -------------- -- --- --- ------------ ---------- -------
6    1   1   5506-01-A1     A  1   up  FHTT0A1B2C3D GD4B16E52
6    1   2   5506-01-A1     A  1   dn  FHTT0A1B2C3E 123456
6    2   5   5506-01-A1     P  1   dn  CMSZ00112233
Admin\\onu#"""

# Formato real de 'show onu opticalpower-info phy-id <serial>' (capturado em campo 2026-11-12).
OPT_ONLINE = """show onu opticalpower-info phy-id FHTT0A1B2C3D

 onu (6/1/1).
-----  ONU OPTICAL INFO 6.1.1-----
SEND POWER   :  2.40\t(Dbm)
RECV POWER   : -22.15\t(Dbm)
Admin\\onu#"""


class FakeChan:
    def __init__(self): self.writes = []
    def write(self, t): self.writes.append(t)


class FakeSession:
    def __init__(self): self.chan = FakeChan(); self.closed = 0; self.optical_queries = []
    def read_idle(self, idle=2.0, maxt=60, page=True): return "Admin#"
    def run(self, cmd, **k): return "Admin\\onu#"
    def dump(self, cmd, **k):
        if "authorization" in cmd:
            return AUTH
        if "opticalpower-info" in cmd:
            self.optical_queries.append(cmd)
            return OPT_ONLINE if "FHTT0A1B2C3D" in cmd else "Admin\\onu#"
        return "Admin\\onu#"
    def close(self): self.closed += 1


class Parsers(unittest.TestCase):
    def test_auth(self):
        rows = parse_auth_table(AUTH)
        self.assertEqual(len(rows), 3)
        r = {x["serial"]: x for x in rows}
        self.assertTrue(r["FHTT0A1B2C3D"]["authorized"] and r["FHTT0A1B2C3D"]["online"])
        self.assertFalse(r["FHTT0A1B2C3E"]["online"])
        self.assertFalse(r["CMSZ00112233"]["authorized"])  # P = preauthorized

    def test_optical_power(self):
        self.assertEqual(parse_optical_power(OPT_ONLINE), (-22.15, 2.40))  # (rx=RECV, tx=SEND)

    def test_optical_power_vazio(self):
        self.assertEqual(parse_optical_power("% Unknown command.\nAdmin\\onu#"), (None, None))


class Driver(unittest.TestCase):
    def setUp(self):
        self.sessions = []
        def factory():
            s = FakeSession(); self.sessions.append(s); return s
        self.factory = factory
        self.olt = FiberHomeOltDriver(factory, FIBERHOME_PROFILE, enable_secrets=("p",))

    def test_read_onu_online_com_sinal(self):
        st = self.olt.read_onu("FHTT0A1B2C3D")
        self.assertTrue(st.authorized and st.online)
        self.assertEqual((st.rx_dbm, st.tx_dbm), (-22.15, 2.40))
        self.assertEqual(st.pon_port, "6/1")

    def test_read_onu_offline_nao_consulta_optica(self):
        st = self.olt.read_onu("FHTT0A1B2C3E")
        self.assertTrue(st.authorized)
        self.assertFalse(st.online)
        self.assertEqual((st.rx_dbm, st.tx_dbm), (None, None))
        # ONU offline não deve disparar consulta óptica
        self.assertEqual(self.sessions[-1].optical_queries, [])

    def test_read_onu_ausente(self):
        self.assertFalse(self.olt.read_onu("DEADBEEF0000").authorized)


if __name__ == "__main__":
    unittest.main()
