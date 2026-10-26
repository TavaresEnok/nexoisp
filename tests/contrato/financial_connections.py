"""B03: synthetic loopback API + disposable owner SQL fixtures only.
Run from native harness, never with application env/production data.
"""
import concurrent.futures,hashlib,hmac,json,os,time,uuid,subprocess,tempfile
from urllib.parse import urlsplit,urlunsplit
from urllib.parse import urlparse
from lib import request,sql,quote,ROOT,DB_CONTAINER,DB_PORT,wait
BASE=os.environ['NEXO_PAYMENT_LAB_URL'];SECOND=os.environ.get('NEXO_PAYMENT_LAB_URL_2',BASE)
assert os.environ.get('NEXO_PAYMENT_LAB')=='1' and all(urlparse(x).hostname=='127.0.0.1' for x in [BASE,SECOND])
checks=[]
def check(name):checks.append(name);print('PASS B03 '+name,flush=True)
def call(path,body=None,token=None,method=None,headers=None,base=BASE):
 for _ in range(25):
  r=request(base,'/api'+path,token=token,method=method or ('POST' if body is not None else 'GET'),headers=dict({'Content-Type':'application/json'},**(headers or {})),body=json.dumps(body).encode() if body is not None else None)
  if r['status']!=429:return r
  time.sleep(.3)
 raise AssertionError('rate limit')
def login(email):
 r=call('/auth/login',{'email':email,'password':'demo1234','bearer':True});assert r['status']==200,r
 t=r['json']['token'];assert call('/me',token=t)['json']['demo'] is True;return t
alfa=login('admin@alfa.demo');beta=login('admin@beta.demo');attendant=login('atendimento@alfa.demo')
def api(path,body=None,token=alfa,method=None):
 r=call(path,body,token,method);assert r['status']==200,(path,r);return r['json']
serial=uuid.uuid4().hex[:10]
secretA='synthetic-account-A-'+serial+'-'*40;secretB='synthetic-account-B-'+serial+'-'*40
company=api('/companies',{'name':'B03 company '+serial,'is_default':False})
def conn(account,token=alfa,provider='demo',environment='sandbox',company_id=None,secret=secretA):
 return api('/financial-connections',{'name':'B03 '+account+' '+serial,'account_ref':account+serial,'provider':provider,'environment':environment,'company_id':company_id,'webhook_secret':secret},token)
a=conn('accountA');b=conn('accountB',secret=secretB);c=conn('accountA',token=beta);d=conn('accountA',environment='production');e=conn('accountA',company_id=company['id'])
for item,token in [(a,alfa),(b,alfa),(c,beta),(e,alfa)]:api('/financial-connections/'+item['id'],{'status':'active'},token,method='PATCH')
assert call('/financial-connections/'+d['id'],{'status':'active'},alfa,'PATCH')['status']==409
canonical=conn('efi-alias',provider='sejaefi');assert canonical['provider']=='efi'
assert call('/financial-connections/'+canonical['id'],{'status':'active'},alfa,'PATCH')['status']==409
check('connections distinguish tenant/company/account/environment; real adapters and production demo cannot activate; Efi alias canonical')
assert all('webhook_secret_enc' not in x and 'webhook_secret' not in x for x in api('/financial-connections'))
assert a['id'] not in [x['id'] for x in api('/financial-connections',token=beta)]
assert call('/financial-connections',token=attendant)['status']==403
assert call('/financial-connections/'+a['id'],{'status':'disabled'},beta,'PATCH')['status']==404
assert call('/financial-connections',{'name':'Cross tenant','account_ref':'x','company_id':company['id'],'provider':'demo','environment':'sandbox'},beta)['status']==400
check('API denies cross-tenant management and unauthorized role; no plaintext/ciphertext secrets returned')
# Keep issue generation disabled; these rows simulate provider IDs at the B03
# adapter boundary without performing any external issuance.
def fixture(connection,token=alfa,charge='same-charge-'+serial):
 tenant=api('/me',token=token)['tenant']['id']
 plan=api('/plans',token=token)[0];sub=api('/subscribers',{'name':'B03 '+uuid.uuid4().hex[:8]},token)
 contract=api('/contracts',{'subscriber_id':sub['id'],'plan_id':plan['id'],'due_day':15},token)
 inv=api('/invoices',{'contract_id':contract['id'],'description':'B03 synthetic','amount_cents':10000,'due_date':'2026-01-15'},token)
 # All values are generated UUIDs; SQL helper quotes every value.
 sql('update invoices set company_id='+ (quote(connection['company_id']) if connection['company_id'] else 'null')+',gateway=\'demo\',gateway_charge_id='+quote(charge)+',financial_connection_id='+quote(connection['id'])+' where id='+quote(inv['id']),'nexo_test')
 return inv,tenant
