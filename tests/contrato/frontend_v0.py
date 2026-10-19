#!/usr/bin/env python3
"""Backend descartável para validar a interface oficial; nunca lê .env do produto."""
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import uuid
from lib import ROOT, LOCAL, go


def main():
    LOCAL.mkdir(parents=True, exist_ok=True)
    port = int(os.getenv('NEXO_V0_DB_PORT', '15449'))
    api_port = int(os.getenv('NEXO_V0_API_PORT', '18881'))
    for candidate in [port, api_port, api_port + 1000, api_port + 2000]:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', candidate))
    if not (ROOT / 'apps/api-go/bin/api').exists():
        go('build', '-o', 'bin/nexo-db', './cmd/nexo-db')
        go('build', '-o', 'bin/api', './cmd/api')
    name = 'nexo-v0-validation-' + uuid.uuid4().hex[:8]
    owner = 'v0-owner-isolated-validation'
    env = dict(os.environ,
        DATABASE_URL_OWNER=f'postgres://nexo_owner:{owner}@127.0.0.1:{port}/nexo_v0_validation',
        DATABASE_URL_GO=f'postgres://nexo_go:v0-go-isolated-validation@127.0.0.1:{port}/nexo_v0_validation',
        DATABASE_URL_APP=f'postgres://nexo_app:v0-app-isolated-validation@127.0.0.1:{port}/nexo_v0_validation',
        NEXO_GO_DB_PASSWORD='v0-go-isolated-validation', NEXO_APP_DB_PASSWORD='v0-app-isolated-validation',
        NEXO_RADIUS_KEY='radius-chave-sintetica-v0-00000001', NEXO_RADIUS_DB_PASSWORD='v0-radius-isolated-validation',
        NEXO_REPLICA_PASSWORD='v0-replica-isolated-validation',
        NEXO_SECRET_KEY=base64.b64encode(os.urandom(32)).decode(),
        NEXO_OP_SIGNING_KEY=base64.b64encode(subprocess.check_output(['openssl', 'genpkey', '-algorithm', 'ed25519', '-outform', 'DER'])).decode(),
        NEXO_DEMO_MODE='1', NEXO_REQUIRE_ADMIN_MFA='0', NEXO_AGENT_MTLS='off', NEXO_GO_JOBS='0',
        NEXO_GO_ADDR=f'127.0.0.1:{api_port}', NEXO_GO_INTERNAL_ADDR=f'127.0.0.1:{api_port+1000}', NEXO_GO_AGENT_ADDR=f'127.0.0.1:{api_port+2000}',
    )
    process = None
    log = open(LOCAL / 'frontend-v0-api.log', 'w')
    try:
        subprocess.run(['docker', 'run', '--rm', '-d', '--name', name, '--label', 'nexo.validation=v0', '--network', 'host', '-e', 'POSTGRES_USER=nexo_owner', '-e', f'POSTGRES_PASSWORD={owner}', '-e', 'POSTGRES_DB=nexo_v0_validation', 'postgres:16-alpine', 'postgres', '-p', str(port)], check=True, stdout=subprocess.DEVNULL)
        for _ in range(100):
            result = subprocess.run(['docker', 'exec', name, 'pg_isready', '-p', str(port), '-U', 'nexo_owner'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if result.returncode == 0:
                break
            time.sleep(.1)
        else:
            raise RuntimeError('PostgreSQL de validação não iniciou')
        for task in ['prepare', 'seed-demo']:
            subprocess.run([str(ROOT/'apps/api-go/bin/nexo-db'), task], cwd=ROOT, env=env, check=True, stdout=log, stderr=log)
        process = subprocess.Popen([str(ROOT/'apps/api-go/bin/api')], cwd=ROOT, env=env, stdout=log, stderr=log)
        from lib import wait
        wait(f'http://127.0.0.1:{api_port}', '/api/health', process)
        print(json.dumps({'ready': True, 'api': f'http://127.0.0.1:{api_port}', 'isolated': True}), flush=True)
        if '--serve' in sys.argv:
            while process.poll() is None:
                time.sleep(1)
        else:
            subprocess.run(['node', 'frontend-v0.mjs'], cwd=ROOT/'e2e', check=True, env=dict(os.environ, V0_API=f'http://127.0.0.1:{api_port}'))
    finally:
        if process:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        log.close()
        subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

if __name__ == '__main__':
    main()
