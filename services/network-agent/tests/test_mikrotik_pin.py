import hashlib
import ssl
import unittest

from nexo_agent.drivers.mikrotik_radius import MikrotikSessions, check_pin, pinned_fingerprint


class FixacaoDoCertificado(unittest.TestCase):
    def test_formato_da_impressao_digital(self):
        der = b"certificado-de-teste"
        hexa = hashlib.sha256(der).hexdigest()
        com_dois_pontos = ":".join(hexa[i:i + 2] for i in range(0, 64, 2)).upper()
        self.assertEqual(pinned_fingerprint(com_dois_pontos), hexa)
        self.assertIsNone(pinned_fingerprint(None))
        with self.assertRaises(ValueError):
            pinned_fingerprint("abc")

    def test_certificado_diferente_e_recusado_antes_do_login(self):
        der = b"certificado-de-teste"
        check_pin(der, hashlib.sha256(der).hexdigest())
        with self.assertRaises(ssl.SSLError):
            check_pin(b"outro", hashlib.sha256(der).hexdigest())
        with self.assertRaises(ssl.SSLError):
            check_pin(None, hashlib.sha256(der).hexdigest())

    def test_fixacao_nao_exige_modo_de_laboratorio(self):
        s = MikrotikSessions("192.0.2.10", None, {"username": "u", "password": "p", "cert_sha256": "a" * 64})
        self.assertEqual(s.port, 8729)


if __name__ == "__main__":
    unittest.main()
