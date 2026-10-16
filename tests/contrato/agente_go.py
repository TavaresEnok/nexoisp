#!/usr/bin/env python3
"""Um provisionamento assinado Go executado pelo agente Python real, com NAS de demonstração."""
import json
import subprocess
import uuid
from lib import ROOT, records, request, sql, quote
from consolidacao import call, GO

u=records("select id,tenant_id from users where email like '%-admin@contrato.invalid' order by id limit 1")[0]
token='contrato:'+u['id']
a=call(GO,'/api/agents',token,{'name':'Agente Python '+uuid.uuid4().hex[:12]})
assert a['status']==200,a['json']
agent=a['json']
device=str(uuid.uuid4())
sql("insert into devices(id,tenant_id,name,driver,agent_id) values ("+','.join(quote(v) for v in [device,u['tenant_id'],'NAS Python '+device[:12],'demo',agent['id']])+")")
sub=records('select id from subscribers where tenant_id='+quote(u['tenant_id'])+' order by id limit 1')[0]['id']
plan=records('select id from plans where tenant_id='+quote(u['tenant_id'])+' and active limit 1')[0]['id']
k=call(GO,'/api/contracts',token,{'subscriber_id':sub,'plan_id':plan,'due_day':15})
assert k['status']==200,k['json']
config={'agent_token':agent['token'],'admin_token':token,'device':device,'contract':k['json']['id']}
script='''
import json,sys,tempfile,urllib.request
from nexo_agent.client import CloudClient
from nexo_agent.agent import Agent
from nexo_agent.store import Store
cfg=json.loads(sys.stdin.readline())
def api(path,body):
 r=urllib.request.Request('http://127.0.0.1:18082'+path,data=json.dumps(body).encode(),headers={'content-type':'application/json','authorization':'Bearer '+cfg['admin_token']},method='POST')
 return json.load(urllib.request.urlopen(r))
with tempfile.TemporaryDirectory() as data:
 client=CloudClient('http://127.0.0.1:8443',cfg['agent_token'],None)
 agent=Agent(client,Store(data+'/agent.sqlite'),data)
 agent.connect_and_sync()
 out=api('/api/contracts/'+cfg['contract']+'/service',{'device_id':cfg['device'],'pppoe_username':'go_'+cfg['contract'][:12],'password':'senha-sintetica-123'})
 assert agent.tick(), 'nenhuma operação reservada'
 r=json.load(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:18082/api/operations/'+out['operation_id'],headers={'authorization':'Bearer '+cfg['admin_token']})))
 assert r['status']=='SUCCEEDED',r
 assert client.usage_report(cfg['device'],[])['accepted']==0
 assert client.sessions_report(cfg['device'],[])['accepted']==0
 print('Agente Python real: assinatura, sincronização, reserva, execução e confirmação Go passaram')
'''
result=subprocess.run(['docker','run','--rm','-i','--network','host','--security-opt','seccomp=unconfined','-v',str(ROOT/'services/network-agent')+':/agent:ro','--entrypoint','python','nexoisp-agent','-c',script],input=json.dumps(config)+'\n',text=True,capture_output=True)
print(result.stdout,end='')
if result.returncode:
 print(result.stderr[-5000:]);raise SystemExit(result.returncode)
