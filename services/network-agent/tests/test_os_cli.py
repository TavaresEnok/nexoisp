"""Transporte OS (ssh binário / telnet puro): lógica sem rede — montagem do comando ssh com algoritmos legados,
resposta à negociação IAC do telnet, limpeza ANSI/backspace e tratamento de paginação na leitura por ociosidade."""
import unittest

from nexo_agent import os_cli


class SshArgv(unittest.TestCase):
    def test_estrito_exige_known_hosts_absoluto(self):
        with self.assertRaises(ValueError):
            os_cli._ssh_argv("10.0.0.1", 22, "u", legacy=False, known_hosts="relativo", strict=True)

    def test_estrito_com_known_hosts(self):
        argv = os_cli._ssh_argv("10.0.0.1", 2222, "adm", legacy=False, known_hosts="/data/kh", strict=True)
        self.assertIn("StrictHostKeyChecking=yes", argv)
        self.assertIn("UserKnownHostsFile=/data/kh", argv)
        self.assertEqual(argv[-1], "adm@10.0.0.1")
        self.assertIn("2222", argv)
        self.assertNotIn("HostKeyAlgorithms=+ssh-rsa", argv)  # sem legacy

    def test_legado_adiciona_algoritmos_antigos(self):
        argv = os_cli._ssh_argv("10.0.0.1", 22, "u", legacy=True, known_hosts="", strict=False)
        self.assertIn("StrictHostKeyChecking=accept-new", argv)
        self.assertIn("HostKeyAlgorithms=+ssh-rsa", argv)
        self.assertIn("KexAlgorithms=+diffie-hellman-group1-sha1,diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha1", argv)
        self.assertIn("Ciphers=+aes128-cbc,3des-cbc,aes256-cbc", argv)
        self.assertIn("PubkeyAuthentication=no", argv)  # força senha


class Iac(unittest.TestCase):
    def test_responde_e_limpa(self):
        # IAC DO ECHO(1), IAC WILL SGA(3), e texto "oi"
        data = bytes((255, 253, 1)) + bytes((255, 251, 3)) + b"oi"
        clean, reply = os_cli._iac(data)
        self.assertEqual(clean, b"oi")
        self.assertEqual(reply, bytes((255, 252, 1)) + bytes((255, 254, 3)))  # WONT ECHO, DONT SGA

    def test_iac_escapado(self):
        clean, reply = os_cli._iac(bytes((255, 255)) + b"x")
        self.assertEqual(clean, bytes((255,)) + b"x")
        self.assertEqual(reply, b"")


class Strip(unittest.TestCase):
    def test_remove_ansi_e_backspace(self):
        self.assertEqual(os_cli._strip("\x1b[2Jabc\r\ndef"), "abc\ndef")
        self.assertEqual(os_cli._strip("abcd\b\b\bX"), "aX")


class FakeChan:
    def __init__(self, chunks):
        self.chunks = list(chunks)
        self.written = []

    def read(self, timeout=0.4):
        return self.chunks.pop(0) if self.chunks else ""

    def write(self, t):
        self.written.append(t)

    def close(self):
        pass


class ReadIdle(unittest.TestCase):
    def test_paginacao_envia_espaco_e_junta(self):
        chan = FakeChan(["topo da config\n  ---- More ----", "resto da config\nfim", ""])
        sess = os_cli.OsCliSession(chan)
        out = sess.read_idle(idle=0.1, maxt=5)
        self.assertIn("topo da config", out)
        self.assertIn("resto da config", out)
        self.assertIn(" ", chan.written)  # respondeu à paginação com espaço

    def test_login_responde_senha(self):
        chan = FakeChan(["\r\nUser Access\r\nPassword: ", "OLT> ", ""])
        sess = os_cli.OsCliSession(chan)
        sess.login("adm", "segredo")
        self.assertIn("segredo\n", chan.written)


if __name__ == "__main__":
    unittest.main()
