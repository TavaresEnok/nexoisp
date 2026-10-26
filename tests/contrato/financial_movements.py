"""B04 checks in the explicitly owned native PostgreSQL, never product env."""
import json,os,subprocess,uuid,time
from urllib.parse import urlparse
from lib import sql,quote,ROOT,request
assert os.environ.get('NEXO_PAYMENT_LAB')=='1'
def rows(q):return json.loads(sql("select coalesce(json_agg(x),'[]') from ("+q+") x",'nexo_test'))
checks=[]
def check(s):checks.append(s);print('PASS B04 '+s,flush=True)
assert not rows('select * from financial_balance_shadow where not matches')
assert not rows('select * from financial_agreement_shadow where not matches')
check('all native/B02/B03 API flows match reconstructed balances and agreement source/installment totals')
base=os.environ['NEXO_PAYMENT_LAB_URL'];assert urlparse(base).hostname=='127.0.0.1'
def call(path,body=None,token=None):
 for _ in range(30):
  response=request(base,'/api'+path,token=token,method='POST' if body is not None else 'GET',headers={'Content-Type':'application/json'},body=json.dumps(body).encode() if body is not None else None)
  if response['status']!=429:break
  time.sleep(.3)
 assert response['status']==200,(path,response)
 return response['json']
token=call('/auth/login',{'email':'admin@alfa.demo','password':'demo1234','bearer':True})['token']
def api(path,body=None):return call(path,body,token)
sub=api('/subscribers',{'name':'B04 agreement '+uuid.uuid4().hex[:8]})
k=api('/contracts',{'subscriber_id':sub['id'],'plan_id':api('/plans')[0]['id'],'due_day':15})
original=api('/invoices',{'contract_id':k['id'],'description':'B04 partial agreement','amount_cents':10000,'due_date':'2026-01-15'})
api('/invoices/'+original['id']+'/manual-payment',{'intent_id':str(uuid.uuid4()),'amount_cents':4000,'paid_at':'2026-10-26','partial':True,'method':'cash','note':'B04 partial receipt'})
agreement=api('/contracts/'+k['id']+'/agreement',{'invoice_ids':[original['id']],'installments':2,'first_due_date':'2026-11-10','discount_cents':1000,'reason':'B04 synthetic residual agreement'})
a=rows('select * from financial_agreement_shadow where id='+quote(agreement['id']))[0]
assert a['matches'] and a['source_cents']==6000 and a['installment_cents']==5000,a
old=rows('select * from financial_balance_shadow where invoice_id='+quote(original['id']))[0]
assert old['received_cents']==4000 and old['residual_cents']==6000 and old['collectible_cents']==0,old
assert rows('select count(*) n from financial_payment_allocations where invoice_id in (select id from invoices where agreement_id='+quote(agreement['id'])+ ')')[0]['n']==0
check('authenticated partial agreement transfers only residual; discount and installments reconcile without copying original receipts')
k=rows('select id,tenant_id,subscriber_id from contracts where id='+quote(k['id']))[0]
pop=str(uuid.uuid4());sql('insert into pops(id,tenant_id,name) values('+quote(pop)+','+quote(k['tenant_id'])+",'B04 scoped POP');update contracts set pop_id="+quote(pop)+' where id='+quote(k['id']),'nexo_test')
i=str(uuid.uuid4());p=str(uuid.uuid4());r=str(uuid.uuid4())
q=quote
sql("insert into invoices(id,tenant_id,contract_id,subscriber_id,kind,due_date,amount_cents) values("+','.join(map(q,[i,k['tenant_id'],k['id'],k['subscriber_id']]))+",'manual',current_date,10000)",'nexo_test')
def state():return rows('select * from financial_balance_shadow where invoice_id='+q(i))[0]
assert state()['residual_cents']==10000
sql('update invoices set fee_cents=500,discount_cents=1000 where id='+q(i),'nexo_test')
sql("insert into payments(id,tenant_id,invoice_id,amount_cents,paid_at,source) values("+','.join(map(q,[p,k['tenant_id'],i]))+",4000,now(),'manual')",'nexo_test')
s=state();assert (s['nominal_cents'],s['fee_cents'],s['discount_cents'],s['received_cents'],s['residual_cents'])==(10000,500,1000,4000,5500),s
check('nominal fees discount and partial receipt reconstruct independently')
sql("insert into payments(id,tenant_id,invoice_id,amount_cents,paid_at,source,kind,reversal_of) values("+','.join(map(q,[r,k['tenant_id'],i]))+",4000,now(),'manual','reversal',"+q(p)+")",'nexo_test');assert state()['residual_cents']==9500
sql("insert into payments(tenant_id,invoice_id,amount_cents,paid_at,source) values("+q(k['tenant_id'])+','+q(i)+",12000,now(),'manual')",'nexo_test');s=state();assert s['excess_cents']==2500 and s['residual_cents']==0
assert rows('select sum(allocated_cents)::bigint n from financial_payment_allocations where invoice_id='+q(i))[0]['n']==12000
check('signed reversal restores residual; excess remains explicit without duplicated cash')
errors=[]
def rejected(name,query,expected):
 try:sql(query,'nexo_test')
 except subprocess.CalledProcessError as e:
  assert expected in e.stderr,e.stderr;errors.append({'case':name,'error':e.stderr})
 else:raise AssertionError(name)
