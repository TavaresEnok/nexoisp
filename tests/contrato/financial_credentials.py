"""Credential vault API: owned loopback lab, synthetic certificate, no PSP call."""
import os,json,uuid,time,tempfile,subprocess,concurrent.futures
from pathlib import Path
from urllib.parse import urlparse
from lib import ROOT,sql,quote,request,wait
assert os.environ.get('NEXO_PAYMENT_LAB')=='1'
BASE=os.environ['NEXO_PAYMENT_LAB_URL'];assert urlparse(BASE).hostname=='127.0.0.1'
checks=[]
def check(s):checks.append(s);print('PASS VAULT '+s,flush=True)
def call(path,body=None,token=None,method=None):
 for _ in range(30):
  r=request(BASE,'/api'+path,token=token,method=method or ('POST' if body is not None else 'GET'),headers={'Content-Type':'application/json'},body=json.dumps(body).encode() if body is not None else None)
  if r['status']!=429:return r
  time.sleep(.2)
 raise AssertionError('rate limited')
def login(email):
 r=call('/auth/login',{'email':email,'password':'demo1234','bearer':True});assert r['status']==200,r;return r['json']['token']
admin=login('admin@alfa.demo');beta=login('admin@beta.demo');attendant=login('atendimento@alfa.demo');limited=login('financeiro@alfa.demo')
def api(path,body=None,method=None):
 r=call(path,body,admin,method);assert r['status']==200,(path,r);return r['json']
connection=api('/financial-connections',{'name':'Vault synthetic','provider':'efi','environment':'sandbox','account_ref':uuid.uuid4().hex})
path='/financial-connections/'+connection['id']+'/credentials';tenant=api('/me')['tenant']['id']
with tempfile.TemporaryDirectory(prefix='nexo-vault-certificate-') as tmp:
 key=Path(tmp)/'key.pem';cert=Path(tmp)/'cert.pem'
 subprocess.run(['openssl','req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','1','-subj','/CN=synthetic-vault','-keyout',str(key),'-out',str(cert)],check=True,capture_output=True)
 body={'client_id':'SYNTHETIC-CLIENT-'+uuid.uuid4().hex,'client_secret':'SYNTHETIC-SECRET-'+uuid.uuid4().hex,'certificate_pem':cert.read_text(),'private_key_pem':key.read_text(),'pix_key':'synthetic-'+uuid.uuid4().hex}
 first=api(path,body)
 assert first['version']==1 and first['current'] is True
 assert 'PRIVATE KEY' not in json.dumps(first) and body['client_secret'] not in json.dumps(first)
 bad=dict(body,private_key_pem='SYNTHETIC-INVALID-PRIVATE-KEY')
 r=call(path,bad,admin);assert r['status']==400 and 'SYNTHETIC-INVALID' not in r['body'].decode()
 assert len(api(path))==1
 check('valid synthetic certificate version stored; invalid key rejected without persisting or echoing secrets')
 for token,status in [(beta,404),(attendant,403),(limited,403)]:
  assert call(path,token=token)['status']==status
  assert call(path,body,token)['status']==status
 check('cross-tenant and unauthorized/restricted financial role cannot read or rotate credentials')
 # Concurrent versions serialize on connection identity, keeping all history.
 with concurrent.futures.ThreadPoolExecutor(4) as pool:
  replies=list(pool.map(lambda n:call(path,dict(body,client_secret=body['client_secret']+'-'+str(n)),admin),range(8)))
 assert all(r['status']==200 for r in replies),replies
 versions=api(path);assert sorted(v['version'] for v in versions)==list(range(1,10)) and sum(v['current'] for v in versions)==1
 raw=json.dumps(versions)
 for secret in [body['client_id'],body['client_secret'],'PRIVATE KEY','secret_enc','v1.']:
  assert secret not in raw
 for con in api('/financial-connections'):
  assert 'secret_enc' not in json.dumps(con) and 'PRIVATE KEY' not in json.dumps(con)
 check('eight concurrent rotations preserve nine monotonic versions and exactly one current pointer; responses contain metadata only')
 audit=sql("select coalesce(json_agg(detail),'[]') from audit_events where action='finance.credential.create' and entity_id="+quote(connection['id']),'nexo_test')
 assert body['client_secret'] not in audit and 'PRIVATE KEY' not in audit and 'secret_enc' not in audit
 assert sql('select count(*) from financial_credential_versions where financial_connection_id='+quote(connection['id'])+" and secret_enc like 'v1.%'",'nexo_test')=='9'
 # A fresh bearer cannot turn staging credentials into an active account.
 assert call('/financial-connections/'+connection['id'],{'status':'active'},admin,'PATCH')['status']==409
 check('ciphertexts persisted, audit has identifiers only, and credential registration does not activate real dispatch')
