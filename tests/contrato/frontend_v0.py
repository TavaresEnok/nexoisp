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
    # O cache incremental do Go evita custo desnecessário sem reutilizar código antigo.
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
        NEXO_GATEWAY_WEBHOOK_SECRET=base64.b64encode(os.urandom(32)).decode(),
        NEXO_SECRET_KEY=base64.b64encode(os.urandom(32)).decode(),
        NEXO_OP_SIGNING_KEY=base64.b64encode(subprocess.check_output(['openssl', 'genpkey', '-algorithm', 'ed25519', '-outform', 'DER'])).decode(),
        NEXO_DEMO_MODE='1', NEXO_REQUIRE_ADMIN_MFA='0', NEXO_AGENT_MTLS='off', NEXO_GO_JOBS='0',
        NEXO_GO_ADDR=f'127.0.0.1:{api_port}', NEXO_GO_INTERNAL_ADDR=f'127.0.0.1:{api_port+1000}', NEXO_GO_AGENT_ADDR=f'127.0.0.1:{api_port+2000}',
    )
    network_fixture = os.getenv("NEXO_V0_NETWORK") == "1"
    if network_fixture:
        env["NEXO_L2TP_PSK"] = "v0-fixture-l2tp-sintetica-000001"
        env["NEXO_VPN_PUBLIC_HOST"] = "203.0.113.254"
        env["NEXO_RADIUS_PUBLIC_HOST"] = "203.0.113.254"
    acs_server = None
    if os.getenv("NEXO_V0_ACS") == "1":
        from fixtures.acs_v0 import start
        acs_port = int(os.getenv("NEXO_V0_ACS_PORT", "18982"))
        acs_server = start(acs_port)
        env["NEXO_ACS_URL"] = f"http://127.0.0.1:{acs_port}"
        env["NEXO_ACS_PUBLIC_URL"] = "https://acs.exemplo.invalid:7547"
        env.update(NEXO_ACS_INSTANCE_ID="synthetic-v0-validation",NEXO_ACS_OWNERSHIP_ENABLED="1",NEXO_ACS_TASKS_ENABLED="1",NEXO_ACS_TASK_WRITE="1",NEXO_GO_JOBS="1",NEXO_GO_JOB_ACS_TASKS="1")
    else:
        env.pop("NEXO_ACS_URL", None)
        env.pop("NEXO_ACS_PUBLIC_URL", None)
    process = None
    log = open(LOCAL / ('frontend-v0-api.log' if api_port == 18881 else f'frontend-v0-api-{api_port}.log'), 'w')
    try:
        subprocess.run(['docker', 'run', '--rm', '-d', '--name', name, '--label', 'nexo.validation=v0', '--network', 'host', '-e', 'POSTGRES_USER=nexo_owner', '-e', f'POSTGRES_PASSWORD={owner}', '-e', 'POSTGRES_DB=nexo_v0_validation', 'postgres:16-alpine', 'postgres', '-p', str(port), '-c', 'listen_addresses=127.0.0.1'], check=True, stdout=subprocess.DEVNULL)
        for _ in range(100):
            result = subprocess.run(['docker', 'exec', name, 'pg_isready', '-p', str(port), '-U', 'nexo_owner'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if result.returncode == 0:
                break
            time.sleep(.1)
        else:
            raise RuntimeError('PostgreSQL de validação não iniciou')
        for task in ['prepare', 'seed-demo']:
            subprocess.run([str(ROOT/'apps/api-go/bin/nexo-db'), task], cwd=ROOT, env=env, check=True, stdout=log, stderr=log)
        if network_fixture:
            # Public key only: this fixture never starts a real WireGuard or IPsec tunnel.
            public_key = base64.b64encode(os.urandom(32)).decode()
            subprocess.run(['docker', 'exec', name, 'psql', '-p', str(port), '-U', 'nexo_owner', '-d', 'nexo_v0_validation', '-v', 'ON_ERROR_STOP=1', '-c', f"select vpn_set_server_key('{public_key}');"], check=True, stdout=log, stderr=log)
        process = subprocess.Popen([str(ROOT/'apps/api-go/bin/api')], cwd=ROOT, env=env, stdout=log, stderr=log)
        from lib import wait
        wait(f'http://127.0.0.1:{api_port}', '/api/health', process)
        if acs_server:
            # Test setup uses the real operator endpoint. Serial knowledge alone
            # does not create tenant ownership, even in the synthetic fixture.
            from lib import request
            operator_password="synthetic-v0-acs-operator-password"
            subprocess.run([str(ROOT/'apps/api-go/bin/nexo-db'),'create-operator','acs-operator@v0.invalid','Synthetic ACS operator'],cwd=ROOT,env=dict(env,NEXO_NEW_PASSWORD=operator_password),check=True,stdout=log,stderr=log)
            base=f"http://127.0.0.1:{api_port}"
            def acs_call(path,body=None,token=None):
                response=request(base,'/api'+path,token=token,method='POST' if body is not None else 'GET',headers={'Content-Type':'application/json'},body=json.dumps(body).encode() if body is not None else None)
                if response['status']!=200:raise RuntimeError((path,response['status'],response['json']))
                return response['json']
            op=acs_call('/auth/login',{'email':'acs-operator@v0.invalid','password':operator_password,'bearer':True})['token']
            admin=acs_call('/auth/login',{'email':'admin@alfa.demo','password':'demo1234','bearer':True})['token']
            tenant=acs_call('/me',token=admin)['tenant']['id']
            for serial in ['V0ACS098','V0ACS181']:
                acs_call('/acs/ownership/assign',{'tenant_id':tenant,'acs_device_id':serial,'serial':serial,'reason':'Synthetic validation inventory assignment'},op)
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
        if acs_server:
            acs_server.shutdown()
            acs_server.server_close()
        log.close()
        subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

if __name__ == '__main__':
    main()
