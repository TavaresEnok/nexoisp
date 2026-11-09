"""Travas contra regressões já ocorridas: versões divergentes, loop de containers, material de terceiro e contagens desatualizadas."""
from collections import Counter
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
FORBIDDEN_TRACKED = ['docs/API-SGP-completa.txt', 'docs/sgp_mirror.zip', '.env', '.nexo.local']
spec = importlib.util.spec_from_file_location('doctor', ROOT / 'scripts/doctor.py')
doctor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(doctor)


def container(name, service, project='p', running=True, restarts=0, age=3600, depends=''):
    started = (datetime(2026, 1, 1, tzinfo=timezone.utc) - timedelta(seconds=age)).isoformat()
    return {'Name': '/' + name, 'RestartCount': restarts,
            'State': {'Running': running, 'Restarting': False, 'StartedAt': started},
            'Config': {'Labels': {'com.docker.compose.project': project, 'com.docker.compose.service': service,
                                  'com.docker.compose.depends_on': depends}}}


NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)


class Doctor(unittest.TestCase):
    def test_loop_detectado(self):
        loops, _ = doctor.analyze([container('vpn', 'vpn', restarts=47997, age=20)], NOW)
        self.assertEqual(len(loops), 1)

    def test_reinicios_antigos_com_container_estavel_nao_sao_loop(self):
        self.assertEqual(doctor.analyze([container('vpn', 'vpn', restarts=50, age=86400)], NOW), ([], []))

    def test_dependencia_parada_vira_aviso(self):
        items = [container('vpn', 'vpn', depends='db:service_healthy:false'), container('db', 'db', running=False)]
        self.assertEqual(len(doctor.analyze(items, NOW)[1]), 1)

    def test_migracao_concluida_nao_e_dependencia_parada(self):
        items = [container('api', 'api', depends='migrate:service_completed_successfully:false'), container('migrate', 'migrate', running=False)]
        self.assertEqual(doctor.analyze(items, NOW), ([], []))


class RepoGuards(unittest.TestCase):
    def test_versao_go_unica(self):
        version = re.search(r'^go (\S+)$', (ROOT / 'apps/api-go/go.mod').read_text(), re.M).group(1)
        for name in ('Dockerfile', 'Dockerfile.vpn'):
            images = re.findall(r'golang:([0-9.]+)', (ROOT / 'apps/api-go' / name).read_text())
            self.assertEqual(set(images), {version}, name)
        self.assertNotRegex((ROOT / 'nexo').read_text(), r'golang:[0-9]', 'o nexo deve derivar a versão do go.mod')

    def test_material_proibido_fora_do_git(self):
        tracked = set(subprocess.run(['git', 'ls-files'], cwd=ROOT, check=True, capture_output=True, text=True).stdout.splitlines())
        self.assertEqual(tracked.intersection(FORBIDDEN_TRACKED), set())

    def test_contagens_da_documentacao_iguais_a_matriz(self):
        states = Counter(i.get('integrationState') for i in json.loads((ROOT / 'docs/integracao-v0/matriz-funcional.json').read_text()))
        for doc in ('PLANO.md', 'MATRIZ_FUNCIONAL.md'):
            text = (ROOT / 'docs/integracao-v0' / doc).read_text()
            self.assertEqual(int(re.search(r'\*\*(\d+) unidades integradas e validadas\*\*', text).group(1)), states['validated'], doc)
            self.assertRegex(text, rf"\*\*{states['backend-preserved']} (unidades preservadas|serviços internos)")
        self.assertEqual(states['pending'], 0, 'unidade pendente: atualize PLANO.md e MATRIZ_FUNCIONAL.md ao aceitá-la')
