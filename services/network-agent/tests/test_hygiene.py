"""Práticas de gerência informadas ao NOC (MikroTik por API simulada, Huawei pelo emulador). Só leitura."""
import unittest

from nexo_agent import agent
from nexo_agent.drivers.mikrotik_radius import mikrotik_hygiene
from nexo_agent.drivers.olt_huawei import HuaweiOltDriver, parse_ntp_status
from nexo_agent.drivers.olt_huawei_emulator import HuaweiCliEmulator, OltState


class FakeApi:
    def __init__(self, tables):
        self.tables = tables

    def path(self, *parts):
        value = self.tables.get(parts)
        if isinstance(value, Exception):
            raise value
        return iter(value or [])


class MikrotikHygiene(unittest.TestCase):
    def test_reads_services_ntp_and_syslog(self):
        api = FakeApi({("ip", "service"): [{"name": "telnet", "disabled": False}, {"name": "ftp", "disabled": "true"},
                                           {"name": "www", "disabled": "false"}, {"name": "ssh", "disabled": False}],
                       ("system", "ntp", "client"): [{"enabled": "false"}],
                       ("system", "logging", "action"): [{"name": "remote", "target": "remote", "remote": "0.0.0.0"}]})
        self.assertEqual(mikrotik_hygiene(api), ["no_ntp", "no_syslog", "telnet_enabled", "www_enabled"])

    def test_good_practice_and_unreadable_items(self):
        api = FakeApi({("ip", "service"): [{"name": "telnet", "disabled": True}],
                       ("system", "ntp", "client"): PermissionError("sem política read"),
                       ("system", "logging", "action"): [{"name": "noc", "target": "remote", "remote": "10.0.0.5"}]})
        self.assertEqual(mikrotik_hygiene(api), [])


class HuaweiHygiene(unittest.TestCase):
    def test_ntp_status(self):
        self.assertTrue(parse_ntp_status(" clock status: synchronized\n"))
        self.assertFalse(parse_ntp_status(" clock status: unsynchronized\n"))
        self.assertIsNone(parse_ntp_status("  % Unknown command, the error locates at '^'"))

    def test_check_reports_ntp_and_transport(self):
        state = OltState()
        state.d["ntp"] = False
        emulator = HuaweiCliEmulator(state)
        driver = HuaweiOltDriver(lambda: emulator, transport_hygiene=["legacy_ssh"])
        self.assertEqual(driver.check()["hygiene"], ["legacy_ssh", "no_ntp"])
        state.d["ntp"] = True
        self.assertNotIn("hygiene", HuaweiOltDriver(lambda: HuaweiCliEmulator(state)).check())

    def test_agent_forwards_only_known_codes(self):
        self.assertIn("no_ntp", agent.HYGIENE_CODES)
        self.assertNotIn("qualquer", agent.HYGIENE_CODES)


if __name__ == "__main__":
    unittest.main()
