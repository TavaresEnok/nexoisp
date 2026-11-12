"""Apoio dos laboratórios de provisionamento por telnet real (ZTE, Datacom, VSOL, FiberHome).

Sobe o emulador do fabricante num socket de verdade, grava cada comando que chega a ele e monta a credencial de
laboratório com escrita habilitada (allow_writes + modelo/firmware esperados, a mesma trava exigida em produção).
"""
import unittest

from nexo_agent.drivers.lab_cli_server import LabCli, serve_telnet


def lab_cred(product: str, firmware: str, **extra) -> dict:
    return {"username": LabCli.username, "password": LabCli.password, "transport": "telnet", "allow_telnet": True,
            "allow_writes": True, "expected_product": product, "expected_firmware": firmware, **extra}


def readonly_cred(**extra) -> dict:
    return {"username": LabCli.username, "password": LabCli.password, "transport": "telnet", "allow_telnet": True, **extra}


class LabCase(unittest.TestCase):
    MUTANTES: tuple = ()

    def start(self, cli_factory):
        self.commands = []
        self.sock, self.port = serve_telnet(cli_factory, on_command=self.commands.append)
        self.addCleanup(self.sock.close)
        return self.port

    def device(self, driver):
        return {"host": "127.0.0.1", "api_port": self.port, "credential_ref": "olt", "driver": driver}

    def muta(self):
        return [c for c in self.commands if c.startswith(self.MUTANTES)]
