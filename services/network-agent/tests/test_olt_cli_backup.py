"""Driver genérico de backup por CLI: validação de config, enable e tentativa de comandos, com sessão falsa."""
import unittest

from nexo_agent.drivers.olt_cli_backup import (CliBackupDriver, CliBackupError, CliBackupProfile, PROFILES, clean_config,
                                               looks_config, looks_error)

CONFIG = "hostname OLT-LAB\nsnmp-server community publica\nvlan 100\nvlan 200\n" + "".join(
    f"interface gpon 0/{p}\n onu {p} type generic\n service-port {p} vlan 100\n ont-desc cliente{p}\n!\n" for p in range(1, 9)
) + "end\n"


class FakeChan:
    def __init__(self):
        self.writes = []

    def write(self, t):
        self.writes.append(t)


class FakeSession:
    def __init__(self, dump_map, enable_needs_pwd=False, enable_ok="OLT-LAB#"):
        self.chan = FakeChan()
        self.dump_map = dump_map
        self.enable_needs_pwd = enable_needs_pwd
        self.enable_ok = enable_ok
        self.closed = 0

    def read_idle(self, idle=2.0, maxt=60, page=True):
        last = self.chan.writes[-1] if self.chan.writes else ""
        if last == "enable\n" and self.enable_needs_pwd:
            return "Password: "
        return self.enable_ok

    def run(self, cmd, **k):
        return "OLT-LAB#"

    def dump(self, cmd, **k):
        return self.dump_map.get(cmd, "% Invalid command\nOLT-LAB#")

    def close(self):
        self.closed += 1


class Validation(unittest.TestCase):
    def test_looks_config(self):
        self.assertTrue(looks_config(CONFIG))
        self.assertFalse(looks_config("% Invalid command"))
        self.assertFalse(looks_config("OLT>"))

    def test_looks_error(self):
        self.assertTrue(looks_error("%% Invalid command"))
        self.assertTrue(looks_error("syntax error: unknown argument"))
        self.assertFalse(looks_error(CONFIG))

    def test_clean_remove_volateis(self):
        c = clean_config("timestamp_write: 10:00\nhostname X\nTime: now\n")
        self.assertNotIn("timestamp_write", c)
        self.assertNotIn("Time:", c)
        self.assertIn("hostname X", c)


class Driver(unittest.TestCase):
    def mk(self, dump_map, **kw):
        self.sessions = []

        def connect():
            s = FakeSession(dump_map, **kw)
            self.sessions.append(s)
            return s
        return CliBackupDriver(connect, CliBackupProfile("OLT Teste"), enable_secrets=("sec1", "sec2"))

    def test_export_tenta_ate_achar_config(self):
        # primeiro comando dá erro, segundo traz a config
        drv = self.mk({"show configuration": CONFIG})
        cfg = drv.export_config()
        self.assertIn("hostname OLT-LAB", cfg)
        self.assertTrue(self.sessions[-1].closed)

    def test_export_sem_config_falha(self):
        drv = self.mk({})  # todos retornam "% Invalid command"
        with self.assertRaises(CliBackupError):
            drv.export_config()

    def test_enable_com_senha_envia_secret(self):
        drv = self.mk({"show running-config": CONFIG}, enable_needs_pwd=True)
        drv.export_config()
        w = self.sessions[-1].chan.writes
        self.assertIn("enable\n", w)
        self.assertIn("sec1\n", w)  # tentou o primeiro secret ao ver "Password:"

    def test_check(self):
        drv = self.mk({"show running-config": CONFIG})
        r = drv.check()
        self.assertTrue(r["ok"] and not r["homologated"])
        self.assertEqual(r["product"], "OLT Teste")

    def test_autorizacao_recusada(self):
        drv = self.mk({})
        with self.assertRaises(CliBackupError):
            drv.authorize("x")

    def test_perfis_registrados(self):
        self.assertEqual(set(PROFILES), {"olt_intelbras", "olt_fiberhome", "olt_vsol", "olt_parks"})
        self.assertEqual(PROFILES["olt_parks"].transport_default, "ssh")


if __name__ == "__main__":
    unittest.main()
