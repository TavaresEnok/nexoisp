#!/usr/bin/env python3
"""Instalação e fluxos críticos exclusivamente em Go."""
import base64
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

from lib import ROOT, LOCAL, DB_CONTAINER, DB_PORT, command, go, go_env, sql, quote, request, wait

def records(query):
    return json.loads(sql("select coalesce(json_agg(r),'[]') from ("+query+") r",'nexo_test'))

def up():
    if subprocess.run(['docker','inspect',DB_CONTAINER],capture_output=True).returncode:
        command(['docker','run','-d','--name',DB_CONTAINER,'--network','host',
                 '-e','POSTGRES_USER=nexo_owner','-e','POSTGRES_PASSWORD=fase1-owner-local','-e','POSTGRES_DB=nexo_contrato_lab',
                 'postgres:16-alpine','postgres','-p',str(DB_PORT),
                 '-c','listen_addresses=127.0.0.1'],capture_output=True)
    else:command(['docker','start',DB_CONTAINER],capture_output=True)
    for _ in range(100):
        try:sql('select 1');break
        except subprocess.CalledProcessError:time.sleep(.1)
    else:raise RuntimeError('banco de laboratório indisponível')

def run():
    up();LOCAL.mkdir(exist_ok=True,parents=True)
    go('build','-o','bin/nexo-db','./cmd/nexo-db');go('build','-o','bin/api','./cmd/api')
    sql('drop database if exists nexo_test with (force);create database nexo_test','postgres')
    env=dict(go_env('nexo_test'),NEXO_DEMO_MODE='1',NEXO_REQUIRE_ADMIN_MFA='0',
             NEXO_RADIUS_KEY='radius-chave-sintetica-nativa-0001',NEXO_RADIUS_DB_PASSWORD='radius-senha-sintetica-nativa',
             NEXO_REPLICA_PASSWORD='replica-senha-sintetica-nativa',NEXO_SECRET_KEY=base64.b64encode(os.urandom(32)).decode(),
             NEXO_OP_SIGNING_KEY=base64.b64encode(subprocess.check_output(['openssl','genpkey','-algorithm','ed25519','-outform','DER'])).decode())
    cli=[str(ROOT/'apps/api-go/bin/nexo-db')]
    for task in ['prepare','prepare','seed-demo','seed-demo']:command(cli+[task],env=env,cwd=ROOT,capture_output=True)
    roles=records("select rolname,rolcanlogin,rolreplication,rolsuper,rolbypassrls from pg_roles where rolname in ('nexo_go','nexo_radius','nexo_replica')")
    assert len(roles)==3 and all(r['rolcanlogin'] and not r['rolsuper'] and not r['rolbypassrls'] for r in roles)
    assert next(r for r in roles if r['rolname']=='nexo_replica')['rolreplication']
    command(cli+['create-operator','operador@native.invalid','Operador de ensaio'],env=dict(env,NEXO_NEW_PASSWORD='senha-sintetica-12345'),cwd=ROOT,capture_output=True)
    processes=[];checks=['instalação Go idempotente','seed Go idempotente','papéis RADIUS e réplica','operador Go']
    try:
        for i in range(2):
            process_env=dict(env,NEXO_GO_ADDR='127.0.0.1:'+str(18881+i),NEXO_GO_INTERNAL_ADDR='127.0.0.1:'+str(19881+i),NEXO_GO_AGENT_ADDR='127.0.0.1:'+str(18843+i),NEXO_GO_JOBS='1',NEXO_GO_JOB_RADIUS='1',NEXO_GO_JOB_CLEANUP='1')
            log=open(LOCAL/('nativo-'+str(i)+'.log'),'w')
            p=subprocess.Popen([str(ROOT/'apps/api-go/bin/api')],cwd=ROOT,env=process_env,stdout=log,stderr=subprocess.STDOUT);processes.append((p,log))
            wait('http://127.0.0.1:'+str(19881+i),'/healthz',p)
        bases=['http://127.0.0.1:18881','http://127.0.0.1:18882']
        def call(path,body=None,base=bases[0],method=None,token=None):
            return request(base,path,token=token,method=method or ('POST' if body is not None else 'GET'),headers={'Content-Type':'application/json'} if body is not None else {},body=json.dumps(body).encode() if body is not None else None)
        login=call('/api/auth/login',{'email':'admin@alfa.demo','password':'demo1234','bearer':True});assert login['status']==200,login['json'];token=login['json']['token']
        def api(path,body=None,base=bases[0],method=None):return call(path,body,base,method,token)
        plan=api('/api/plans',{'name':'Plano nativo','price_cents':3500,'down_kbps':1000,'up_kbps':1000,'profile_name':'native'})['json']
        sub=api('/api/subscribers',{'name':'Assinante nativo'})['json']
        contract=api('/api/contracts',{'subscriber_id':sub['id'],'plan_id':plan['id'],'due_day':15})['json']
        invoice=api('/api/invoices',{'contract_id':contract['id'],'description':'Concorrência nativa','amount_cents':3500,'due_date':'2026-10-20'})['json']
        pay={'intent_id':str(uuid.uuid4()),'amount_cents':3500,'paid_at':'2026-10-16','note':'Concorrência de duas réplicas Go'}
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            result=list(pool.map(lambda base:api('/api/invoices/'+invoice['id']+'/manual-payment',pay,base),bases))
        assert sorted(r['status'] for r in result)==[200,200],result
        assert records('select count(*)::int as n from payments where invoice_id='+quote(invoice['id']))[0]['n']==1
        checks.append('baixa concorrente entre duas réplicas Go')
        payment=records('select id from payments where invoice_id='+quote(invoice['id']))[0]['id']
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            first=pool.submit(api,'/api/invoices/'+invoice['id']+'/payments/'+payment+'/reverse',{'reason':'Estorno concorrente de laboratório'},bases[0])
            second=pool.submit(api,'/api/invoices/'+invoice['id']+'/manual-payment',dict(pay,intent_id=str(uuid.uuid4())),bases[1])
            reversal,repayment=first.result(),second.result()
        assert reversal['status']==200 and repayment['status'] in [200,400],(reversal,repayment)
        checks.append('estorno concorrente com baixa entre réplicas Go')
        disputed=api('/api/invoices',{'contract_id':contract['id'],'description':'Acordo concorrente','amount_cents':5000,'due_date':'2026-10-20'})['json']
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            first=pool.submit(api,'/api/contracts/'+contract['id']+'/agreement',{'invoice_ids':[disputed['id']],'installments':2,'first_due_date':'2026-11-10','reason':'Acordo concorrente de laboratório'},bases[0])
            second=pool.submit(api,'/api/invoices/'+disputed['id']+'/manual-payment',dict(pay,amount_cents=5000,intent_id=str(uuid.uuid4())),bases[1])
            agreement,payment=first.result(),second.result()
        assert sorted([agreement['status'],payment['status']]) in [[200,400],[200,409]],(agreement,payment)
        assert not records('select id from invoices i where i.contract_id='+quote(contract['id'])+" and i.status='paid' and not exists(select 1 from payments p where p.invoice_id=i.id)")
        checks.append('acordo concorrente com baixa e invariantes financeiras')
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            result=list(pool.map(lambda base:api('/api/finance/generate',{'competence':'2026-10'},base),bases))
        assert all(r['status']==200 for r in result),result
        assert not records('select contract_id,competence from invoices where contract_id='+quote(contract['id'])+' and competence is not null group by contract_id,competence having count(*)>1')
        checks.append('geração financeira concorrente sem duplicação')
        device=api('/api/radius/devices',{'name':'NAS nativo','vendor':'mikrotik','connection':'direct','nas_ip':'127.0.0.1'})
        assert device['status']==200,device['json']
        service=api('/api/contracts/'+contract['id']+'/service',{'device_id':device['json']['id'],'pppoe_username':'native_'+uuid.uuid4().hex[:12],'password':'senha-pppoe-nativa'})
        assert service['status']==200,service['json'];op=service['json']['operation_id']
        assert records("select id from nexo_jobs.river_job where kind='nexo_operation' and args->>'operation_id'="+quote(op))
        for _ in range(80):
            state=records('select status from operations where id='+quote(op))[0]['status']
            if state=='SUCCEEDED':break
            time.sleep(.1)
        assert state=='SUCCEEDED',state
        assert records('select count(*)::int as n from operation_attempts where operation_id='+quote(op))[0]['n']==1
        checks.append('outbox River e execução única com duas réplicas')
        resource=service['json']['resource_id']
        before=records('select desired_version from service_resources where id='+quote(resource))[0]['desired_version']
        count=records("select count(*)::int as n from nexo_jobs.river_job where kind='nexo_operation'")[0]['n']
        sql("create function native_fail_audit() returns trigger language plpgsql as $$begin if new.action='service.provision' then raise exception 'falha sintética após enfileirar';end if;return new;end$$; create trigger native_fail_audit before insert on audit_events for each row execute function native_fail_audit()",'nexo_test')
        try:
            failed=api('/api/resources/'+resource+'/provision',{'reason':'Ensaio de rollback do outbox'})
            assert failed['status']==500,failed['json']
            assert records('select desired_version from service_resources where id='+quote(resource))[0]['desired_version']==before
            assert records("select count(*)::int as n from nexo_jobs.river_job where kind='nexo_operation'")[0]['n']==count
        finally:sql('drop trigger native_fail_audit on audit_events;drop function native_fail_audit()','nexo_test')
        checks.append('rollback atômico de intenção, job e auditoria')
        manifest={(r['method'],r['path']) for r in json.loads((ROOT/'apps/api-go/rotas.json').read_text())['routes'] if not r['path'].startswith('/agent/')}
        schema=request('http://127.0.0.1:19881','/openapi.json')['json']
        import re
        actual={(method.upper(),re.sub(r'\{([^}]+)\}',r':\1',path)) for path,item in schema['paths'].items() for method in item if method.upper() in ['GET','POST','PUT','PATCH','DELETE']}
        assert manifest==actual,(manifest-actual,actual-manifest);checks.append('operações reais iguais ao inventário')
        command([sys.executable,str(ROOT/'tests/contrato/payment_intents.py')],env=dict(env,NEXO_PAYMENT_LAB='1',NEXO_PAYMENT_LAB_URL=bases[0],NEXO_PAYMENT_LAB_URL_2=bases[1]))
        checks.append('intenção persistente: replay concorrente, conflito, estorno e resumos residuais')
        command([sys.executable,str(ROOT/'tests/contrato/financial_connections.py')],env=dict(env,NEXO_PAYMENT_LAB='1',NEXO_PAYMENT_LAB_URL=bases[0],NEXO_PAYMENT_LAB_URL_2=bases[1]))
        checks.append('B03: conexões, assinatura, inbox e IDs financeiros isolados')
    finally:
        for p,log in processes:
            p.terminate()
            try:p.wait(timeout=15)
            except subprocess.TimeoutExpired:p.kill();p.wait()
            log.close()
    old=env['NEXO_SECRET_KEY'];env['NEXO_SECRET_KEY']=base64.b64encode(os.urandom(32)).decode();env['NEXO_SECRET_KEY_PREVIOUS']=old
    command(cli+['rotate-secrets'],env=env,cwd=ROOT,capture_output=True)
    rotated=command(cli+['rotate-secrets'],env=env,cwd=ROOT,capture_output=True).stdout
    assert 'recifrados: 0; 0 pendente(s)' in rotated;checks.append('rotação Go com chave anterior e reexecução idempotente')
    (ROOT/'tests/contrato/relatorios').mkdir(parents=True,exist_ok=True)
    (ROOT/'tests/contrato/relatorios/nativo.json').write_text(json.dumps({'checks':checks,'ok':True},ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'checks':checks,'ok':True},ensure_ascii=False))

if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='up':up()
    else:run()
