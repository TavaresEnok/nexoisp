"""B06 authenticated demo adapter/inbox contract, only native loopback lab."""
import os,json,uuid,time,hmac,hashlib,concurrent.futures
from urllib.parse import urlparse
from lib import ROOT,sql,quote,request
assert os.environ.get('NEXO_PAYMENT_LAB')=='1'
BASE=os.environ['NEXO_PAYMENT_LAB_URL'];SECOND=os.environ.get('NEXO_PAYMENT_LAB_URL_2',BASE)
assert all(urlparse(u).hostname=='127.0.0.1' for u in [BASE,SECOND])
checks=[];q=quote

def check(s):checks.append(s);print('PASS B06 '+s,flush=True)
def rows(query):return json.loads(sql("select coalesce(json_agg(x),'[]') from ("+query+") x",'nexo_test'))
def call(path,body=None,token=None,method=None,headers=None,base=BASE):
 for _ in range(30):
  r=request(base,'/api'+path,token=token,method=method or ('POST' if body is not None else 'GET'),headers=dict({'Content-Type':'application/json'},**(headers or {})),body=json.dumps(body).encode() if body is not None else None)
  if r['status']!=429:return r
  time.sleep(.2)
 raise AssertionError('rate limit')
r=call('/auth/login',{'email':'admin@alfa.demo','password':'demo1234','bearer':True});assert r['status']==200,r;token=r['json']['token']
def api(path,body=None,method=None):
 r=call(path,body,token,method);assert r['status']==200,(path,r);return r['json']
tenant=api('/me')['tenant']['id'];serial=uuid.uuid4().hex[:10];secret='B06-synthetic-secret-'+serial+'-'*40
sql("update tenant_settings set gateway='none' where tenant_id="+q(tenant),'nexo_test')
connection=api('/financial-connections',{'name':'B06 '+serial,'provider':'demo','environment':'sandbox','account_ref':'B06-'+serial,'webhook_secret':secret})
api('/financial-connections/'+connection['id'],{'status':'active'},'PATCH')
def invoice(charge=None):
 sub=api('/subscribers',{'name':'B06 '+uuid.uuid4().hex[:8]});contract=api('/contracts',{'subscriber_id':sub['id'],'plan_id':api('/plans')[0]['id'],'due_day':15})
 inv=api('/invoices',{'contract_id':contract['id'],'description':'B06 synthetic','amount_cents':10000,'due_date':'2026-11-15'})
 charge=charge or 'b06-charge-'+uuid.uuid4().hex
 sql('update invoices set company_id=null,gateway=\'demo\',gateway_charge_id='+q(charge)+',financial_connection_id='+q(connection['id'])+' where id='+q(inv['id']),'nexo_test')
 return inv['id'],charge

def event(charge):return {'id':'b06-event-'+uuid.uuid4().hex,'type':'payment.confirmed','charge_id':charge,'payment':{'id':'b06-pay-'+uuid.uuid4().hex,'amount_cents':10000,'currency':'BRL','paid_at':'2026-10-26T12:00:00Z','method':'pix'}}
def callback(ev,ts=None,signature=None,base=BASE):
 stamp=ts or str(int(time.time()));raw=json.dumps(ev)
 sig=signature or 'sha256='+hmac.new(secret.encode(),(stamp+'.'+connection['id']+'.'+raw).encode(),hashlib.sha256).hexdigest()
 return call('/webhooks/gateway/demo',ev,headers={'X-Nexo-Connection':connection['id'],'x-nexo-timestamp':stamp,'x-nexo-signature':sig},base=base)
inv,charge=invoice();ev=event(charge)
for fields in [{'amount_cents':1.5},{'amount_cents':'10000'},{'amount_cents':2147483648},{'amount_cents':9007199254740993},{'amount_cents':-1},{'currency':'USD'},{'paid_at':'yesterday'}]:
 invalid=dict(ev,id=uuid.uuid4().hex,payment=dict(ev['payment'],**fields));assert callback(invalid)['status']==400,fields
