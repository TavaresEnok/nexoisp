"""69->72 upgrade, encrypted vault rotation and isolated logical restore.

Only a new, uniquely named loopback container is used. No product env is loaded.
The TLS client certificate and all account details are synthetic; dispatch is off.
"""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid

assert os.environ.get('NEXO_PAYMENT_LAB') == '1'
os.environ['NEXO_CONTRATO_DB_CONTAINER'] = 'nexo-b07-pipeline-' + uuid.uuid4().hex[:10]
os.environ['NEXO_CONTRATO_DB_PORT'] = '15696'
from lib import ROOT, DB_CONTAINER, DB_PORT, command, go_env, sql, request, wait, quote
from nativo import up

cli = [str(ROOT/'apps/api-go/bin/nexo-db')]
base = 'http://127.0.0.1:19167'
restore = 'nexo_restore_check_20261026_72'
env = dict(go_env('nexo_test'), NEXO_DEMO_MODE='1', NEXO_REQUIRE_ADMIN_MFA='0',
           NEXO_SECRET_KEY=base64.b64encode(os.urandom(32)).decode(),
           NEXO_RADIUS_KEY='b07-pipeline-synthetic-radius-0001',
           NEXO_GO_ADDR='127.0.0.1:19167', NEXO_GO_INTERNAL_ADDR='127.0.0.1:19267',
           NEXO_GO_AGENT_ADDR='127.0.0.1:19367', NEXO_GO_JOBS='0',
           NEXO_GO_EFI_SANDBOX_ENABLED='1', NEXO_GO_EFI_DISPATCH='0')

def clone_sql(query):
    return command(['docker','exec','-i',DB_CONTAINER,'psql','-X','-qAt','-v','ON_ERROR_STOP=1',
                    '-p',str(DB_PORT),'-U','nexo_owner','-d',restore], input=query, capture_output=True).stdout.strip()

def start(runtime, log):
    p = subprocess.Popen([str(ROOT/'apps/api-go/bin/api')], cwd=ROOT, env=runtime,
                         stdout=log, stderr=subprocess.STDOUT)
    try:
        wait(base, '/api/health', p)
    except BaseException:
        stop(p)
        raise
    return p

def stop(p):
    p.terminate()
    try: p.wait(timeout=15)
    except subprocess.TimeoutExpired: p.kill(); p.wait()

def call(path, body=None, token=None, method=None):
    return request(base, '/api'+path, token=token, method=method or ('POST' if body is not None else 'GET'),
                   headers={'Content-Type':'application/json'}, body=json.dumps(body).encode() if body is not None else None)

def login():
    r=call('/auth/login', {'email':'admin@alfa.demo','password':'demo1234','bearer':True})
    assert r['status']==200
    return r['json']['token']

def api(token, path, body=None, method=None):
    r=call(path, body, token, method)
    assert r['status']==200, (path, r['status'], r['json'])
    return r['json']

financial="select jsonb_build_object('invoices',(select jsonb_agg(jsonb_build_object('id',id,'status',status,'amount',amount_cents,'fee',fee_cents,'discount',discount_cents,'due',due_date) order by id) from invoices),'payments',(select jsonb_agg(p order by id) from payments p),'movements',(select jsonb_agg(m order by id) from invoice_movements m),'effects',(select jsonb_agg(e order by id) from payment_effects e))"