# A separate owned API enables staging only. Jobs and dispatch are explicitly
# disabled: validation/queue preparation must never call a provider.
original=BASE
stage_env=dict(os.environ,NEXO_GO_ADDR='127.0.0.1:19166',NEXO_GO_INTERNAL_ADDR='127.0.0.1:19266',NEXO_GO_AGENT_ADDR='127.0.0.1:19366',NEXO_GO_JOBS='0',NEXO_GO_EFI_SANDBOX_ENABLED='1',NEXO_GO_EFI_DISPATCH='0')
with tempfile.TemporaryFile() as log:
 process=subprocess.Popen([str(ROOT/'apps/api-go/bin/api')],cwd=ROOT,env=stage_env,stdout=log,stderr=subprocess.STDOUT)
 try:
  BASE='http://127.0.0.1:19166';wait(BASE,'/api/health',process)
  sub=api('/subscribers',{'name':'Staged financial synthetic'});contract=api('/contracts',{'subscriber_id':sub['id'],'plan_id':api('/plans')[0]['id'],'due_day':15})
  def invoice():return api('/invoices',{'contract_id':contract['id'],'description':'Staged financial product','amount_cents':12345,'due_date':'2026-11-15'})
  first_invoice=invoice();company=api('/invoices/'+first_invoice['id'])['company_id']
  pix=api('/financial-connections',{'name':'Pix staging','provider':'efi','environment':'sandbox','account_ref':uuid.uuid4().hex,'company_id':company})
  first_version=api('/financial-connections/'+pix['id']+'/credentials',body)
  api('/financial-connections/'+pix['id'],{'status':'active'},'PATCH')
  payload={'invoice_id':first_invoice['id'],'intent_id':str(uuid.uuid4()),'options':{'product':'pix_cob','expiration_seconds':3600}}
  path='/financial-connections/'+pix['id']+'/issuance'
  one=api(path,payload);assert one['state']=='prepared' and one['dispatch_enabled'] is False
  assert api(path,payload)['id']==one['id']
  rotated=dict(body,client_secret='SYNTHETIC-TRANSPORT-ROTATED',pix_key='synthetic-new-pix-key')
  api('/financial-connections/'+pix['id']+'/credentials',rotated)
  again=api(path,payload);assert again['id']==one['id'] and again['credential_version_id']==first_version['id']
  assert call(path,payload,attendant)['status']==403
  assert call(path,payload,limited)['status']==403
  assert call(path+'/'+one['id'],token=beta)['status']==404
  assert api(path+'/'+one['id'])['attempts']==0
  assert call(path,dict(payload,intent_id=str(uuid.uuid4())),admin)['status']==409
  assert sql("select count(*) from audit_events where action='finance.issuance.prepare' and entity_id="+quote(one['id']),'nexo_test')=='1'
  check('authorized staging API is replay-safe; credential rotation retains frozen semantics/version; one preparation audit; dispatch remains off')
  failed_invoice=invoice()
  failed_body=dict(payload,invoice_id=failed_invoice['id'],intent_id=str(uuid.uuid4()))
  sql("create function pipeline_fail_audit() returns trigger language plpgsql as $$begin if new.action='finance.issuance.prepare' then raise exception 'synthetic audit failure';end if;return new;end$$; create trigger pipeline_fail_audit before insert on audit_events for each row execute function pipeline_fail_audit()",'nexo_test')
  try:
   assert call(path,failed_body,admin)['status']==500
   assert sql('select count(*) from provider_issuance where invoice_id='+quote(failed_invoice['id']),'nexo_test')=='0'
   assert sql('select provider_issuance_id is null from invoices where id='+quote(failed_invoice['id']),'nexo_test')=='t'
  finally:sql('drop trigger pipeline_fail_audit on audit_events;drop function pipeline_fail_audit()','nexo_test')
  recovered=api(path,failed_body);assert recovered['state']=='prepared'
  check('failed preparation audit rolls back both journal and invoice reservation; same intention succeeds after recovery')
  review_path=path+'/'+recovered['id']+'/retry-lookup'
  reason={'reason':'Synthetic operator retries lookup after credential repair'}
  assert call(review_path,reason,admin)['status']==409
  sql('update provider_issuance set state=\'uncertain\' where id='+quote(recovered['id'])+';update provider_issuance set state=\'review\' where id='+quote(recovered['id']),'nexo_test')
  for token,status in [(beta,404),(attendant,403),(limited,403)]:assert call(review_path,reason,token)['status']==status
  assert api(review_path,reason)=={'queued':True,'lookup_only':True}
  queued=api(path+'/'+recovered['id']);assert queued['state']=='uncertain' and queued['attempts']==0
  assert sql('select count(*) from payments where invoice_id='+quote(failed_invoice['id']),'nexo_test')=='0'
  check('review retry requires full-scope financial permission and reason; resumes only lookup without cash or new-send state')
  debtor={'nome':'Synthetic payer','cpf':'12345678909','logradouro':'Synthetic street','cidade':'Fortaleza','uf':'CE','cep':'60000000'}
  due=api(path,{'invoice_id':invoice()['id'],'intent_id':str(uuid.uuid4()),'options':{'product':'pix_cobv','debtor':debtor,'valid_days':30}});assert due['state']=='prepared'
  customer={'name':'Synthetic payer','cpf':'12345678909','email':'synthetic@example.invalid','address':{'street':'Synthetic','number':'1','neighborhood':'Synthetic','city':'Fortaleza','state':'CE','zipcode':'60000000'}}
  charges=api('/financial-connections',{'name':'Bolix staging','provider':'efi','environment':'sandbox','account_ref':uuid.uuid4().hex,'company_id':company})
  charges_path='/financial-connections/'+charges['id']
  cm=api(charges_path+'/credentials',{'kind':'efi_charges','client_id':'synthetic-charges','client_secret':'synthetic-charges-secret'});assert cm['kind']=='efi_charges'
  api(charges_path,{'status':'active'},'PATCH')
  bp={'invoice_id':invoice()['id'],'intent_id':str(uuid.uuid4()),'options':{'product':'bolix','customer':customer}}
  assert call(charges_path+'/issuance',dict(bp,options=dict(bp['options'],issued_on='2000-01-01')),admin)['status']==400
  bolix=api(charges_path+'/issuance',bp);assert bolix['state']=='prepared'
  assert api(charges_path+'/issuance',bp)['id']==bolix['id']
  assert call('/financial-connections/'+pix['id']+'/credentials',{'kind':'efi_charges','client_id':'other','client_secret':'other'},admin)['status']==409
  assert sql("select count(*) from provider_issuance where id in("+','.join(quote(x['id']) for x in [one,due,bolix])+") and state='prepared' and attempts=0",'nexo_test')=='3'
  check('Pix Cob, CobV and Bolix prepare with distinct validated contracts; mixed API credentials refused; no provider request executed')
  # Owner changes only synthetic journal fixtures to represent issued responses;
  # no provider request is executed by this staging API.
  sql("update provider_issuance set state='uncertain' where id="+quote(one['id'])+";update provider_issuance set state='issued',charge_id='synthetic-operations-charge' where id="+quote(one['id']),'nexo_test')
  operations=path+'/'+one['id']+'/operations'
  cancel_body={'intent_id':str(uuid.uuid4()),'kind':'cancel','reason':'Synthetic unpaid provider cancellation'}
  with concurrent.futures.ThreadPoolExecutor(4) as pool:
   replies=list(pool.map(lambda _:call(operations,cancel_body,admin),range(12)))
  assert all(r['status']==200 for r in replies),replies
  operation_id=replies[0]['json']['id'];assert all(r['json']['id']==operation_id for r in replies)
  assert call(operations,dict(cancel_body,reason='Changed intention reason for replay'),admin)['status']==409
  for token,read_status,write_status in [(beta,404,404),(attendant,200,403),(limited,403,403)]:
   result=call(operations,token=token);assert result['status']==read_status,(result['status'],read_status)
   result=call(operations,cancel_body,token);assert result['status']==write_status,(result['status'],write_status)
  assert len(api(operations))==1 and api(operations)[0]['state']=='prepared'
  assert sql("select count(*) from audit_events where action='finance.provider.operation_prepare' and entity_id="+quote(operation_id),'nexo_test')=='1'
  retry=operations+'/'+operation_id+'/retry-lookup';reason={'reason':'Synthetic operator requests lookup after credential repair'}
  assert call(retry,reason,admin)['status']==409
  sql("update provider_operations set state='uncertain' where id="+quote(operation_id)+";update provider_operations set state='review' where id="+quote(operation_id),'nexo_test')
  assert api(retry,reason)=={'queued':True,'lookup_only':True}
  assert api(operations)[0]['state']=='uncertain'
  assert sql('select count(*) from payments where invoice_id='+quote(first_invoice['id']),'nexo_test')=='0'
  assert sql('select provider_canceled_at is null from invoices where id='+quote(first_invoice['id']),'nexo_test')=='t'
  check('operation preparation is concurrent/replay-safe and authorized; lookup retry cannot cancel locally or post cash; audit once')
  sql("update provider_issuance set state='uncertain' where id="+quote(due['id'])+";update provider_issuance set state='issued',charge_id='synthetic-refund-operations-charge' where id="+quote(due['id']),'nexo_test')
  due_invoice=api(path+'/'+due['id'])['invoice_id'];payment_id=str(uuid.uuid4())
  sql("insert into payments(id,tenant_id,invoice_id,amount_cents,paid_at,method,source,gateway,gateway_payment_id,financial_connection_id) select "+quote(payment_id)+",tenant_id,id,12345,'2026-10-26T12:00:00Z','pix','reconciliation','efi','synthetic-refund-original',financial_connection_id from invoices where id="+quote(due_invoice),'nexo_test')
  refund_path=path+'/'+due['id']+'/operations'
  refund={'intent_id':str(uuid.uuid4()),'kind':'refund','payment_id':payment_id,'amount_cents':4000,'reason':'Synthetic partial refund reservation'}
  first_refund=api(refund_path,refund);assert api(refund_path,refund)['id']==first_refund['id']
  assert call(refund_path,dict(refund,amount_cents=4001),admin)['status']==409
  second_refund=api(refund_path,dict(refund,intent_id=str(uuid.uuid4())));assert second_refund['id']!=first_refund['id']
  assert call(refund_path,dict(refund,intent_id=str(uuid.uuid4()),amount_cents=5000),admin)['status']==409
  audit_body=dict(refund,intent_id=str(uuid.uuid4()),amount_cents=1000)
  sql("create function provider_operation_fail_audit() returns trigger language plpgsql as $$begin if new.action='finance.provider.operation_prepare' then raise exception 'synthetic operation audit failure';end if;return new;end$$; create trigger provider_operation_fail_audit before insert on audit_events for each row execute function provider_operation_fail_audit()",'nexo_test')
  try:
   assert call(refund_path,audit_body,admin)['status']==500
   assert len(api(refund_path))==2
  finally:sql('drop trigger provider_operation_fail_audit on audit_events;drop function provider_operation_fail_audit()','nexo_test')
  assert api(refund_path,audit_body)['state']=='prepared'
  assert sql("select count(*) from payments where invoice_id="+quote(due_invoice)+" and kind='reversal'",'nexo_test')=='0'
  check('partial refund intentions reserve cumulative cents without posting cash; changed replay refused; audit failure rolls back reservation')


 finally:
  BASE=original;process.terminate()
  try:process.wait(timeout=10)
  except subprocess.TimeoutExpired:process.kill();process.wait()
(ROOT/'tests/contrato/relatorios/financial-credentials.json').write_text(json.dumps({'ok':True,'checks':checks,'provider_called':False},indent=2))
