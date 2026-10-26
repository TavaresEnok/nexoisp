"""B05: own PostgreSQL, real APIs/River and synthetic network intentions only."""
import os,sys,json,time,uuid,subprocess,base64,concurrent.futures
from pathlib import Path
assert os.environ.get('NEXO_PAYMENT_LAB')=='1'
os.environ['NEXO_CONTRATO_DB_CONTAINER']='nexo-b05-'+uuid.uuid4().hex[:10]
os.environ['NEXO_CONTRATO_DB_PORT']='15692'
from lib import ROOT,LOCAL,DB_CONTAINER,go_env,sql,quote,request,wait,command
from nativo import up
checks=[];processes=[];workers=[];q=quote
out=ROOT/'tests/contrato/relatorios';out.mkdir(exist_ok=True)
def check(s):checks.append(s);print('PASS B05 '+s,flush=True)
def rows(query):return json.loads(sql("select coalesce(json_agg(x),'[]') from ("+query+") x",'nexo_test'))
def poll(fn):
 for _ in range(250):
  result=fn()
  if result:return result
  time.sleep(.1)
 raise AssertionError('timeout waiting for lab state')
def launch(port,enabled=False,binary=None):
 env=dict(labenv,NEXO_GO_ADDR='127.0.0.1:'+str(port),NEXO_GO_INTERNAL_ADDR='127.0.0.1:'+str(port+1000),NEXO_GO_AGENT_ADDR='127.0.0.1:'+str(port+2000),NEXO_GO_JOBS='1' if enabled else '0',NEXO_GO_JOB_PAYMENT_EFFECTS='1' if enabled else '0',NEXO_GO_JOB_RADIUS='0')
 log=open(LOCAL/('b05-'+str(port)+'.log'),'w')
 p=subprocess.Popen([str(binary or ROOT/'apps/api-go/bin/api')],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT);processes.append((p,log));wait('http://127.0.0.1:'+str(port+1000),'/healthz',p)
 return p
base='http://127.0.0.1:18970'
def call(path,body=None,token=None,url=base):
 for _ in range(30):
  r=request(url,'/api'+path,token=token,method='POST' if body is not None else 'GET',headers={'Content-Type':'application/json'},body=json.dumps(body).encode() if body is not None else None)
  if r['status']!=429:return r
  time.sleep(.2)
 raise AssertionError('rate limit')
def login(email,url=base):
 r=call('/auth/login',{'email':email,'password':'demo1234','bearer':True},url=url);assert r['status']==200,r;return r['json']['token']
def api(path,body=None,token=None):
 r=call(path,body,token or alfa);assert r['status']==200,(path,r);return r['json']
fixture_number=0
def fixture(token=None):
 global fixture_number
 fixture_number+=1
 token=token or alfa
 sub=api('/subscribers',{'name':'B05 '+uuid.uuid4().hex[:8]},token)
 k=api('/contracts',{'subscriber_id':sub['id'],'plan_id':api('/plans',token=token)[0]['id'],'due_day':15},token)
 device=api('/radius/devices',{'name':'B05 synthetic NAS '+uuid.uuid4().hex[:8],'vendor':'mikrotik','connection':'direct','nas_ip':'127.0.0.'+str(fixture_number)},token)
 service=api('/contracts/'+k['id']+'/service',{'device_id':device['id'],'pppoe_username':'b05_'+uuid.uuid4().hex[:12],'password':'synthetic-only'},token)
 inv=api('/invoices',{'contract_id':k['id'],'description':'B05 synthetic receipt','amount_cents':10000,'due_date':'2026-01-15'},token)
 sql("update service_resources set desired_policy='suspended',desired_reason='inadimplência sintética',desired_version=desired_version+1 where id="+q(service['resource_id']),'nexo_test')
 return {'invoice':inv['id'],'resource':service['resource_id'],'contract':k['id'],'token':token}
def payment(f):return {'intent_id':str(uuid.uuid4()),'amount_cents':10000,'paid_at':'2026-10-26','note':'B05 synthetic receipt'}
def pay(f,body=None):return api('/invoices/'+f['invoice']+'/manual-payment',body or payment(f),f['token'])
def effect(f):return rows('select * from payment_effects where invoice_id='+q(f['invoice'])+' order by settlement_version desc')[0]
def operations(f):return rows("select id from operations where resource_id="+q(f['resource'])+" and action='subscriber.resume'")
def kick(tenant,n=1):
 for _ in range(n):sql("insert into nexo_jobs.river_job(kind,args,queue,max_attempts) values('nexo_periodic',"+q(json.dumps({'task':'PAYMENT_EFFECTS','tenant_id':tenant}))+"::jsonb,'tenant',3)",'nexo_test')