ia,ta=fixture(a);ib,_=fixture(b);ic,tb=fixture(c,beta);id_,_=fixture(d);ie,_=fixture(e)
check('identical charge IDs coexist across two accounts, tenants, environments and companies')
event={'id':'same-event-'+serial,'type':'payment.confirmed','charge_id':'same-charge-'+serial,'payment':{'id':'same-payment-'+serial,'amount_cents':10000,'paid_at':'2026-10-26T12:00:00Z','method':'pix'}}
def callback(connection,secret,event=event,header_connection=None,base=BASE):
 ts=str(int(time.time()));raw=json.dumps(event);signed=ts+'.'+connection['id']+'.'+raw
 signature='sha256='+hmac.new(secret.encode(),signed.encode(),hashlib.sha256).hexdigest()
 return call('/webhooks/gateway/demo',event,headers={'X-Nexo-Connection':header_connection or connection['id'],'x-nexo-timestamp':ts,'x-nexo-signature':signature},base=base)
assert callback(a,secretA,header_connection=b['id'])['status']==401
assert callback(b,secretA)['status']==401
assert callback(d,secretA)['status']==404
assert api('/invoices/'+ib['id'])['paid_cents']==0
check('wrong account signature/header and inactive environment cannot pay another invoice')
with concurrent.futures.ThreadPoolExecutor(8) as pool:results=list(pool.map(lambda n:callback(a,secretA,base=BASE if n%2 else SECOND),range(32)))
assert all(r['status']==200 for r in results),results
assert sum(r['json']['status']=='processed' for r in results)==1
assert len(api('/invoices/'+ia['id'])['payments'])==1
for co,key,iv,token in [(b,secretB,ib,alfa),(c,secretA,ic,beta),(e,secretA,ie,alfa)]:
 assert callback(co,key)['json']['status']=='processed'
 assert len(api('/invoices/'+iv['id'],token=token)['payments'])==1
assert api('/invoices/'+id_['id'])['paid_cents']==0
for iv,co,token in [(ia,a,alfa),(ib,b,alfa),(ic,c,beta),(ie,e,alfa)]:
 detail=api('/invoices/'+iv['id'],token=token)
 assert len(detail['events'])==1,detail['events']
 assert detail['financial_connection_id']==co['id']
check('32 concurrent duplicate callbacks create one payment; scoped invoice history contains only its own event')
conflict=dict(event,payment=dict(event['payment'],amount_cents=9000));assert callback(a,secretA,conflict)['status']==409
new_event=dict(event,id='event-other-'+serial,payment=dict(event['payment'],amount_cents=9000));assert callback(a,secretA,new_event)['status']==409
check('changed event payload and reused payment ID with divergent amount are rejected')
# Matching only in another account must stay unmatched. Retry can recover later,
# but only when the charge appears in the authenticated connection.
unique='only-A-'+serial;extra,_=fixture(a,charge=unique)
late=dict(event,id='late-'+serial,charge_id=unique,payment=dict(event['payment'],id='late-pay-'+serial))
assert callback(b,secretB,late)['json']['status']=='unmatched';assert api('/invoices/'+extra['id'])['paid_cents']==0
late_invoice,_=fixture(b,charge=unique)
assert callback(b,secretB,late)['json']['status']=='processed';assert len(api('/invoices/'+late_invoice['id'])['payments'])==1
assert api('/invoices/'+extra['id'])['paid_cents']==0
check('unmatched inbox never searches another account; identical event can recover after its own charge is registered')
api('/financial-connections/'+b['id'],{'status':'disabled'},method='PATCH');assert callback(b,secretB)['status']==404
assert call('/demo-gateway/pay',{'invoice_id':ib['id'],'mode':'lost'},alfa)['status']==409
check('disabled connection rejects callback and payment simulation while preserving payments and references')
# Non-vacuous SQL checks as nexo_app, not owner. Roll back all scope changes.
for extra_scope in ["select set_config('app.subscriber_id',"+quote(api('/invoices/'+ia['id'])['subscriber_id'])+",true);", "select set_config('app.pop_ids',"+quote(str(uuid.uuid4()))+",true);"]:
 n=sql('begin;set local role nexo_app;select set_config(\'app.tenant_id\','+quote(ta)+',true);'+extra_scope+'select count(*) from financial_connections;rollback;','nexo_test').splitlines()[-1];assert n=='0',n
check('connection RLS blocks subscriber portal and restricted POP scopes')
# Reconciliation must use both charge ID and connection, including demo storage.
api('/financial-connections/'+b['id'],{'status':'active'},method='PATCH')
reconcile_charge='reconcile-'+serial
ra,_=fixture(a,charge=reconcile_charge);rb,_=fixture(b,charge=reconcile_charge)
for co,tenant,amount in [(a,ta,10000),(b,ta,9000)]:
 payments=json.dumps([{'id':'reconcile-pay-'+serial,'amount_cents':amount,'paid_at':'2026-10-26T12:00:00Z','method':'pix'}])
 sql('insert into demo_gateway_charges(tenant_id,financial_connection_id,charge_id,amount_cents,payments) values('+','.join([quote(tenant),quote(co['id']),quote(reconcile_charge),'10000',quote(payments)+'::jsonb'])+')','nexo_test')
