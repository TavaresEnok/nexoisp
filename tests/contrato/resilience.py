#!/usr/bin/env python3
"""Resilience checks against an exclusive disposable container, never product .env."""
import base64
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

os.environ.setdefault('NEXO_CONTRATO_DB_CONTAINER','nexo-resilience-db')
os.environ.setdefault('NEXO_CONTRATO_DB_PORT','15679')
from lib import ROOT, LOCAL, DB_CONTAINER, DB_PORT, command, go, go_env, sql, request, wait
from nativo import up


def main():
    if not DB_CONTAINER.startswith('nexo-resilience-'):
        raise RuntimeError('container deve ser exclusivo nexo-resilience-*')
    target=ROOT/'tests/contrato/relatorios/resilience.json'
    target.unlink(missing_ok=True)
    up(); LOCAL.mkdir(exist_ok=True,parents=True)
    sql('drop database if exists nexo_test with (force);create database nexo_test','postgres')
    env=dict(go_env('nexo_test'),NEXO_DEMO_MODE='1',NEXO_REQUIRE_ADMIN_MFA='0',NEXO_GO_JOBS='0',
             NEXO_PANEL_RATE_PER_MIN='30',NEXO_COOKIE_SECURE='0',
             NEXO_SECRET_KEY=base64.b64encode(os.urandom(32)).decode(),
             NEXO_RADIUS_KEY='chave-radius-sintetica-resiliencia-001',
             NEXO_OP_SIGNING_KEY=base64.b64encode(subprocess.check_output(['openssl','genpkey','-algorithm','ed25519','-outform','DER'])).decode())
    # No ambient production flag or external destination may enter this lab.
    for key in list(env):
        if key.startswith('NEXO_GO_JOB_'): env[key]='0'
    env.update(NODE_ENV='test',NEXO_ALERT_WEBHOOK_URL='',NEXO_ACS_URL='',NEXO_ACS_PUBLIC_URL='',NEXO_AGENT_TLS_DIR='')
    go('build','-o','bin/nexo-db','./cmd/nexo-db');go('build','-o','bin/api','./cmd/api')
    cli=[str(ROOT/'apps/api-go/bin/nexo-db')]
    for task in ['prepare','seed-demo']:
        command(cli+[task],cwd=ROOT,env=env,capture_output=True)
    # Real tenant tasks, failure injection, durable retry and restart.
    go('test','-count=1','-race','-run','TestTenantFailureAndRestart','./internal/jobs',
       env=dict(env,NEXO_GO_TEST_DATABASE_URL=env['DATABASE_URL_GO']))
    processes=[]
    try:
        for i in range(2):
            process_env=dict(env,NEXO_GO_ADDR=f'127.0.0.1:{18891+i}',NEXO_GO_INTERNAL_ADDR=f'127.0.0.1:{19891+i}',NEXO_GO_AGENT_ADDR=f'127.0.0.1:{18943+i}')
            log=open(LOCAL/f'resilience-{i}.log','w')
            process=subprocess.Popen([str(ROOT/'apps/api-go/bin/api')],cwd=ROOT,env=process_env,stdout=log,stderr=subprocess.STDOUT)
            processes.append((process,log,process_env))
            wait(f'http://127.0.0.1:{19891+i}','/healthz',process)
        bases=['http://127.0.0.1:18891','http://127.0.0.1:18892']
        def login(email):
            result=request(bases[0],'/api/auth/login',method='POST',headers={'Content-Type':'application/json'},
                           body=json.dumps({'email':email,'password':'demo1234','bearer':True}).encode())
            assert result['status']==200,result['json']
            return result['json']['token']
        token=login('admin@alfa.demo');other=login('admin@beta.demo')
        # Keep this short concurrent check within one minute bucket.
        if time.time()%60>45:
            time.sleep(61-time.time()%60)
        with concurrent.futures.ThreadPoolExecutor(12) as pool:
            result=list(pool.map(lambda i:request(bases[i%2],'/api/me',token=token)['status'],range(60)))
        assert result.count(200)==30 and result.count(429)==30,result
        assert request(bases[1],'/api/me',token=other)['status']==200
        setup=request(bases[1],'/api/me/mfa/setup',token=other,method='POST',headers={'Content-Type':'application/json'},body=b'{}')
        assert setup['status']==200,setup['json']
        process,log,process_env=processes[0]
        process.terminate();process.wait(timeout=15)
        process=subprocess.Popen([str(ROOT/'apps/api-go/bin/api')],cwd=ROOT,env=process_env,stdout=log,stderr=subprocess.STDOUT)
        processes[0]=(process,log,process_env);wait('http://127.0.0.1:19891','/healthz',process)
        assert request(bases[0],'/api/me',token=token)['status']==429
        command(['python3','scripts/monitor.py','--url',bases[0]+'/api/health'],cwd=ROOT)
        command(['python3','scripts/capacity.py','--base',bases[0],'--laboratory','--requests','8','--concurrency','2','--max-p95-ms','5000'],
                env=dict(env,NEXO_CAPACITY_TOKEN=other),cwd=ROOT)
    finally:
        for process,log,_ in processes:
            process.terminate();process.wait(timeout=15);log.close()
    # Backup source is renamed inside this isolated container only.
    sql('alter database nexo_test rename to nexo','postgres')
    command(['docker','exec',DB_CONTAINER,'psql','-p',str(DB_PORT),'-U','nexo_owner','-d','nexo','-c',
             "insert into radius_account(tenant_id,username,secret_enc,policy,profile,applied_version) select id,'restore-proof',pgp_sym_encrypt('synthetic-password','chave-radius-sintetica-resiliencia-001'),'active','synthetic-profile',1 from tenants where slug='alfa'"],capture_output=True)
    backup_env=dict(env,NEXO_DB_CONTAINER=DB_CONTAINER,NEXO_DB_PORT=str(DB_PORT),NEXO_RESTORE_VERIFY='python3 tests/contrato/verify_restore.py')
    try:
        with tempfile.TemporaryDirectory(prefix='nexo-backup-proof-') as directory:
            command(['bash','scripts/backup.sh','backup',directory],cwd=ROOT,env=backup_env,capture_output=True)
            dump=next(Path(directory).glob('*.dump'))
            # Subsequent live data must not change the snapshot's expectations.
            command(['docker','exec',DB_CONTAINER,'psql','-p',str(DB_PORT),'-U','nexo_owner','-d','nexo','-c',
                     "insert into tenants(name,slug) values('Provedor posterior fictício','posterior-ficticio')"],capture_output=True)
            command(['bash','scripts/backup.sh','restore-check',str(dump)],cwd=ROOT,env=backup_env)
            # A wrong key must reject recovery, without printing any secret.
            wrong=dict(backup_env,NEXO_SECRET_KEY=base64.b64encode(os.urandom(32)).decode())
            rejected=subprocess.run(['bash','scripts/backup.sh','restore-check',str(dump)],cwd=ROOT,env=wrong,capture_output=True)
            assert rejected.returncode!=0 and b'chave incompat' in rejected.stderr
            wrong_radius=dict(backup_env,NEXO_RADIUS_KEY='chave-incorreta-sintetica-resiliencia')
            rejected=subprocess.run(['bash','scripts/backup.sh','restore-check',str(dump)],cwd=ROOT,env=wrong_radius,capture_output=True)
            assert rejected.returncode!=0 and b'chave RADIUS incompat' in rejected.stderr
            # Altered manifest must be refused before restore.
            manifest=Path(str(dump)+'.manifest.json');manifest.write_text(manifest.read_text()+' ')
            result=subprocess.run(['bash','scripts/backup.sh','restore-check',str(dump)],cwd=ROOT,env=backup_env,capture_output=True)
            assert result.returncode!=0 and b'soma de verifica' in result.stdout
    finally:
        command(['docker','exec',DB_CONTAINER,'psql','-p',str(DB_PORT),'-U','nexo_owner','-d','postgres','-c',
                 'alter database nexo rename to nexo_test'],capture_output=True)
    report={'ok':True,'checks':['tenant job failure isolation','durable retry and restart','billing idempotency',
            'atomic session rate across replicas','rate survives restart','independent sessions',
            'backup snapshot consistency after live writes','restored policies and tenant isolation','HTTP monitor and bounded capacity probe','restored real login','AES and RADIUS keys verified and wrong keys rejected','altered manifest rejected']}
    target.parent.mkdir(exist_ok=True,parents=True)
    report['generated_at_utc']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
    target.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))

if __name__=='__main__':
    main()
