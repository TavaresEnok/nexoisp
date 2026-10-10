"""Atualização que muda o schema local, rollback assistido e disco cheio."""
import os
import sqlite3
import tempfile
import unittest

from nexo_agent.drivers.demo import DemoDriver
from nexo_agent.executor import Executor
from nexo_agent.rollback import rollback
from nexo_agent.store import LOCAL_SCHEMA_VERSION, Store, backup_path
from tests.test_recuperacao import AGENT, DEVICE, PUB, TENANT, FakeCloud, delivery

V1 = """
create table attempts (attempt_id text primary key, operation_id text not null, resource_id text not null, device_id text not null, action text not null,
  desired_version integer not null, envelope text not null, status text not null, steps text not null default '[]', outcome text,
  reported integer not null default 0, created_at text not null, updated_at text not null);
create table kv (key text primary key, value text not null);
create table resources (resource_id text primary key, device_id text not null, username text not null);
create table onus (onu_id text primary key, device_id text not null, serial text not null);
insert into kv values ('schema_version', '1'), ('signing_public_key', 'pin');
insert into attempts values ('a1','op1','res-1','dev','subscriber.provision',1,'{}','DONE','[]','{"outcome":"SUCCEEDED"}',1,'2026-01-01','2026-01-01');
"""


class Atualizacao(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "agent.sqlite")
        db = sqlite3.connect(self.path)
        db.executescript(V1)
        db.close()

    def cols(self, path):
        db = sqlite3.connect(path)
        try:
            return [r[1] for r in db.execute("pragma table_info(attempts)")]
        finally:
            db.close()

    def test_atualizacao_migra_preserva_dados_e_guarda_copia_do_schema_anterior(self):
        s = Store(self.path)
        self.assertEqual(int(s.get_kv("schema_version")), LOCAL_SCHEMA_VERSION)
        self.assertIn("agent_version", self.cols(self.path))
        self.assertEqual(s.finished_outcome("op1"), {"outcome": "SUCCEEDED"})       # evidência antiga continua utilizável
        self.assertEqual(s.get_kv("signing_public_key"), "pin")
        self.assertNotIn("agent_version", self.cols(backup_path(self.path, 1)))     # cópia é do schema anterior, íntegra
        Store(self.path)                                                            # reabrir não migra de novo nem falha

    def test_banco_novo_nasce_na_versao_atual_sem_copia(self):
        p = os.path.join(self.dir, "novo.sqlite")
        self.assertEqual(int(Store(p).get_kv("schema_version")), LOCAL_SCHEMA_VERSION)
        self.assertFalse(os.path.exists(backup_path(p, 1)))

    def test_rollback_restaura_a_copia_e_recusa_perder_trabalho_pendente(self):
        s = Store(self.path)
        s._x("insert into attempts (attempt_id, operation_id, resource_id, device_id, action, desired_version, envelope, status, created_at, updated_at)"
             " values ('a2','op2','res-1','dev','subscriber.suspend',2,'{}','EXECUTING','x','x')")
        s._db.close()
        with self.assertRaises(SystemExit) as e:
            rollback(self.path, 1)
        self.assertIn("trabalho não concluído", str(e.exception))
        self.assertIn("agent_version", self.cols(self.path))                         # nada foi trocado
        kept = rollback(self.path, 1, force=True)
        self.assertNotIn("agent_version", self.cols(self.path))                      # binário antigo volta a abrir este banco
        self.assertIn("agent_version", self.cols(kept))                              # o banco substituído fica guardado
        with self.assertRaises(SystemExit):
            rollback(self.path, 7)                                                   # sem cópia daquele schema


class DiscoCheio(unittest.TestCase):
    """SQLite devolvendo "database or disk is full" de verdade (limite de páginas), como num disco sem espaço."""

    def test_sem_registrar_a_tentativa_nada_e_escrito_no_equipamento_e_ao_liberar_espaco_a_operacao_segue(self):
        d = tempfile.mkdtemp()
        store, cloud = Store(os.path.join(d, "agent.sqlite")), FakeCloud()
        driver = DemoDriver(os.path.join(d, "nas.sqlite"), DEVICE, reconnect_after_s=0)
        ident = {"agent_id": AGENT, "tenant_id": TENANT, "public_key": PUB, "device_ids": {DEVICE}}
        ex = Executor(store, cloud, lambda _d: driver, lambda: ident)
        pages = store._db.execute("pragma page_count").fetchone()[0]
        store._db.execute(f"pragma max_page_count = {pages + 3}")
        fill = ("insert into attempts (attempt_id, operation_id, resource_id, device_id, action, desired_version, envelope, status, reported, created_at, updated_at)"
                " values (hex(randomblob(8)), 'lastro', 'r', 'd', 'a', 1, ?, 'DONE', 1, 'x', 'x')")
        for size in (1500, 40):                                                     # ocupa a folga até o SQLite recusar até linhas pequenas
            with self.assertRaises(sqlite3.Error):
                for _ in range(2000):
                    store._db.execute(fill, ("x" * size,))
        dv = delivery()
        with self.assertRaises(sqlite3.Error) as e:
            ex.handle(dv)
        self.assertIn("full", str(e.exception))
        self.assertEqual(driver.write_count("cliente01"), 0)                          # nenhuma escrita sem registro durável
        self.assertFalse(driver.read("cliente01").exists)
        self.assertEqual(cloud.results, [])                                           # nada foi dado como concluído nem como falho

        store._db.execute("pragma max_page_count = 1073741823")                       # espaço liberado
        ex.handle(dv)                                                                 # a nuvem reentrega a mesma tentativa
        self.assertEqual(cloud.results[-1][1]["outcome"], "SUCCEEDED")
        self.assertEqual(driver.write_count("cliente01", "authorization"), 1)


if __name__ == "__main__":
    unittest.main()
