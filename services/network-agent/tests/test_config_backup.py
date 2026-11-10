"""Backup semanal de configuração: agenda vinda da nuvem, um equipamento por vez, espaçamento e nova tentativa."""
import os
import tempfile
import unittest
from datetime import datetime, timezone

from nexo_agent.config_backup import RETRY_AFTER_S, SCHEDULED_GAP_S, ConfigBackups, clean_cli_output
from nexo_agent.drivers.olt_demo import DemoOltDriver
from nexo_agent.drivers.olt_huawei import HuaweiOltDriver, OltCommandError
from nexo_agent.drivers.olt_huawei_emulator import HuaweiCliEmulator, OltState

NOW = 1_800_000_000.0


def iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


class Cloud:
    def __init__(self, next_due=None):
        self.sent, self.next_due = [], next_due

    def config_backup(self, body):
        self.sent.append(body)
        return {"ok": True, "next_due_at": self.next_due}


class Drv:
    def __init__(self, text="/system identity\nset name=X\n", fail=None):
        self.text, self.fail, self.calls = text, fail, 0

    def export_config(self):
        self.calls += 1
        if self.fail:
            raise RuntimeError(self.fail)
        return self.text


class Agenda(unittest.TestCase):
    def make(self, drivers, cloud=None):
        cloud = cloud or Cloud()
        return ConfigBackups(cloud, lambda: drivers, threaded=False), cloud

    def test_so_executa_o_que_venceu_e_um_por_vez(self):
        drivers = {"a": Drv(), "b": Drv(), "c": Drv()}
        b, cloud = self.make(drivers)
        b.update([{"device_id": "a", "due_at": iso(NOW - 10)}, {"device_id": "b", "due_at": iso(NOW - 99)}, {"device_id": "c", "due_at": iso(NOW + 3600)}])
        b.tick(NOW)
        self.assertEqual([s["device_id"] for s in cloud.sent], ["b"])  # o mais atrasado primeiro
        b.tick(NOW + 1)
        self.assertEqual(len(cloud.sent), 1, "agendados respeitam o intervalo entre backups")
        b.tick(NOW + SCHEDULED_GAP_S + 1)
        self.assertEqual([s["device_id"] for s in cloud.sent], ["b", "a"])
        b.tick(NOW + 2 * SCHEDULED_GAP_S + 2)
        self.assertEqual(len(cloud.sent), 2, "c ainda não venceu")
        self.assertTrue(all(s["ok"] and s["content"].startswith("/system") for s in cloud.sent))

    def test_pedido_do_painel_fura_o_intervalo_e_vai_primeiro(self):
        drivers = {"a": Drv(), "b": Drv()}
        b, cloud = self.make(drivers)
        b.update([{"device_id": "a", "due_at": iso(NOW - 500)}])
        b.tick(NOW)
        b.update([{"device_id": "b", "due_at": iso(NOW - 1), "manual": True}])
        b.tick(NOW + 5)
        self.assertEqual([s["device_id"] for s in cloud.sent], ["a", "b"])

    def test_nao_repete_ate_a_nuvem_mandar_nova_data(self):
        drivers = {"a": Drv()}
        b, cloud = self.make(drivers, Cloud(next_due=iso(NOW + 7 * 86400)))
        b.update([{"device_id": "a", "due_at": iso(NOW - 1)}])
        for k in range(5):
            b.tick(NOW + k * (SCHEDULED_GAP_S + 1))
        self.assertEqual(drivers["a"].calls, 1)
        self.assertGreater(b.schedule["a"]["due"], NOW + 6 * 86400)

    def test_falha_e_relatada_e_so_tenta_de_novo_depois_do_prazo(self):
        drivers = {"a": Drv(fail="SSH host key is absent from the configured trust file")}
        b, cloud = self.make(drivers)
        b.update([{"device_id": "a", "due_at": iso(NOW - 1)}])
        b.tick(NOW)
        self.assertEqual(cloud.sent[0], {"device_id": "a", "ok": False, "error": "SSH host key is absent from the configured trust file", "seconds": 0.0})
        failed_at = b.failed["a"]
        b.update([{"device_id": "a", "due_at": iso(NOW - 1)}])  # nuvem ainda diz "vencido"
        b.tick(failed_at + SCHEDULED_GAP_S + 1)
        self.assertEqual(drivers["a"].calls, 1)
        b.tick(failed_at + RETRY_AFTER_S + 1)
        self.assertEqual(drivers["a"].calls, 2)

    def test_novo_pedido_depois_da_falha_tenta_na_hora(self):
        drivers = {"a": Drv(fail="timeout")}
        b, cloud = self.make(drivers)
        b.update([{"device_id": "a", "due_at": iso(NOW - 1)}])
        b.tick(NOW)
        failed_at = b.failed["a"]
        b.update([{"device_id": "a", "due_at": iso(failed_at + 30), "manual": True}])
        b.tick(failed_at + 60)
        self.assertEqual(drivers["a"].calls, 2)

    def test_sem_agenda_da_nuvem_nada_acontece(self):
        drivers = {"a": Drv()}
        b, cloud = self.make(drivers)
        b.update(None)
        b.tick(NOW)
        b.update([])
        b.tick(NOW)
        self.assertEqual(drivers["a"].calls, 0)

    def test_driver_sem_exportacao_e_ignorado(self):
        b, cloud = self.make({"a": object()})
        b.update([{"device_id": "a", "due_at": iso(NOW - 1)}])
        b.tick(NOW)
        self.assertEqual(cloud.sent, [])


