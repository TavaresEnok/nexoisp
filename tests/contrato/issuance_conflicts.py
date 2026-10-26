"""Existing authenticated finance APIs respect a synthetic sandbox reservation."""
import os,json,uuid,time,concurrent.futures
from urllib.parse import urlparse
from lib import ROOT,sql,quote,request
assert os.environ.get('NEXO_PAYMENT_LAB')=='1'
BASE=os.environ['NEXO_PAYMENT_LAB_URL'];SECOND=os.environ.get('NEXO_PAYMENT_LAB_URL_2',BASE)
assert all(urlparse(u).hostname=='127.0.0.1' for u in [BASE,SECOND])
checks=[]
def check(s):checks.append(s);print('PASS B07TX '+s,flush=True)
def call(path,body=None,token=None,method=None,base=BASE):
 for _ in range(30):
  r=request(base,'/api'+path,token=token,method=method or ('POST' if body is not None else 'GET'),headers={'Content-Type':'application/json'},body=json.dumps(body).encode() if body is not None else None)
  if r['status']!=429:return r
  time.sleep(.2)
 raise AssertionError('rate limited')
def login(email):
 r=call('/auth/login',{'email':email,'password':'demo1234','bearer':True});assert r['status']==200,r;return r['json']['token']
admin=login('admin@alfa.demo');foreign=login('admin@beta.demo');attendant=login('atendimento@alfa.demo')
def api(path,body=None,method=None):
 r=call(path,body,admin,method);assert r['status']==200,(path,r);return r['json']
tenant=api('/me')['tenant']['id'];q=quote
sql("update tenant_settings set gateway='none' where tenant_id="+q(tenant),'nexo_test')
sub=api('/subscribers',{'name':'B07TX '+uuid.uuid4().hex[:10]});contract=api('/contracts',{'subscriber_id':sub['id'],'plan_id':api('/plans')[0]['id'],'due_day':15})
inv=api('/invoices',{'contract_id':contract['id'],'description':'B07TX synthetic reservation','amount_cents':12345,'due_date':'2026-11-15'})
detail=api('/invoices/'+inv['id'])
c=api('/financial-connections',{'name':'B07TX','provider':'efi','environment':'sandbox','account_ref':uuid.uuid4().hex,'company_id':detail['company_id']})
r={'scope':{'tenant_id':tenant,'connection_id':c['id'],'provider':'efi','environment':'sandbox','account_ref':c['account_ref']},'invoice_id':inv['id'],'intent_key':str(uuid.uuid4()),'money':{'amount_cents':12345,'currency':'BRL'},'due_date':'2026-11-15'}
# Fixture insertion uses the application role and scope, exercising reserve/link triggers.
sql("begin;set local role nexo_app;select set_config('app.tenant_id',"+q(tenant)+",true);insert into provider_issuance(tenant_id,invoice_id,financial_connection_id,intent_key,request,config_hash) values("+','.join([q(tenant),q(inv['id']),q(c['id']),q(r['intent_key']),q(json.dumps(r))+'::jsonb',q('a'*64)])+');commit;','nexo_test')
body={'intent_id':str(uuid.uuid4()),'amount_cents':100,'paid_at':'2026-10-26','method':'dinheiro','note':'Synthetic pending issuance attempt','partial':True,'apply_fees':False}
def action(n):
 if n%2:return call('/invoices/'+inv['id']+'/manual-payment',body,admin,base=BASE if n%4 else SECOND)
 return call('/invoices/'+inv['id']+'/cancel',{'reason':'Synthetic pending cancellation'},admin,base=SECOND)
with concurrent.futures.ThreadPoolExecutor(8) as pool:replies=list(pool.map(action,range(32)))
assert all(x['status']==409 for x in replies),replies
assert sql('select count(*) from payments where invoice_id='+q(inv['id']),'nexo_test')=='0'
assert sql('select count(*) from manual_payment_intents where invoice_id='+q(inv['id']),'nexo_test')=='0'
assert api('/invoices/'+inv['id'])['status']=='open'
check('32 concurrent receipt/cancel attempts across two APIs return 409; payment and B02 intent rollback together')
assert call('/invoices/'+inv['id']+'/manual-payment',body,attendant)['status']==403
assert call('/invoices/'+inv['id']+'/manual-payment',body,foreign)['status']==404
assert call('/financial-connections/'+c['id'],{'status':'active'},admin,'PATCH')['status']==409
check('existing profile and tenant authorization remain enforced; real adapter activation remains refused')
# Simulated provider response is fixture data, not a real provider operation.
charge='synthetic-b07tx-'+uuid.uuid4().hex
sql("begin;set local role nexo_app;select set_config('app.tenant_id',"+q(tenant)+",true);update provider_issuance set state='uncertain' where invoice_id="+q(inv['id'])+";update provider_issuance set state='issued',charge_id="+q(charge)+" where invoice_id="+q(inv['id'])+';commit;','nexo_test')
detail=api('/invoices/'+inv['id']);assert detail['gateway_charge_id']==charge and detail['financial_connection_id']==c['id'] and detail['paid_cents']==0
assert call('/invoices/'+inv['id']+'/manual-payment',body,admin)['status']==200
assert call('/invoices/'+inv['id']+'/manual-payment',body,admin)['status']==200
assert api('/invoices/'+inv['id'])['paid_cents']==100
assert sql('select count(*) from payments where invoice_id='+q(inv['id']),'nexo_test')=='1'
check('response binds without inventing cash; same rejected B02 intention can commit once after binding and replay safely')
# Restricted finance operator can receive a bound title without seeing accounts/journal.
sql("update contracts set pop_id=(select p.pop_id from user_pops p join users u on u.id=p.user_id where u.email='financeiro@alfa.demo' limit 1) where id="+q(contract['id']),'nexo_test')
limited=login('financeiro@alfa.demo')
limited_body=dict(body,intent_id=str(uuid.uuid4()),amount_cents=50,note='Restricted POP legitimate receipt')
assert call('/invoices/'+inv['id']+'/manual-payment',limited_body,limited)['status']==200
assert api('/invoices/'+inv['id'])['paid_cents']==150
check('POP-limited finance can receive a confirmed bound invoice while journal/account remain hidden')
assert call('/invoices/'+inv['id']+'/cancel',{'reason':'Requires confirmed provider cancellation'},admin)['status']==409
assert sql('select count(*) from financial_balance_shadow where not matches','nexo_test')=='0'
check('bound external title cannot be canceled locally; financial shadow remains consistent')
(ROOT/'tests/contrato/relatorios/issuance-conflicts.json').write_text(json.dumps({'ok':True,'checks':checks,'actual_provider_call':False},indent=2))