with tempfile.TemporaryDirectory(prefix='nexo-b07-pipeline-') as tmp, tempfile.TemporaryFile() as log:
    stage=Path(tmp); shutil.copytree(ROOT/'db',stage/'db')
    target=stage/'target72';shutil.copytree(ROOT/'db',target/'db')
    for migration in (target/'db/migrations').glob('*.sql'):
        if int(migration.name.split('_')[0])>72:migration.unlink()
    for migration in (stage/'db/migrations').glob('*.sql'):
        if int(migration.name.split('_')[0])>69: migration.unlink()
    assert subprocess.run(['docker','inspect',DB_CONTAINER],capture_output=True).returncode!=0
    try:
        up(); sql('create database nexo_test','postgres')
        command(cli+['prepare'],cwd=stage,env=env,capture_output=True)
        command(cli+['seed-demo'],cwd=stage,env=env,capture_output=True)
        sql("""insert into invoices(tenant_id,contract_id,subscriber_id,kind,due_date,amount_cents,status_note)
          select tenant_id,id,subscriber_id,'manual','2026-11-15',12345,'legacy69' from contracts order by id limit 1;
          insert into financial_connections(tenant_id,company_id,provider,environment,account_ref,name)
          select tenant_id,company_id,'efi','sandbox','legacy69','Legacy migration fixture' from invoices where status_note='legacy69';
          insert into provider_issuance(tenant_id,invoice_id,financial_connection_id,intent_key,request,config_hash)
          select i.tenant_id,i.id,c.id,i.id::text,jsonb_build_object('invoice_id',i.id,'intent_key',i.id,'scope',jsonb_build_object('tenant_id',i.tenant_id,'connection_id',c.id,'provider','efi','environment','sandbox','account_ref',c.account_ref),'money',jsonb_build_object('amount_cents',12345,'currency','BRL'),'due_date',i.due_date),repeat('a',64)
          from invoices i join financial_connections c on c.tenant_id=i.tenant_id and c.account_ref='legacy69' where i.status_note='legacy69';
          update provider_issuance set state='uncertain' where financial_connection_id in(select id from financial_connections where account_ref='legacy69');""",'nexo_test')
        before=sql(financial,'nexo_test')
        command(cli+['prepare'],cwd=target,env=env,capture_output=True)
        command(cli+['prepare'],cwd=target,env=env,capture_output=True)
        assert sql(financial,'nexo_test')==before
        assert sql("select count(*) from provider_issuance where state='uncertain' and credential_version_id is null and product='pix_cob'",'nexo_test')=='1'
        assert sql('select max(version_id) from goose_db_version','nexo_test')=='72'
        # The historical 69->72 data contract is asserted above. Current generated
        # API readers may require later additive columns; recovery/API checks use
        # the current schema, not an unsupported new-binary/old-schema pairing.
        command(cli+['prepare'],cwd=ROOT,env=env,capture_output=True)
        assert sql(financial,'nexo_test')==before
        api_schema=int(sql('select max(version_id) from goose_db_version','nexo_test'))
        cert=stage/'client.pem'; key=stage/'client.key'
        command(['openssl','req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','1','-subj','/CN=synthetic-pipeline','-keyout',str(key),'-out',str(cert)],capture_output=True)
        secret={'client_id':'SYNTHETIC-PIPELINE-CLIENT','client_secret':'SYNTHETIC-PIPELINE-SECRET',
                'pix_key':'synthetic-original-key','certificate_pem':cert.read_text(),'private_key_pem':key.read_text()}
        p=start(env,log)
        try:
            token=login(); sub=api(token,'/subscribers',{'name':'Synthetic recovery'})
            contract=api(token,'/contracts',{'subscriber_id':sub['id'],'plan_id':api(token,'/plans')[0]['id'],'due_day':15})
            inv=api(token,'/invoices',{'contract_id':contract['id'],'description':'Pipeline recovery','amount_cents':12345,'due_date':'2026-11-15'})
            company=api(token,'/invoices/'+inv['id'])['company_id']
            connection=api(token,'/financial-connections',{'name':'Synthetic recovery','provider':'efi','environment':'sandbox','account_ref':uuid.uuid4().hex,'company_id':company})
            path='/financial-connections/'+connection['id']
            first=api(token,path+'/credentials',secret)
            api(token,path,{'status':'active'},'PATCH')
            body={'invoice_id':inv['id'],'intent_id':str(uuid.uuid4()),'options':{'product':'pix_cob'}}
            item=api(token,path+'/issuance',body)
            api(token,path+'/credentials',dict(secret,pix_key='synthetic-rotated-key',client_secret='SYNTHETIC-ROTATED'))
        finally: stop(p)
        # Rekey the real saved envelope, then re-run the API's frozen semantics
        # validation with ONLY the new key (no previous-key fallback).
        old=env['NEXO_SECRET_KEY']; env['NEXO_SECRET_KEY']=base64.b64encode(os.urandom(32)).decode()
        command(cli+['rotate-secrets'],cwd=ROOT,env=dict(env,NEXO_SECRET_KEY_PREVIOUS=old),capture_output=True)
        output=command(cli+['rotate-secrets'],cwd=ROOT,env=env,capture_output=True).stdout
        assert 'recifrados: 0; 0 pendente(s)' in output
        p=start(env,log)
        try:
            token=login(); again=api(token,path+'/issuance',body)
            assert again['id']==item['id'] and again['credential_version_id']==first['id']
        finally: stop(p)
        snapshot="select jsonb_build_object('credentials',(select jsonb_agg(c order by id) from financial_credential_versions c),'journal',(select jsonb_agg(j order by id) from provider_issuance j),'notices',(select jsonb_agg(n order by id) from provider_notices n),'invoices',(select jsonb_agg(i order by id) from invoices i))"
        expected=sql(snapshot,'nexo_test')
        dump=command(['docker','exec',DB_CONTAINER,'pg_dump','-p',str(DB_PORT),'-U','nexo_owner','-d','nexo_test'],capture_output=True).stdout
        sql('create database '+restore,'postgres')
        clone_sql(dump)
        assert clone_sql(snapshot)==expected
        verifyenv=dict(env,NEXO_RESTORE_DATABASE=restore)
        command(cli+['verify-restore'],cwd=ROOT,env=verifyenv,capture_output=True)
        wrong=dict(verifyenv,NEXO_SECRET_KEY=base64.b64encode(os.urandom(32)).decode())
        result=subprocess.run(cli+['verify-restore'],cwd=ROOT,env=wrong,capture_output=True,text=True)
        assert result.returncode!=0 and 'chave incompatível' in result.stderr
        restored_env=dict(env,DATABASE_URL_GO=env['DATABASE_URL_GO'].replace('/nexo_test','/'+restore),DATABASE_URL_APP=env['DATABASE_URL_APP'].replace('/nexo_test','/'+restore))
        p=start(restored_env,log)
        try:
            token=login(); restored_item=api(token,path+'/issuance',body)
            assert restored_item['id']==item['id'] and restored_item['credential_version_id']==first['id']
            assert len(api(token,path+'/credentials'))==2
        finally: stop(p)
        assert clone_sql(snapshot)==expected
        for name in ['00070_financial_credentials.sql','00071_provider_dispatch.sql','00072_provider_notices.sql']:
            try: sql((ROOT/'db/migrations'/name).read_text().split('-- +goose Down')[1],'nexo_test')
            except subprocess.CalledProcessError as e: assert 'Preserve' in e.stderr
            else: raise AssertionError('destructive down was accepted: '+name)
        report={'ok':True,'from':69,'to':72,'api_recovery_schema':api_schema,'financial_history_preserved':True,'legacy_uncertain_not_rebound':True,
                'rekey_frozen_semantics':True,'new_key_only':True,'logical_restore':True,'restored_api_replay':True,
                'wrong_key_rejected':True,'down_rejected':[70,71,72],'physical_restore':False,'provider_called':False}
        target=ROOT/'tests/contrato/relatorios/provider-pipeline-migration.json'
        target.parent.mkdir(exist_ok=True);target.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
    finally:
        subprocess.run(['docker','rm','-f','-v',DB_CONTAINER],check=True,capture_output=True)
