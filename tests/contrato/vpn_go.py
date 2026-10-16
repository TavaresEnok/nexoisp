#!/usr/bin/env python3
"""VPN/API/PostgreSQL Go em namespace de rede isolado, sem portas no host."""
import json
import subprocess
import time
import uuid
from lib import ROOT

suffix=uuid.uuid4().hex[:10]
DB='nexo-native-vpn-db-'+suffix
VPN='nexo-native-vpn-'+suffix
API='nexo-native-api-vpn-'+suffix

def run(*args):return subprocess.check_output(args,text=True).strip()
def sql(q):return run('docker','exec',DB,'psql','-U','nexo_owner','-d','nexo','-Atc',q)
def call(path,body,token=None):
    args=['docker','exec',API,'wget','-qO-','--header','Content-Type: application/json']
    if token:args+=['--header','Authorization: Bearer '+token]
    return json.loads(run(*args,'--post-data',json.dumps(body),'http://127.0.0.1:8080'+path))

try:
    run('docker','run','-d','--name',DB,'--network','none','-e','POSTGRES_USER=nexo_owner','-e','POSTGRES_PASSWORD=auditoria-local-owner','-e','POSTGRES_DB=nexo','postgres:16-alpine')
    for _ in range(120):
        if subprocess.run(['docker','exec',DB,'pg_isready','-h','127.0.0.1','-U','nexo_owner','-d','nexo'],capture_output=True).returncode==0:break
        time.sleep(.1)
    run('docker','run','--rm','--network','container:'+DB,
        '-e','DATABASE_URL_OWNER=postgres://nexo_owner:auditoria-local-owner@127.0.0.1:5432/nexo',
        '-e','NEXO_APP_DB_PASSWORD=auditoria-local-app','-e','NEXO_GO_DB_PASSWORD=auditoria-local-go',
        '--entrypoint','nexo-db','nexo-api-go:final','prepare')
    run('docker','run','-d','--name',VPN,'--network','container:'+DB,'--cap-add','NET_ADMIN','--device-cgroup-rule','c 108:0 rwm',
        '-e','DATABASE_URL_GO=postgres://nexo_go:auditoria-local-go@127.0.0.1:5432/nexo',
        '-e','NEXO_L2TP_PSK=chave-sintetica-ipsec-auditoria','-e','NEXO_RADIUS_KEY=chave-radius-sintetica-auditoria','nexo-vpn-go:final')
    for _ in range(80):
        if sql('select count(*) from vpn_settings')=='1':break
        time.sleep(.1)
    run('docker','run','--rm','--network','container:'+DB,
        '-e','DATABASE_URL_OWNER=postgres://nexo_owner:auditoria-local-owner@127.0.0.1:5432/nexo',
        '-e','NEXO_DEMO_MODE=1','--entrypoint','nexo-db','nexo-api-go:final','seed-demo')
    run('docker','run','-d','--name',API,'--network','container:'+DB,
        '-e','DATABASE_URL_GO=postgres://nexo_go:auditoria-local-go@127.0.0.1:5432/nexo',
        '-e','NEXO_DEMO_MODE=1','-e','NEXO_AGENT_MTLS=off','-e','NEXO_REQUIRE_ADMIN_MFA=0',
        '-e','NEXO_RADIUS_KEY=chave-radius-sintetica-auditoria',
        '-e','NEXO_L2TP_PSK=chave-sintetica-ipsec-auditoria','nexo-api-go:final')
    for _ in range(80):
        if subprocess.run(['docker','exec',API,'wget','-qO-','http://127.0.0.1:8080/api/health'],capture_output=True).returncode==0:break
        time.sleep(.1)
    token=call('/api/auth/login',{'email':'admin@alfa.demo','password':'demo1234'})['token']
    call('/api/radius/devices',{'name':'NAS WireGuard isolado','vendor':'mikrotik','connection':'vpn'},token)
    call('/api/radius/devices',{'name':'NAS L2TP isolado','vendor':'mikrotik','connection':'l2tp'},token)
    for _ in range(80):
        peers=run('docker','exec',VPN,'wg','show','wg0','peers')
        chap=run('docker','exec',VPN,'awk','/ nexoisp / {n++} END {print n+0}','/etc/ppp/chap-secrets')
        if peers and int(chap)>=1:break
        time.sleep(.1)
    assert peers and int(chap)>=1,'sincronização de peers/CHAP não ocorreu'
    assert sql('select count(*) from vpn_peers')=='1'
    assert sql('select count(*) from l2tp_peers')=='1'
    assert run('docker','exec',VPN,'pgrep','charon') and run('docker','exec',VPN,'pgrep','xl2tpd')
    before=sql('select public_key from vpn_settings')
    run('docker','restart',VPN)
    for _ in range(80):
        if run('docker','exec',VPN,'wg','show','wg0','public-key')==before:break
        time.sleep(.1)
    assert sql('select public_key from vpn_settings')==before
    result={'ok':True,'checks':['WireGuard real em namespace isolado','strongSwan e xl2tpd iniciados','NAS WireGuard/L2TP criados pela API Go','sincronização de peers e CHAP','reinício preserva chave do servidor']}
    (ROOT/'tests/contrato/relatorios/vpn-go.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(result,ensure_ascii=False))
finally:
    # These containers are all disposable fixtures, including their synthetic database.
    subprocess.run(['docker','rm','-f',API,VPN,DB],capture_output=True)
