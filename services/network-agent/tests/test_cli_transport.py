"""Transporte CLI: SSH moderno, SSH legado e telnet contra o emulador em loopback. Não é homologação em equipamento."""
from pathlib import Path
import socket
import tempfile
import threading
import unittest

import paramiko

from nexo_agent import cli_transport
from nexo_agent.drivers import olt_huawei_emulator as emu
from nexo_agent.drivers.fixtures_ficticias import gerar_olt
from nexo_agent.drivers.olt_huawei import HuaweiOltDriver
from nexo_agent.ssh_trust import fingerprint, install_key, ssh_parameters


def _listen(handler):
    sock = socket.socket(); sock.bind(("127.0.0.1", 0)); sock.listen(4); sock.settimeout(20)

    def loop():
        while True:
            try:
                conn, _ = sock.accept()
            except OSError:
                return
            threading.Thread(target=handler, args=(conn,), daemon=True).start()
    threading.Thread(target=loop, daemon=True).start()
    return sock, sock.getsockname()[1]


def _driver(port, cred):
    return HuaweiOltDriver.from_device({"host": "127.0.0.1", "api_port": port, "credential_ref": "olt"},
                                       {"olt": {"username": emu.LAB_USER[0], "password": emu.LAB_USER[1], **cred}})


class Settings(unittest.TestCase):
    def test_defaults_and_explicit_opt_in(self):
        self.assertEqual(cli_transport.settings({}), {"transport": "ssh", "ssh_profile": "modern"})
        self.assertEqual(cli_transport.default_port({}), 22)
        self.assertEqual(cli_transport.default_port({"transport": "telnet", "allow_telnet": True}), 23)
        self.assertEqual(cli_transport.note({}), "")
        self.assertIn("antigos", cli_transport.note({"ssh_profile": "legacy"}))
        self.assertIn("em claro", cli_transport.note({"transport": "telnet", "allow_telnet": True}))
        for bad in [{"transport": "telnet"}, {"transport": "telnet", "allow_telnet": "true"}, {"transport": "rsh"},
                    {"ssh_profile": "old"}, {"transport": "telnet", "allow_telnet": True, "ssh_profile": "legacy"}]:
            with self.assertRaises(ValueError, msg=bad):
                cli_transport.settings(bad)

    def test_legacy_profile_keeps_host_key_pinning(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = str(Path(tmp) / "known_hosts")
            key = paramiko.RSAKey.generate(2048)
            install_key(file, "olt.example.invalid", 22, f"ssh-rsa {key.get_base64()}", fingerprint(key), "Synthetic operator verified fingerprint")
            modern, legacy = ssh_parameters("olt.example.invalid", 22, file), ssh_parameters("olt.example.invalid", 22, file, legacy=True)
            self.assertIn("diffie-hellman-group1-sha1", modern["disabled_algorithms"]["kex"])
            self.assertEqual(legacy["disabled_algorithms"], {})
            self.assertTrue(legacy["ssh_strict"])
            with self.assertRaises(ValueError):
                ssh_parameters("absent.example.invalid", 22, file, legacy=True)

    def test_old_host_key_types_only_with_legacy(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = str(Path(tmp) / "known_hosts")
            dss, rsa1024 = paramiko.DSSKey.generate(1024), paramiko.RSAKey.generate(1024)
            for key in (dss, rsa1024):
                line = f"{key.get_name()} {key.get_base64()}"
                with self.assertRaises(ValueError):
                    install_key(file, "old.example.invalid", 22, line, fingerprint(key), "Synthetic operator verified fingerprint")
            install_key(file, "old.example.invalid", 22, f"ssh-dss {dss.get_base64()}", fingerprint(dss), "Synthetic operator verified fingerprint", legacy=True)
            self.assertIn("ssh-dss", paramiko.HostKeys(file).lookup("old.example.invalid"))


class LoopbackTransports(unittest.TestCase):
    def test_legacy_only_server_needs_legacy_profile(self):
        key = paramiko.RSAKey.generate(2048)
        state = emu.OltState()
        sock, port = _listen(lambda conn: emu.ssh_client(conn, state, key, legacy_only=True))
        try:
            with tempfile.TemporaryDirectory() as tmp:
                file = str(Path(tmp) / "known_hosts")
                install_key(file, "127.0.0.1", port, f"ssh-rsa {key.get_base64()}", fingerprint(key), "Synthetic loopback emulator key")
                with self.assertRaises(Exception):
                    _driver(port, {"known_hosts_file": file}).check()
                driver = _driver(port, {"known_hosts_file": file, "ssh_profile": "legacy"})
                result = driver.check()
                self.assertTrue(result["ok"])
                self.assertIn("algoritmos antigos", result["detail"])
                self.assertEqual({x["serial"] for x in driver.discover()}, {x[1] for x in emu.SEED_AUTOFIND})
                driver._drop()
        finally:
            sock.close()

    def test_export_config_grande_volta_inteiro_por_ssh(self):
        # Regressão: Channel.send pode enviar só parte de uma saída grande; o emulador precisa usar sendall,
        # senão o export de uma OLT cheia chega truncado e o cliente espera um prompt que não vem.
        estado = gerar_olt(seed=3, pons=8)
        state = emu.OltState()
        state.d = estado
        key = paramiko.RSAKey.generate(2048)
        sock, port = _listen(lambda conn: emu.ssh_client(conn, state, key))
        try:
            with tempfile.TemporaryDirectory() as tmp:
                file = str(Path(tmp) / "known_hosts")
                install_key(file, "127.0.0.1", port, f"ssh-rsa {key.get_base64()}", fingerprint(key), "Synthetic loopback emulator key")
                cfg = _driver(port, {"known_hosts_file": file}).export_config()
        finally:
            sock.close()
        self.assertGreater(len(cfg.encode()), 20000, "config grande chegou truncado")
        self.assertEqual(cfg.count("ont add "), len(estado["onts"]), "faltaram linhas de ONT no export")
        self.assertIn("service-port", cfg)
        self.assertTrue(cfg.rstrip().endswith("return"))

    def test_telnet_login_and_reads(self):
        state = emu.OltState()
        sock, port = _listen(lambda conn: emu.telnet_client(conn, state))
        try:
            with self.assertRaises(ValueError):
                _driver(port, {"transport": "telnet"})
            driver = _driver(port, {"transport": "telnet", "allow_telnet": True})
            result = driver.check()
            self.assertTrue(result["ok"])
            self.assertIn("telnet", result["detail"])
            self.assertEqual({x["serial"] for x in driver.discover()}, {x[1] for x in emu.SEED_AUTOFIND})
            driver._drop()
            with self.assertRaises(Exception):
                HuaweiOltDriver.from_device({"host": "127.0.0.1", "api_port": port, "credential_ref": "olt"},
                                            {"olt": {"username": "emu", "password": "errada", "transport": "telnet", "allow_telnet": True}}).check()
        finally:
            sock.close()


if __name__ == "__main__":
    unittest.main()