rejected('mutable movement','update invoice_movements set nominal_delta=0 where invoice_id='+q(i),'append-only')
rejected('mutable payment','delete from payments where id='+q(p),'append-only')
rejected('cross-invoice reversal',"insert into payments(tenant_id,invoice_id,amount_cents,paid_at,source,kind,reversal_of) select tenant_id,id,4000,now(),'manual','reversal',"+q(p)+' from invoices where id<>'+q(i)+' limit 1','reversal must match')
rejected('destructive down',(ROOT/'db/migrations/00066_financial_movements.sql').read_text().split('-- +goose Down')[1],'Preserve financial movements')
check('history mutation, foreign reversal and destructive downgrade rejected')
# Transactional rollback must remove both source changes and their movements.
before=rows('select count(*) n from invoice_movements where invoice_id='+q(i))[0]['n']
sql('begin;update invoices set amount_cents=11000 where id='+q(i)+';rollback;','nexo_test')
assert state()['nominal_cents']==10000 and rows('select count(*) n from invoice_movements where invoice_id='+q(i))[0]['n']==before
check('rollback restores invoice and movements together')
# Role-based nonvacuous RLS checks, using scoped invoice visibility as authority.
for scope in ['',"select set_config('app.subscriber_id',"+q(str(uuid.uuid4()))+",true);", "select set_config('app.pop_ids',"+q(str(uuid.uuid4()))+",true);"]:
 prefix="begin;set local role nexo_app;select set_config('app.tenant_id',"+q(k['tenant_id'])+",true);"+scope
 result=sql(prefix+'select count(*) from financial_balance_shadow where invoice_id='+q(i)+';rollback;','nexo_test').splitlines()[-1]
 assert result==('1' if not scope else '0'),result
other=rows('select id from tenants where id<>'+q(k['tenant_id'])+' limit 1')[0]['id']
assert sql("begin;set local role nexo_app;select set_config('app.tenant_id',"+q(other)+",true);select count(*) from invoice_movements where invoice_id="+q(i)+';rollback;','nexo_test').splitlines()[-1]=='0'
check('tenant portal and POP restrictions protect movements and shadow views')
# Demonstrate discrepancy detection without committing corruption or cutting over.
result=sql('begin;alter table invoices disable trigger invoice_movement_record;update invoices set amount_cents=11000 where id='+q(i)+';select matches from financial_balance_shadow where invoice_id='+q(i)+';rollback;','nexo_test')
assert result=='f',result
assert state()['matches']
check('shadow detects synthetic drift; rollback preserves original reads and ledger')
assert not rows('select * from financial_balance_shadow where not matches')
(ROOT/'tests/contrato/relatorios/financial-movements.json').write_text(json.dumps({'ok':True,'checks':checks,'expected_errors':errors},indent=2))
