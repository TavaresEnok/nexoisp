"""Gerador de OLTs fictícias: distribuição plausível, determinístico e utilizável pelo driver via emulador."""
from collections import Counter
import statistics
import unittest

from nexo_agent.drivers.fixtures_ficticias import gerar_olt
from nexo_agent.drivers.olt_huawei import HuaweiOltDriver
from nexo_agent.drivers.olt_huawei_emulator import HuaweiCliEmulator, OltState


class Fixtures(unittest.TestCase):
    def test_deterministico_e_plausivel(self):
        a, b = gerar_olt(seed=7, pons=20), gerar_olt(seed=7, pons=20)
        self.assertEqual(a, b)
        self.assertNotEqual(a["onts"], gerar_olt(seed=8, pons=20)["onts"])
        por_pon = Counter(o["fsp"] for o in a["onts"])
        self.assertEqual(max(por_pon.values()), 128)                    # há uma PON cheia
        self.assertTrue(all(0 <= o["id"] < 128 for o in a["onts"]))     # nenhum ONT-ID >= 128
        self.assertEqual(len({o["sn"] for o in a["onts"]}), len(a["onts"]))
        self.assertTrue(all(o["desc"].startswith("FICTICIO") for o in a["onts"]))
        mediana = statistics.median(Counter(o["fsp"] for o in gerar_olt(seed=3, pons=200, pon_cheia=False)["onts"]).values())
        self.assertTrue(15 <= mediana <= 45, mediana)                   # real: p50 = 29
        gems = Counter(s["gem"] for s in gerar_olt(seed=3, pons=200)["sports"])
        self.assertEqual(gems.most_common(1)[0][0], 100)
        self.assertGreater(len(gems), 3)

    def test_driver_le_a_olt_ficticia(self):
        state = OltState()
        state.d = gerar_olt(seed=11, pons=10)
        driver = HuaweiOltDriver(lambda: HuaweiCliEmulator(state))
        amostra = [o["sn"] for o in state.d["onts"][:20]]
        lidas = driver.read_onus(amostra)
        self.assertEqual(set(lidas), set(amostra))
        self.assertTrue(all(s.authorized for s in lidas.values()))
        offline = set(state.d["offline"]) & set(amostra)
        self.assertTrue(all(lidas[sn].online is False for sn in offline))
        self.assertEqual({x["serial"] for x in driver.discover()}, {x[1] for x in state.d["autofind"]})


if __name__ == "__main__":
    unittest.main()