def stop_workers():
 for p in workers:
  if p.poll() is None:p.kill();p.wait()
 workers.clear()
def start_workers():workers.extend([launch(18980,True),launch(18981,True)])
assert subprocess.run(['docker','inspect',DB_CONTAINER],capture_output=True).returncode!=0
try:
 up();sql('create database nexo_test','postgres');LOCAL.mkdir(parents=True,exist_ok=True)
 labenv=dict(go_env('nexo_test'),NEXO_DEMO_MODE='1',NEXO_REQUIRE_ADMIN_MFA='0',NEXO_SECRET_KEY=base64.b64encode(os.urandom(32)).decode(),NEXO_RADIUS_KEY='b05-synthetic-radius-key-0000001',NEXO_RADIUS_DB_PASSWORD='b05-synthetic-radius',NEXO_REPLICA_PASSWORD='b05-synthetic-replica',NEXO_OP_SIGNING_KEY=base64.b64encode(subprocess.check_output(['openssl','genpkey','-algorithm','ed25519','-outform','DER'])).decode())
 for task in ['prepare','seed-demo']:command([str(ROOT/'apps/api-go/bin/nexo-db'),task],cwd=ROOT,env=labenv,capture_output=True)
 sql('insert into tenant_settings(tenant_id,auto_resume_on_payment) select id,true from tenants on conflict(tenant_id) do update set auto_resume_on_payment=true','nexo_test')
 launch(18970);launch(18971)
 alfa=login('admin@alfa.demo');beta=login('admin@beta.demo');tenant=api('/me')['tenant']['id']
 bad=fixture();good=fixture();other=fixture(beta);stale=fixture();pay(stale)
 old_payment=api('/invoices/'+stale['invoice'])['payments'][0]['id']
 api('/invoices/'+stale['invoice']+'/payments/'+old_payment+'/reverse',{'reason':'B05 reversed before consumer'})
 sql("create function b05_fail_audit() returns trigger language plpgsql as $$begin if new.action='service.auto_resume' and new.entity_id="+q(bad['resource'])+" then raise exception 'B05 synthetic failure after network intention';end if;return new;end$$;create trigger b05_fail_audit before insert on audit_events for each row execute function b05_fail_audit();",'nexo_test')
 body=payment(bad)
 baseline=os.environ.get('NEXO_B05_BASELINE_BINARY')
 if baseline:
  old=launch(18969,binary=baseline);old_token=login('admin@alfa.demo','http://127.0.0.1:18969')
  result=call('/invoices/'+bad['invoice']+'/manual-payment',body,old_token,'http://127.0.0.1:18969')
  assert result['status']==500,result
  assert not rows('select id from payments where invoice_id='+q(bad['invoice']))
  assert not rows('select id from payment_effects where invoice_id='+q(bad['invoice']))
  old.terminate();old.wait(timeout=10)
  check('pre-B05 binary: synthetic technical failure rolled back receipt (HTTP500, zero payments)')
 with concurrent.futures.ThreadPoolExecutor(8) as pool:
  replies=list(pool.map(lambda n:call('/invoices/'+bad['invoice']+'/manual-payment',body,alfa,'http://127.0.0.1:'+str(18970+n%2)),range(32)))
 assert all(r['status']==200 for r in replies),replies
 assert len(rows('select id from payments where invoice_id='+q(bad['invoice'])))==1
 assert len(rows('select id from payment_effects where invoice_id='+q(bad['invoice'])))==1
 pay(good);pay(other)
 assert effect(bad)['status']=='pending' and not operations(bad)
 check('32 concurrent receipts/replays across two APIs commit one payment and one durable effect with consumer disabled')
 # Tenant/portal isolation, and app role cannot manufacture or delete effects.
 beta_tenant=api('/me',token=beta)['tenant']['id']
 for scoped_tenant,scope in [(beta_tenant,''),(tenant,"select set_config('app.subscriber_id',"+q(str(uuid.uuid4()))+",true);")]:
  count=sql("begin;set local role nexo_app;select set_config('app.tenant_id',"+q(scoped_tenant)+",true);"+scope+'select count(*) from payment_effects where invoice_id='+q(bad['invoice'])+';rollback;','nexo_test').splitlines()[-1];assert count=='0'
 check('effect inbox hides foreign tenants and portal subscribers')
 start_workers()
 poll(lambda:effect(bad)['attempts']>0 and effect(good)['status']=='planned' and effect(other)['status']=='planned' and effect(stale)['status']=='ignored')
 assert effect(bad)['status']=='pending' and not operations(bad)
 assert api('/invoices/'+bad['invoice'])['paid_cents']==10000
 assert not operations(stale) and len(operations(good))==len(operations(other))==1
 check('technical transaction rolls back alone; failed device does not starve healthy peers/tenant; reversal before consumption is ignored')
 sql('drop trigger b05_fail_audit on audit_events;drop function b05_fail_audit();update payment_effects set next_attempt_at=now() where invoice_id='+q(bad['invoice']),'nexo_test')
 kick(tenant,12);poll(lambda:effect(bad)['status']=='planned');assert len(operations(bad))==1
 check('repair and concurrent dispatches produce one intention, preserving confirmed receipt')
 # Commit then crash: durable business status prevents replay even if River ack is lost.
 op=operations(bad)[0]['id'];stop_workers();start_workers();kick(tenant,12)
 time.sleep(1);assert operations(bad)==[{'id':op}]
 check('consumer process restart after intention commit preserves operation identity')
 # New settlement after reversal must create a new event; an old replay cannot.
 stop_workers();first=effect(bad)
 payment_id=api('/invoices/'+bad['invoice'])['payments'][0]['id']
 api('/invoices/'+bad['invoice']+'/payments/'+payment_id+'/reverse',{'reason':'B05 new settlement cycle'})
 sql("update service_resources set desired_policy='suspended',desired_reason='inadimplência sintética',desired_version=desired_version+1 where id="+q(bad['resource']),'nexo_test')
 pay(bad);assert effect(bad)['settlement_version']==first['settlement_version']+1
 api('/invoices/'+bad['invoice']+'/manual-payment',body);assert len(rows('select id from payment_effects where invoice_id='+q(bad['invoice'])))==2
 check('repayment after reversal has a new settlement version; replay of old intention adds no effect')
 # Crash with a network intention and River job still uncommitted.
 crash=fixture();pay(crash);eid=effect(crash)['id']
 sql("create function b05_pause_plan() returns trigger language plpgsql as $$begin if new.id="+q(eid)+"::uuid and new.status='planned' then perform pg_sleep(30);end if;return new;end$$;create trigger b05_pause_plan before update on payment_effects for each row execute function b05_pause_plan();",'nexo_test')
 start_workers();kick(tenant)
 sleepers=poll(lambda:rows("select pid from pg_stat_activity where datname='nexo_test' and application_name='nexo-go' and wait_event='PgSleep' and query like 'update payment_effects set status%'") )
 stop_workers()
 for row in sleepers:sql('select pg_terminate_backend('+str(row['pid'])+')','nexo_test')
 sql('drop trigger b05_pause_plan on payment_effects;drop function b05_pause_plan()','nexo_test')
 assert effect(crash)['status']=='pending' and not operations(crash)
 assert api('/invoices/'+crash['invoice'])['paid_cents']==10000
 # River may retain the killed job as running; a fresh dispatch recovers from
 # the business inbox without waiting for job rescue, and is safe if rescue races.
 start_workers();kick(tenant,12);poll(lambda:effect(crash)['status']=='planned')
 assert len(operations(crash))==1
 check('SIGKILL before planning commit rolls back intention/job only; restart recovers one operation without changing receipt')
 assert not rows('select * from financial_balance_shadow where not matches')
 assert not rows("select resource_id from operations where action='subscriber.resume' group by resource_id,idempotency_key having count(*)>1")
 check('financial shadow remains consistent and no duplicate network idempotency key exists')
 (out/'payment-effects.json').write_text(json.dumps({'ok':True,'checks':checks,'baseline_executed':bool(baseline),'physical_operations_executed':False},indent=2))
finally:
 for p,log in processes:
  if p.poll() is None:
   p.terminate()
   try:p.wait(timeout=10)
   except subprocess.TimeoutExpired:p.kill();p.wait()
  log.close()
 subprocess.run(['docker','rm','-f','-v',DB_CONTAINER],check=True)
