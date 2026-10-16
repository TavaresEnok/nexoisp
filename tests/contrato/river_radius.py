#!/usr/bin/env python3
"""River + executor RADIUS em processo descartável; NAS loopback sem sessões nem tráfego externo."""
import json
import hashlib
import hmac
import subprocess
import time
import uuid
from lib import ROOT, LOCAL, go_env, records, sql, quote
from consolidacao import call
from laboratorio import wait

base='http://127.0.0.1:18084'
assert sql("select count(*) from operations o join agents a on a.id=o.agent_id where a.internal and o.status in ('PENDING','UNCERTAIN')")=='0','laboratório com operação RADIUS pendente'
env=dict(go_env(),NEXO_GO_ADDR='127.0.0.1:18084',NEXO_GO_INTERNAL_ADDR='127.0.0.1:19084',NEXO_GO_AGENT_ADDR='127.0.0.1:18443',NEXO_RADIUS_KEY='chave-sintetica-radius-laboratorio',NEXO_GO_JOBS='1',NEXO_GO_JOB_RADIUS='1',NEXO_GO_JOB_RADIUS_SYNC='1',NEXO_GO_JOB_CLEANUP='1',NEXO_DEMO_MODE='1',NEXO_GATEWAY_WEBHOOK_SECRET='segredo-sintetico-gateway')
log=open(LOCAL/'river-radius.log','w')
p=subprocess.Popen([str(ROOT/'apps/api-go/bin/api')],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
try:
 wait('http://127.0.0.1:19084','/healthz',p)
 u=records("select id,tenant_id from users where email like '%-admin@contrato.invalid' order by id limit 1")[0]
 token='contrato:'+u['id']
 r=call(base,'/api/radius/devices',token,{'name':'NAS River '+uuid.uuid4().hex[:10],'vendor':'mikrotik','connection':'direct','nas_ip':'127.1.'+str(int(uuid.uuid4().hex[:2],16))+'.'+str(int(uuid.uuid4().hex[:2],16))})
 assert r['status']==200,r['json']
 device=r['json']['id']
 sub=records('select id from subscribers where tenant_id='+quote(u['tenant_id'])+' order by id limit 1')[0]['id']
 plan=records('select id from plans where tenant_id='+quote(u['tenant_id'])+' and active limit 1')[0]['id']
 k=call(base,'/api/contracts',token,{'subscriber_id':sub,'plan_id':plan,'due_day':15})
 assert k['status']==200,k['json']
 username='river_'+uuid.uuid4().hex[:12]
 r=call(base,'/api/contracts/'+k['json']['id']+'/service',token,{'device_id':device,'pppoe_username':username,'password':'senha-sintetica-radius'})
 assert r['status']==200,r['json']
 op=r['json']['operation_id']
 sql("insert into nexo_jobs.river_job(kind,args,max_attempts) values ('nexo_periodic','{\"task\":\"CLEANUP\"}',3)")
 status=None
 for _ in range(60):
  status=records('select status,note from operations where id='+quote(op))[0]
  if status['status']=='SUCCEEDED':break
  time.sleep(.25)
 assert status['status']=='SUCCEEDED',status
 acc=records('select policy,applied_version from radius_account where tenant_id='+quote(u['tenant_id'])+' and username='+quote(username))
 assert acc and acc[0]['policy']=='active' and acc[0]['applied_version']==1,acc
 sql("insert into nexo_jobs.river_job(kind,args,max_attempts,queue) values ('nexo_periodic','{\"task\":\"RADIUS_SYNC\"}',3,'network')")
 for _ in range(40):
  observed=records('select observed_policy from service_resources where id='+quote(r['json']['resource_id']))[0]['observed_policy']
  if observed=='active':break
  time.sleep(.25)
 assert observed=='active',observed
 invoice=call(base,'/api/invoices',token,{'contract_id':k['json']['id'],'description':'Gateway sintético','amount_cents':2300,'due_date':'2026-10-20'})
 assert invoice['status']==200,invoice['json']
 invoice_id=invoice['json']['id'];charge='demo_ch_'+invoice_id
 sql("update invoices set gateway='demo',gateway_charge_id="+quote(charge)+" where id="+quote(invoice_id))
 sql("insert into demo_gateway_charges(charge_id,tenant_id,amount_cents) values ("+','.join([quote(charge),quote(u['tenant_id']),'2300'])+")")
 lost=call(base,'/api/demo-gateway/pay',token,{'invoice_id':invoice_id,'mode':'lost'})
 assert lost['status']==200,lost['json']
 payment=records('select payments from demo_gateway_charges where charge_id='+quote(charge))[0]['payments'][-1]
 event={'id':'demo_evt_'+uuid.uuid4().hex,'type':'payment.confirmed','charge_id':charge,'payment':payment}
 timestamp=str(int(time.time()));raw=json.dumps(event,ensure_ascii=False).encode()
 signature='sha256='+hmac.new(b'segredo-sintetico-gateway',timestamp.encode()+b'.'+raw,hashlib.sha256).hexdigest()
 headers={'x-nexo-timestamp':timestamp,'x-nexo-signature':signature}
 for expected in ['processed','duplicate']:
  response=call(base,'/api/webhooks/gateway/demo',None,event,headers)
  assert response['status']==200 and response['json']['status']==expected,response['json']
 assert records('select count(*)::int as n from payments where invoice_id='+quote(invoice_id))[0]['n']==1
 jobs=records("select args,state,errors from nexo_jobs.river_job where kind='nexo_periodic' and created_at>now()-interval '1 minute'")
 assert any(j['args']['task']=='CLEANUP' and j['state']=='completed' for j in jobs),jobs
 assert not any(j['state']=='discarded' for j in jobs),jobs
 print('River real: migrações, execução periódica, RADIUS, accounting, cleanup e gateway assinado/idempotente passaram')
finally:
 p.terminate()
 try:p.wait(timeout=15)
 except subprocess.TimeoutExpired:p.kill();p.wait()
 log.close()
