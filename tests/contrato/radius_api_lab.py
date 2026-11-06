#!/usr/bin/env python3
"""API -> River -> integrated RADIUS -> authenticated UDP, exclusively synthetic.

No writes to radius_* fixtures. Does not contact a real NAS or prove PPPoE.
Requires the nexo-audit-radius:local image (build infra/radius beforehand).
"""
import base64
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import tempfile
import time
import restore_clean_host as h

OUT = h.ROOT / 'docs/auditoria-2026-11-06/radius-api.json'


def access(address, source, secret, username, password):
    # PAP password hiding (RFC 2865), plus Message-Authenticator (RFC 2869).
    authenticator = os.urandom(16)
    raw = password.encode()
    raw += b'\0' * ((16 - len(raw) % 16) or 16)
    encrypted, previous = b'', authenticator
    for offset in range(0, len(raw), 16):
        block = bytes(a ^ b for a, b in zip(raw[offset:offset+16], hashlib.md5(secret.encode() + previous).digest()))
        encrypted += block
        previous = block
    attrs = bytes([1, len(username.encode())+2]) + username.encode() + bytes([2, len(encrypted)+2]) + encrypted
    attrs += bytes([80, 18]) + bytes(16)
    header = struct.pack('!BBH', 1, 37, 20+len(attrs)) + authenticator
    packet = header + attrs
    packet = packet[:-16] + hmac.new(secret.encode(), packet, hashlib.md5).digest()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind((source, 0))
        sock.settimeout(8)
        sock.connect((address, 1812))
        sock.send(packet)
        response = sock.recv(4096)
    assert len(response) >= 20 and response[1] == 37 and struct.unpack('!H', response[2:4])[0] == len(response)
    assert hmac.compare_digest(response[4:20], hashlib.md5(response[:4] + authenticator + response[20:] + secret.encode()).digest())
    return response[0]