api('/finance/reconcile',{})
assert api('/invoices/'+ra['id'])['paid_cents']==10000
assert api('/invoices/'+rb['id'])['paid_cents']==9000
check('reconciliation of identical charge/payment IDs reads the correct account and amount')
# Default selection affects future charges only; historical bindings cannot move.
api('/financial-connections/'+e['id'],{'status':'active','is_default':True},method='PATCH')
settings=api('/finance/settings');api('/finance/settings',dict(settings,gateway='demo'),method='PUT')
def issued():
 plan=api('/plans')[0];sub=api('/subscribers',{'name':'Issued B03 '+uuid.uuid4().hex[:8]})
 contract=api('/contracts',{'subscriber_id':sub['id'],'plan_id':plan['id'],'due_day':15})
 return api('/invoices',{'contract_id':contract['id'],'description':'Synthetic issued charge','amount_cents':10000,'due_date':'2026-01-15'})
first=issued();assert api('/invoices/'+first['id'])['financial_connection_id']==e['id']
f=conn('company-account-B',company_id=company['id'],secret=secretB)
api('/financial-connections/'+f['id'],{'status':'active','is_default':True},method='PATCH')
# A POP-limited financial operator can register its visible invoice, while
# account access/issuance waits for the full-scope billing context.
sql("insert into pops(tenant_id,name) values("+quote(ta)+",'B03 restricted POP')",'nexo_test')
sql("insert into user_pops(tenant_id,user_id,pop_id) select u.tenant_id,u.id,p.id from users u join pops p on p.tenant_id=u.tenant_id where u.email='financeiro@alfa.demo' and p.name='B03 restricted POP'",'nexo_test')
limited=login('financeiro@alfa.demo')
waiting=api('/invoices',{'contract_id':first['contract_id'],'description':'POP scoped invoice','amount_cents':5000,'due_date':'2026-01-15'},limited)
assert api('/invoices/'+waiting['id'],token=limited)['financial_connection_id'] is None
second=issued();assert api('/invoices/'+second['id'])['financial_connection_id']==f['id']
assert api('/invoices/'+first['id'])['financial_connection_id']==e['id']
assert api('/invoices/'+waiting['id'])['financial_connection_id']==f['id']
check('POP-limited invoice registration succeeds without account access; full-scope billing issues it later')
api('/finance/settings',settings,method='PUT')
check('changing default issues only future demo charges through the new account, preserving prior bindings')
# Recover the new encrypted credentials and financial identity in a fresh DB.
# No productive configuration or persistent dumps; all tools target the owned container.
restore='nexo_restore_check_'+str(os.getpid())+'_'+str(int(time.time()))
cli=['docker','exec','-i',DB_CONTAINER]
psql=cli+['psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','nexo_owner','-p',str(DB_PORT)]
subprocess.run(psql+['-d','postgres','-c','create database '+restore],check=True,capture_output=True)
try:
 with tempfile.TemporaryFile() as dump:
  subprocess.run(cli+['pg_dump','-U','nexo_owner','-p',str(DB_PORT),'-Fc','nexo_test'],stdout=dump,check=True)
  dump.seek(0)
  subprocess.run(cli+['pg_restore','-U','nexo_owner','-p',str(DB_PORT),'-d',restore,'--exit-on-error'],stdin=dump,check=True,capture_output=True)
 verify_env=dict(os.environ,NEXO_RESTORE_DATABASE=restore)
 subprocess.run([str(ROOT/'apps/api-go/bin/nexo-db'),'verify-restore'],cwd=ROOT,env=verify_env,check=True)
 url=urlsplit(verify_env['DATABASE_URL_GO'])
 verify_env.update(DATABASE_URL_GO=urlunsplit(url._replace(path='/'+restore)),NEXO_GO_ADDR='127.0.0.1:18954',NEXO_GO_INTERNAL_ADDR='127.0.0.1:19954',NEXO_GO_AGENT_ADDR='127.0.0.1:18955',NEXO_GO_JOBS='0')
 with tempfile.TemporaryFile() as log:
  process=subprocess.Popen([str(ROOT/'apps/api-go/bin/api')],cwd=ROOT,env=verify_env,stdout=log,stderr=subprocess.STDOUT)
  try:
   wait('http://127.0.0.1:19954','/healthz',process)
   replay=callback(a,secretA,base='http://127.0.0.1:18954');assert replay['status']==200 and replay['json']['status']=='duplicate',replay
   count=subprocess.check_output(psql+['-d',restore,'-c','select count(*) from payments where invoice_id='+quote(ia['id'])],text=True).strip();assert count=='1'
  finally:
   process.terminate()
   try:process.wait(timeout=10)
   except subprocess.TimeoutExpired:process.kill();process.wait()
 check('dump/restore preserves encrypted connection authentication and dedupe; replay after API restart remains one payment')
finally:subprocess.run(psql+['-d','postgres','-c','drop database '+restore+' with (force)'],check=True,capture_output=True)
print(json.dumps({'ok':True,'checks':checks,'connections':[x['id'] for x in [a,b,c,d,e]],'invoice':ia['id']},ensure_ascii=False))
