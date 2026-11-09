#!/usr/bin/env python3
"""Confere os containers do NexoISP neste host. Somente leitura.

Falha (saída 1) quando há container em loop de reinício; avisa quando um
container segue ativo com uma dependência do próprio projeto parada.
"""
from datetime import datetime, timezone
import json
import subprocess
import sys

LOOP_MIN_RESTARTS = 5
LOOP_MAX_UPTIME_S = 600
PROJECT_PREFIXES = ('nexo', 'radlab')


def _started(value):
    return datetime.fromisoformat(value[:19]).replace(tzinfo=timezone.utc)


def analyze(containers, now):
    """Retorna (loops, orfaos) como listas de mensagens."""
    loops, orphans = [], []
    by_service = {}
    for c in containers:
        labels = c['Config'].get('Labels') or {}
        by_service[(labels.get('com.docker.compose.project'), labels.get('com.docker.compose.service'))] = c
    for c in containers:
        name = c['Name'].lstrip('/')
        state = c['State']
        labels = c['Config'].get('Labels') or {}
        if not state.get('Running') and not state.get('Restarting'):
            continue
        uptime = (now - _started(state['StartedAt'])).total_seconds()
        if state.get('Restarting') or (c.get('RestartCount', 0) >= LOOP_MIN_RESTARTS and uptime < LOOP_MAX_UPTIME_S):
            loops.append(f"{name}: {c.get('RestartCount', 0)} reinícios; veja docker logs {name}")
        project = labels.get('com.docker.compose.project')
        for dep in filter(None, labels.get('com.docker.compose.depends_on', '').split(',')):
            service, condition = dep.split(':')[:2]
            target = by_service.get((project, service))
            if condition != 'service_completed_successfully' and (target is None or not target['State'].get('Running')):
                orphans.append(f"{name}: ativo, mas a dependência {service} de {project} está parada")
    return loops, orphans


def main():
    ids = subprocess.run(['docker', 'ps', '-aq'], check=True, capture_output=True, text=True).stdout.split()
    data = json.loads(subprocess.run(['docker', 'inspect', *ids], check=True, capture_output=True, text=True).stdout) if ids else []
    ours = [c for c in data if (c['Config'].get('Labels') or {}).get('com.docker.compose.project', c['Name'].lstrip('/')).startswith(PROJECT_PREFIXES)]
    loops, orphans = analyze(ours, datetime.now(timezone.utc))
    print(f"{len(ours)} containers do NexoISP conferidos")
    for line in loops:
        print('ERRO loop de reinício:', line)
    for line in orphans:
        print('AVISO stack incompleta:', line)
    if not loops and not orphans:
        print('nenhum problema encontrado')
    return 1 if loops else 0


if __name__ == '__main__':
    sys.exit(main())
