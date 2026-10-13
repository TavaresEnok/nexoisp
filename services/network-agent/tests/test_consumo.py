"""Consumo mensal lido do accounting local (radacct) pelo agente."""
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone

from nexo_agent.drivers.mikrotik_radius import RadiusStore


def epoch(y, m, d, h=12):
    return int(datetime(y, m, d, h, tzinfo=timezone.utc).timestamp())


class Consumo(unittest.TestCase):
    def setUp(self):
        d = tempfile.mkdtemp()
        self.path = os.path.join(d, "radius.sqlite")
        db = sqlite3.connect(self.path)
        db.executescript(
            "create table radcheck (id integer primary key, username text, attribute text, op text, value text);"
            "create table radreply (id integer primary key, username text, attribute text, op text, value text);"
            "create table radacct (radacctid integer primary key, username text, acctstarttime, acctinputoctets bigint, acctoutputoctets bigint, acctsessiontime integer);")
        rows = [("ana", epoch(2026, 9, 3), 100, 1000, 60), ("ana", epoch(2026, 9, 20), 50, 500, 30), ("ana", epoch(2026, 10, 2), 10, 20, 5),
                ("bia", epoch(2026, 10, 5), 7, 9, 1), ("ana", epoch(2026, 7, 1), 999, 999, 999),   # antes da janela
                ("ana", "2026-10-09 08:00:00", 1, 2, 3)]                                           # data em texto, de banco mais antigo
        db.executemany("insert into radacct (username, acctstarttime, acctinputoctets, acctoutputoctets, acctsessiontime) values (?,?,?,?,?)", rows)
        db.commit()
        db.close()
        self.radius = RadiusStore(self.path)

    def test_soma_por_conta_e_mes_dentro_da_janela(self):
        since = epoch(2026, 9, 1, 0)
        u = self.radius.usage(["ana", "bia", "inexistente"], since)
        self.assertEqual(u["ana"]["2026-09"], {"bytes_in": 150, "bytes_out": 1500, "session_seconds": 90, "sessions": 2})
        self.assertEqual(u["ana"]["2026-10"], {"bytes_in": 11, "bytes_out": 22, "session_seconds": 8, "sessions": 2})   # época + texto
        self.assertEqual(u["bia"]["2026-10"]["bytes_out"], 9)
        self.assertNotIn("2026-07", u["ana"])
        self.assertNotIn("inexistente", u)

    def test_sem_contas_ou_sem_tabela(self):
        self.assertEqual(self.radius.usage([], 0), {})
        d = tempfile.mkdtemp()
        p = os.path.join(d, "r.sqlite")
        db = sqlite3.connect(p)
        db.executescript("create table radcheck (id integer primary key, username text, attribute text, op text, value text);"
                         "create table radreply (id integer primary key, username text, attribute text, op text, value text);")
        db.close()
        self.assertEqual(RadiusStore(p).usage(["ana"], 0), {})


if __name__ == "__main__":
    unittest.main()
