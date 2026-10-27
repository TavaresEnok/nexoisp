"""Loopback SSH keys and emulator fixtures only; no physical compatibility claim."""
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch

import paramiko

from nexo_agent.ssh_trust import fingerprint, install_key, ssh_parameters
from nexo_agent.drivers.olt_huawei import NetmikoCli, HuaweiOltDriver, OltCommandError
from nexo_agent.drivers.olt_huawei_emulator import HuaweiCliEmulator, OltState
from nexo_agent.drivers.mikrotik_radius import MikrotikSessions


class SSHTrust(unittest.TestCase):
    def test_explicit_rotation_is_audited_and_does_not_touch_other_hosts(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = str(Path(tmp) / "known_hosts")
            first, second = paramiko.RSAKey.generate(2048), paramiko.RSAKey.generate(2048)
            def put(host, key, **kw):
                return install_key(file, host, 22, f"{key.get_name()} {key.get_base64()}", fingerprint(key), "Synthetic operator verified fingerprint", **kw)
            put("olt.example.invalid", first); put("other.example.invalid", first)
            with self.assertRaises(ValueError):
                put("olt.example.invalid", second)
            put("olt.example.invalid", second, previous=fingerprint(first))
            keys = paramiko.HostKeys(file)
            self.assertEqual(fingerprint(keys.lookup("olt.example.invalid")[second.get_name()]), fingerprint(second))
            self.assertEqual(fingerprint(keys.lookup("other.example.invalid")[first.get_name()]), fingerprint(first))
            events = [json.loads(line) for line in Path(file + ".audit.jsonl").read_text().splitlines()]
            self.assertEqual([e["state"] for e in events], ["intent", "committed"] * 3)
            options = ssh_parameters("olt.example.invalid", 22, file)
            self.assertTrue(options["ssh_strict"])
            self.assertIn("ssh-rsa", options["disabled_algorithms"]["keys"])
            with self.assertRaises(ValueError):
                ssh_parameters("absent.example.invalid", 22, file)
            os.chmod(file, 0o666)
            with self.assertRaises(ValueError):
                ssh_parameters("olt.example.invalid", 22, file)

    def test_real_loopback_handshake_rejects_wrong_host_key_before_password(self):
        self._assert_handshake_rejected(False)

    def test_rsa_sha1_only_server_is_rejected_before_password(self):
        self._assert_handshake_rejected(True)

    def _assert_handshake_rejected(self, sha1_only):
        server_key, wrong_key = paramiko.RSAKey.generate(2048), paramiko.RSAKey.generate(2048)
        auth = []
        class Server(paramiko.ServerInterface):
            def check_auth_password(self, username, password):
                auth.append(username)
                return paramiko.AUTH_FAILED
        sock = socket.socket(); sock.bind(("127.0.0.1", 0)); sock.listen(1); sock.settimeout(5)
        port = sock.getsockname()[1]
        transports = []
        def serve():
            try:
                conn, _ = sock.accept(); transport = paramiko.Transport(conn); transports.append(transport)
                transport.add_server_key(server_key)
                if sha1_only:
                    transport.get_security_options().key_types = ("ssh-rsa",)
                transport.start_server(server=Server())
                transport.accept(1)
            except (OSError, EOFError, paramiko.SSHException):
                pass
        thread = threading.Thread(target=serve, daemon=True); thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                file = str(Path(tmp) / "known_hosts")
                install_key(file, "127.0.0.1", port, f"ssh-rsa {(server_key if sha1_only else wrong_key).get_base64()}", fingerprint(server_key if sha1_only else wrong_key), "Synthetic independent key mismatch check")
                with self.assertRaises(Exception):
                    NetmikoCli("127.0.0.1", port, "synthetic", "synthetic-only", file)
                self.assertEqual(auth, [])
        finally:
            for transport in transports: transport.close()
            sock.close(); thread.join(timeout=3)

    def test_unknown_reads_and_local_capability_gates_fail_closed(self):
        class Denied:
            def run(self, command): return "  Failure: Permission denied"
            def close(self): pass
        driver = HuaweiOltDriver(lambda: Denied())
        for read in [lambda: driver.read_onu("48575443A1B2C3D4"), driver.discover, lambda: driver.deauthorize("48575443A1B2C3D4")]:
            with self.assertRaises(OltCommandError): read()
        emulator = HuaweiCliEmulator(OltState())
        gated = HuaweiOltDriver(lambda: emulator, allow_writes=False)
        args = dict(pon_port="0/1/0", line_profile="residencial", service_profile="bridge-1ge", service_vlan=100, description="nexo:0a1b2c3d:v1")
        with self.assertRaises(OltCommandError): gated.authorize("48575443A1B2C3D4", **args)
        self.assertFalse(any(command.startswith("ont add") for command in emulator.log))
        with self.assertRaises(ValueError): MikrotikSessions("192.0.2.10", None, {"insecure_plaintext": True})


if __name__ == "__main__":
    unittest.main()
