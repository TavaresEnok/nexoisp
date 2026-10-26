"""Focused HTTP regression, only against explicitly enabled synthetic loopback lab.
Provision DB/API via isolated harness before execution. No production configuration read.
"""
import concurrent.futures
import json
import os
import time
import uuid
from urllib.parse import urlparse
from lib import request

BASE=os.environ['NEXO_PAYMENT_LAB_URL']
SECOND=os.environ.get('NEXO_PAYMENT_LAB_URL_2',BASE)
assert os.environ.get('NEXO_PAYMENT_LAB')=='1'
assert all(urlparse(x).hostname=='127.0.0.1' for x in [BASE,SECOND])
checks=[]
def check(name): checks.append(name); print('PASS '+name,flush=True)
def call(path,body=None,token=None,base=BASE,method=None):
 for attempt in range(20):
  r=request(base,'/api'+path,token=token,method=method or ('POST' if body is not None else 'GET'),headers={'Content-Type':'application/json'},body=json.dumps(body).encode() if body is not None else None)
  if r['status']!=429:return r
  time.sleep(.3)
 raise AssertionError('rate limit remained after retry')
def login(email):
 r=call('/auth/login',{'email':email,'password':'demo1234','bearer':True});assert r['status']==200,r
 token=r['json']['token'];assert call('/me',token=token)['json']['demo'] is True
 return token
token=login('admin@alfa.demo')
def api(path,body=None,base=BASE):
 r=call(path,body,token,base);assert r['status']==200,(path,r['status'],r['json']);return r['json']
plan=api('/plans')[0]
sub=api('/subscribers',{'name':'Lote01 financial '+uuid.uuid4().hex[:8]})
contract=api('/contracts',{'subscriber_id':sub['id'],'plan_id':plan['id'],'due_day':15})
def invoice(amount=10000):return api('/invoices',{'contract_id':contract['id'],'description':'Intenção sintética lote01','amount_cents':amount,'due_date':'2026-01-15'})
inv=invoice();path='/invoices/'+inv['id']+'/manual-payment'
pay={'intent_id':str(uuid.uuid4()),'amount_cents':2000,'paid_at':'2026-10-26','note':'Recebimento sintético','partial':True,'method':'cash'}
for bad in [{k:v for k,v in pay.items() if k!='intent_id'},dict(pay,intent_id='legacy-without-uuid')]:
 assert call(path,bad,token)['status'] in [400,422]
assert api('/invoices/'+inv['id'])['payments']==[]
check('legacy/malformed client rejected before creating a payment; no unsafe generated intent')
with concurrent.futures.ThreadPoolExecutor(12) as pool:
 results=list(pool.map(lambda i:call(path,pay,token,BASE if i%2 else SECOND),range(100)))
assert all(r['status']==200 and r['json']=={'status':'open'} for r in results),[(r['status'],r['json']) for r in results if r['status']!=200]
detail=api('/invoices/'+inv['id']);assert len(detail['payments'])==1 and detail['paid_cents']==2000,detail
check('100 concurrent replays across two API processes persist one payment')
assert call(path,dict(pay,amount_cents=3000),token)['status']==409
check('same key divergent payload rejected with 409')
api(path,dict(pay,intent_id=str(uuid.uuid4())))
detail=api('/invoices/'+inv['id']);assert len(detail['payments'])==2 and detail['paid_cents']==4000
check('new intention of same amount creates legitimate second receipt')
summary=api('/contracts/'+contract['id']+'/finance')
assert int(summary['nominal_open_cents'])==10000 and int(summary['received_open_cents'])==4000 and int(summary['open_cents'])==6000 and int(summary['overdue_cents'])==6000,summary
check('contract summary nominal100 received40 residual60 including overdue')
finance_before=api('/finance/summary')
api('/invoices/'+inv['id']+'/payments/'+detail['payments'][0]['id']+'/reverse',{'reason':'Estorno sintético lote01'})
summary=api('/contracts/'+contract['id']+'/finance'); assert int(summary['open_cents'])==8000 and int(summary['received_cents'])==2000,summary
finance_after=api('/finance/summary'); assert finance_after['open_cents']-finance_before['open_cents']==2000,(finance_before,finance_after)
check('reversal restores residual and reduces net received in both summaries')
api(path,pay);assert len(api('/invoices/'+inv['id'])['payments'])==3
check('replay after reversal cannot recreate reversed money')
inv2=invoice();assert call('/invoices/'+inv2['id']+'/manual-payment',pay,token)['status']==409
check('key cannot move to another invoice')
invalid=dict(pay,intent_id=str(uuid.uuid4()),discount_cents=10000000,discount_reason='Desconto sintético')
assert call(path,invalid,token)['status'] in [400,422]
invalid['discount_cents']=100;api(path,invalid)
summary=api('/contracts/'+contract['id']+'/finance');assert int(summary['open_cents'])==15900,summary
check('rejected transaction leaves no claim; corrected intention commits discount once')
beta=login('admin@beta.demo');assert call(path,pay,beta)['status']==404
attendant=login('atendimento@alfa.demo');assert call(path,pay,attendant)['status']==403
check('cross-tenant replay and unauthorized role denied')
full=invoice(2000);fullpay=dict(pay,intent_id=str(uuid.uuid4()),partial=False);fullpath='/invoices/'+full['id']+'/manual-payment'
a=api(fullpath,fullpay);b=api(fullpath,fullpay);assert a==b=={'status':'paid'}
assert len(api('/invoices/'+full['id'])['payments'])==1
check('replay of paid invoice returns original result without second event')
# More than latest-24: financial aggregates must not be capped by rendering limit.
for _ in range(25): invoice(100)
summary=api('/contracts/'+contract['id']+'/finance');assert len(summary['invoices'])==24 and int(summary['open_cents'])==18400,summary
check('contract aggregate includes titles outside latest-24 list')
print(json.dumps({'checks':checks,'contract':contract['id'],'invoice':inv['id'],'summary':summary},ensure_ascii=False))