def run():
    spec = h.new_spec()
    h.require_runtime()
    report = {'ok': False, 'base': h._git_head(), 'synthetic': True, 'checks': [], 'limits': ['PAP/UDP real; sem sessão PPPoE, accounting ou NAS físico', 'MikroTik/Huawei/Cisco físicos não homologados', 'não prova carga de 100 usuários nem RPO/RTO']}
    api = log = None
    radius_name = 'nexo-audit-radius-' + spec.run_id
    created = False
    with tempfile.TemporaryDirectory(prefix=f'nexo-b12-{spec.run_id}-') as directory:
        spec.work_dir = directory
        work = Path(directory)
        try:
            h._create_network(spec, os.environ)
            h._create_volume(spec, spec.source_volume, 'source')
            h._create_container(spec, spec.source_container, spec.source_volume, spec.source_port, spec.source_owner_password, 'source')
            h._wait_db(spec.source_container)
            h._psql(spec, spec.source_container, 'postgres', 'create database ' + spec.source_database)
            binaries = work / 'bin'
            binaries.mkdir()
            for binary, source in [('api', './cmd/api'), ('nexo-db', './cmd/nexo-db')]:
                h._checked(['go', 'build', '-o', str(binaries / binary), source], spec, env=h.toolchain_env(os.environ), cwd=h.ROOT / 'apps/api-go')
            spec.signing_key = base64.b64encode(subprocess.check_output(['openssl', 'genpkey', '-algorithm', 'ed25519', '-outform', 'DER'])).decode()
            env = h.process_env(spec, 'source', os.environ)
            for command in ('prepare', 'seed-demo'):
                h._checked([str(binaries / 'nexo-db'), command], spec, env=env, cwd=h.ROOT)
            env.update(NEXO_GO_JOBS='1', NEXO_GO_JOB_RADIUS='1')
            api, log, base = h._api(env, spec, work / 'api.log')
            login = h._call(base, '/api/auth/login', body={'email': 'admin@alfa.demo', 'password': 'demo1234', 'bearer': True})
            token = login['json']['token']
            def call(path, body=None):
                response = h._call(base, '/api' + path, token=token, body=body)
                assert response['status'] == 200, (path, response['status'])
                return response['json']
            network = json.loads(subprocess.check_output(['docker', 'network', 'inspect', spec.network]))[0]
            config = network['IPAM']['Config'][0]
            gateway = config.get('Gateway') or str(ipaddress.ip_network(config['Subnet']).network_address + 1)
            device = call('/radius/devices', {'name': 'NAS UDP sintético', 'vendor': 'mikrotik', 'connection': 'direct', 'nas_ip': gateway})
            plan = call('/plans', {'name': 'Plano API RADIUS sintético', 'price_cents': 3500, 'down_kbps': 100000, 'up_kbps': 50000, 'profile_name': 'audit-api'})
            subscriber = call('/subscribers', {'name': 'Assinante API RADIUS sintético'})
            contract = call('/contracts', {'subscriber_id': subscriber['id'], 'plan_id': plan['id'], 'due_day': 15})
            username, password = 'audit-' + spec.run_id, 'Synthetic-only-Password'
            service = call('/contracts/' + contract['id'] + '/service', {'device_id': device['id'], 'pppoe_username': username, 'password': password})
            operation = service['operation_id']
            def state():
                return h._psql(spec, spec.source_container, spec.source_database, "select status from operations where id='" + operation + "'")
            for _ in range(150):
                if state() == 'SUCCEEDED': break
                time.sleep(.1)
            assert state() == 'SUCCEEDED'
            identity = h._psql_json(spec, spec.source_container, spec.source_database,
                "select r.id::text resource_id,r.contract_id::text,c.subscriber_id::text,r.pppoe_username, o.id::text operation_id,o.status from service_resources r join contracts c on c.id=r.contract_id join operations o on o.resource_id=r.id where o.id='" + operation + "'")
            assert len(identity) == 1 and identity[0]['subscriber_id'] == subscriber['id'] and identity[0]['contract_id'] == contract['id']
            report['identity'] = identity[0]
            report['checks'].append('API cadastro/contrato/credencial -> job River -> operação SUCCEEDED; identidade SQL conferida')
            assert subprocess.run(['docker', 'inspect', radius_name], capture_output=True).returncode != 0
            security = ['--security-opt', 'seccomp=unconfined'] if os.environ.get('NEXO_RADIUS_LAB_OLD_DOCKER') == '1' else []
            report['docker_security_opt'] = security
            h._checked(['docker', 'run', '-d', '--name', radius_name, '--network', spec.network, *security,
                        '--label', 'nexo.audit.run=' + spec.run_id,
                        '-e', 'RADIUS_DB_HOST=' + spec.source_container, '-e', 'RADIUS_DB_PORT=5432',
                        '-e', 'RADIUS_DB_NAME=' + spec.source_database, '-e', 'RADIUS_DB_PASSWORD=' + spec.source_radius_db_password,
                        '-e', 'NEXO_RADIUS_KEY=' + spec.radius_key, 'nexo-audit-radius:local'], spec)
            created = True
            radius_ip = json.loads(subprocess.check_output(['docker', 'inspect', radius_name]))[0]['NetworkSettings']['Networks'][spec.network]['IPAddress']
            # Wait for the actual server ready log, not a fixed sleep or UDP retry.
            for _ in range(100):
                logs = subprocess.check_output(['docker', 'logs', radius_name], stderr=subprocess.STDOUT)
                if b'Ready to process requests' in logs: break
                time.sleep(.1)
            else:
                OUT.parent.mkdir(parents=True, exist_ok=True)
                (OUT.parent / 'radius-startup.log').write_text(h.redact(logs.decode(errors='replace'), spec.secrets() + [device['secret']]))
                raise RuntimeError('FreeRADIUS did not become ready; inspect radius-startup.log')
            assert access(radius_ip, gateway, device['secret'], username, password) == 2
            assert access(radius_ip, gateway, device['secret'], username, 'Wrong-synthetic-password') == 3
            report['checks'].append('FreeRADIUS real: PAP Access-Accept e senha errada Access-Reject; autenticador da resposta conferido')
            report['ok'] = True
        finally:
            if api: h._stop_process(api)
            if log: log.close()
            if created:
                h._checked(['docker', 'rm', '-f', radius_name], spec)
            h.cleanup(spec)
            OUT.parent.mkdir(parents=True, exist_ok=True)
            OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__': run()