assert not rows('select id from payments where invoice_id='+q(inv))
check('authenticated malformed integer cents, currency and timestamp are rejected before any payment')
assert callback(ev,signature='sha256='+'0'*64)['status']==401
assert callback(ev,ts=str(int(time.time())-600))['status']==401
check('tampered signature and stale authenticated callback are rejected')
# Callback arrived before the charge is registered: inbox remains scoped and retryable.
early_charge='early-'+serial;early=event(early_charge)
assert callback(early)['json']['status']=='unmatched'
assert callback(early)['json']['status']=='unmatched'
early_invoice,_=invoice(early_charge)
with concurrent.futures.ThreadPoolExecutor(8) as pool:replies=list(pool.map(lambda n:callback(early,base=BASE if n%2 else SECOND),range(32)))
assert all(r['status']==200 for r in replies),replies
assert len(rows('select id from payments where invoice_id='+q(early_invoice)))==1
assert len(rows('select id from payment_effects where invoice_id='+q(early_invoice)))==1
check('early callback is durably unmatched; later concurrent replay creates one receipt and one technical effect')
# Data in payload does not route ownership, and discarded acknowledgement is replay-safe.
spoof=dict(ev,tenant_id=str(uuid.uuid4()),account_ref='other-account',environment='production')
assert callback(spoof)['status']==200
assert callback(spoof)['json']['status']=='duplicate'
assert len(rows('select id from payments where invoice_id='+q(inv)))==1
altered=dict(spoof,id=uuid.uuid4().hex,payment=dict(ev['payment'],paid_at='2026-10-27T12:00:00Z'))
assert callback(altered)['status']==409
check('payload cannot select tenant/account; retry after unobserved acknowledgement is safe; reused payment with changed timestamp conflicts')
# Lost delivery: provider side contains payment, ERP receives it through adapter lookup.
lost,lc=invoice();payment=event(lc)['payment']
sql('insert into demo_gateway_charges(tenant_id,financial_connection_id,charge_id,amount_cents,payments) values('+q(tenant)+','+q(connection['id'])+','+q(lc)+',10000,'+q(json.dumps([payment]))+'::jsonb)','nexo_test')
api('/finance/reconcile',{})
assert api('/invoices/'+lost)['paid_cents']==10000
assert callback({'id':'late-'+serial,'type':'payment.confirmed','charge_id':lc,'payment':payment})['status']==200
assert len(rows('select id from payments where invoice_id='+q(lost)))==1
check('lost callback recovered by adapter reconciliation; late callback does not duplicate cash')
# Refund first, then confirmation: cash is preserved but automatic settlement is forbidden.
for kind in ['payment.refunded','payment.chargeback']:
 disputed,dc=invoice();notice={'id':kind+serial,'type':kind,'charge_id':dc}
 assert callback(notice)['json']['status']=='divergent'
 confirmation=event(dc);assert callback(confirmation)['json']['status']=='divergent'
 detail=api('/invoices/'+disputed);assert detail['status']=='reconciling' and detail['paid_cents']==10000
 assert not rows('select id from payment_effects where invoice_id='+q(disputed))
 # Reconciliation must obey the same review gate as callbacks.
 extra=dict(confirmation['payment'],id=uuid.uuid4().hex,amount_cents=1000)
 sql('insert into demo_gateway_charges(tenant_id,financial_connection_id,charge_id,amount_cents,payments) values('+q(tenant)+','+q(connection['id'])+','+q(dc)+',10000,'+q(json.dumps([extra]))+'::jsonb)','nexo_test')
 api('/finance/reconcile',{});assert api('/invoices/'+disputed)['status']=='reconciling'
 assert not rows('select id from payment_effects where invoice_id='+q(disputed))
check('refund/chargeback before confirmation or reconciliation preserves cash in review and creates no automatic technical effect')
assert not rows('select * from financial_balance_shadow where not matches')
check('B04 shadow remains consistent after adverse event order')
(ROOT/'tests/contrato/relatorios/provider-contract.json').write_text(json.dumps({'ok':True,'checks':checks,'real_provider_enabled':False},indent=2))