class Limpeza(unittest.TestCase):
    def test_remove_paginacao_cores_e_pergunta(self):
        raw = ("{ <cr>|section<K>||<K> }:\r\n[MA5800V100R019: 8211]\r\n#\r\n vlan 100 smart  \r\n"
               "  ---- More ( Press 'Q' to break ) ----\x1b[37D                                     \x1b[37D vlan 200 smart\r\nreturn\r\n\r\n")
        self.assertEqual(clean_cli_output(raw), "[MA5800V100R019: 8211]\n#\n vlan 100 smart\n vlan 200 smart\nreturn\n")
        # Como chega pelo NetmikoCli: cada página numa resposta, unidas por quebra de linha.
        pages = "[MA5800V100R019: 8211]\n vlan 100 smart\n  ---- More ( Press 'Q' to break ) ----\n\x1b[37D" + " " * 37 + "\x1b[37D vlan 200 smart\nreturn"
        self.assertEqual(clean_cli_output(pages), "[MA5800V100R019: 8211]\n vlan 100 smart\n vlan 200 smart\nreturn\n")


class Exportacao(unittest.TestCase):
    def test_huawei_exporta_configuracao_em_sessao_propria(self):
        state, sessions = OltState(), []

        def connect():
            sessions.append(HuaweiCliEmulator(state))
            return sessions[-1]
        olt = HuaweiOltDriver(connect)
        olt.authorize("48575443A1B2C3D4", pon_port="0/1/0", line_profile="residencial", service_profile="bridge-1ge", service_vlan=100, description="nexo:0a1b2c3d:v1")
        text = olt.export_config()
        self.assertIn('ont add 0 0 sn-auth "48575443A1B2C3D4"', text)
        self.assertIn("service-port", text)
        self.assertTrue(text.rstrip().endswith("return"))
        self.assertEqual(sessions[-1].log, ["display current-configuration"])
        self.assertIsNot(sessions[-1], olt._cli, "backup não usa a sessão das operações")

    def test_huawei_falha_vira_erro(self):
        class Broken:
            def run(self, c):
                return "  Failure: System is busy"

            def close(self):
                pass
        with self.assertRaises(OltCommandError):
            HuaweiOltDriver(lambda: Broken()).export_config()

    def test_olt_de_demonstracao_exporta_texto_ficticio(self):
        with tempfile.TemporaryDirectory() as d:
            text = DemoOltDriver(os.path.join(d, "o.sqlite"), "dev").export_config()
        self.assertIn("fictícia", text)


class Mikrotik(unittest.TestCase):
    def export(self, answers):
        from unittest import mock
        from nexo_agent.drivers.mikrotik_radius import MikrotikSessions
        sent, opened = [], []

        class Conn:
            def send_command(self, cmd, **kw):
                sent.append(cmd)
                return answers.pop(0)

            def disconnect(self):
                opened.append("closed")

        def fake_connect(device_type, host, port, *a, **kw):
            opened.append((device_type, host, port))
            return Conn()
        with mock.patch("nexo_agent.cli_transport.connect", fake_connect):
            text = MikrotikSessions("192.0.2.1", None, {"username": "u", "password": "p", "ssh_port": 2222}).export_config()
        return text, sent, opened

    def test_export_por_ssh_com_recuo_para_routeros_7(self):
        text, sent, opened = self.export(["expected end of command (line 1 column 9)", "# 2026-11-10 by RouterOS 7.17\n/system identity\nset name=BNG\n"])
        self.assertEqual(sent, ["/export hide-sensitive", "/export"])
        self.assertEqual(opened, [("mikrotik_routeros", "192.0.2.1", 2222), "closed"])
        self.assertIn("/system identity", text)

    def test_resposta_sem_configuracao_e_erro(self):
        with self.assertRaises(RuntimeError):
            self.export(["failure: not enough permissions"])


if __name__ == "__main__":
    unittest.main()
