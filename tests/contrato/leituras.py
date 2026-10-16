#!/usr/bin/env python3
"""Fase 2: diferencial HTTP, filtros esperados independentes e portal com dados privados."""
import json
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlencode

from lib import ROOT, records, request, sql, quote
from contrato import HEADERS, same, visible_contract, visible_subscriber

FASTIFY='http://127.0.0.1:18081'
GO='http://127.0.0.1:18082'
RESULTS=[]


def check(name,path,token=None,cookie=False,status=None,oracle=None,method='GET',compare=same):
    a,b=[request(base,path,token,cookie,method=method) for base in (FASTIFY,GO)]
    failures=[]
    if a['status']!=b['status']:failures.append(f'status {a["status"]}/{b["status"]}')
    if a['json'] is not None:
        if not compare(a['json'],b['json']):failures.append('JSON')
    elif a['body']!=b['body']:failures.append('bytes')
    for h in HEADERS:
        if a['headers'].get(h)!=b['headers'].get(h):failures.append('header '+h)
    if status is not None and (a['status']!=status or b['status']!=status):failures.append('status esperado '+str(status))
    if oracle and a['status']==200:
        for label,response in [('Fastify',a),('Go',b)]:
            try:oracle(response['json'])
            except (AssertionError,KeyError,TypeError) as e:failures.append('oráculo '+label+': '+str(e))
    RESULTS.append({'caso':name,'rota':path,'ok':not failures,'falhas':failures})
    if failures:print(json.dumps(RESULTS[-1],ensure_ascii=False));print(str({'fastify':a['json'],'go':b['json']})[:1800])
    return a,b


def ids(rows):return {r['id'] for r in rows}
def assert_equal(a,b):assert a==b,(a,b)


def main():
    sql((ROOT/'tests/contrato/dados/leituras.sql').read_text())
    tenants=records("select t.id,t.modules,(select count(*) from subscribers where tenant_id=t.id) n from tenants t where t.slug like 'bench-%' order by n desc")
    tenants=[tenants[0],tenants[len(tenants)//2],tenants[-1]]
    try:
        # Um provedor completo e outro sem módulos dão caminhos positivos e negativos.
        sql('update tenants set modules=\'{crm,field}\' where id='+quote(tenants[0]['id']))
        for _ in range(100):
            user=records('select id from users where tenant_id='+quote(tenants[0]['id'])+" and email like '%-subscriber@contrato.invalid'")[0]
            if request(GO,'/api/me','contrato:'+user['id'])['json'].get('modules')==['crm','field']:break
            time.sleep(.02)
        for t in tenants:
            tenant=t['id']
            subs=records(f'select id from subscribers where tenant_id={quote(tenant)} order by id limit 2')
            plans=records(f'select id from plans where tenant_id={quote(tenant)} order by id limit 1')
            userrows=records(f"select id,name,role,subscriber_id from users where tenant_id={quote(tenant)} and email like '%@contrato.invalid' order by name")
            sid=next(u['subscriber_id'] for u in userrows if u['role']=='subscriber')
            contract=records('select id from contracts where subscriber_id='+quote(sid)+' order by id limit 1')[0]['id']
            ticket=records('select id from tickets where subscriber_id='+quote(sid)+' order by id limit 1')[0]['id']
            other_ticket=records('select id from tickets where subscriber_id<>'+quote(sid)+' order by id limit 1')[0]['id']
            paths=['/api/me','/api/contracts?limit=3','/api/dashboard','/api/plans','/api/plans/'+plans[0]['id']+'/versions',
                   '/api/subscribers/'+sid+'/portal-access','/api/portal/overview','/api/portal/usage-series?contract_id='+contract,
                   '/api/portal/acceptances','/api/portal/tickets','/api/portal/tickets/'+ticket,'/api/portal/surveys']
            for u in userrows+[{'id':None,'name':'support','role':'support'}]:
                token='contrato:'+u['id'] if u['id'] else 'support:'+tenant
                for cookie in [False,True]:
                    for path in paths:check(u['name'],path,token,cookie)
                if u['name'] in ['admin','pop']:
                    scope={'tenant':tenant}
                    if u['name']=='pop':scope['pop']=records(f'select pop_id from user_pops where user_id={quote(u["id"])}')[0]['pop_id']
                    allowed=ids(records('select c.id from contracts c where '+visible_contract(scope)+' order by c.created_at desc,c.id limit 3'))
                    check('contratos esperados',paths[1],token,oracle=lambda rows:assert_equal(ids(rows),allowed))
                    expected=records(f"select (select count(*) from subscribers s where {visible_subscriber(scope)} and s.status='active') subscribers,(select count(*) from contracts c where {visible_contract(scope)} and c.status='active') contracts,(select count(*) from plans where tenant_id={quote(tenant)} and active) plans,(select coalesce(sum(v.price_cents),0)::bigint from contracts c join plan_versions v on v.id=c.plan_version_id where {visible_contract(scope)} and c.status='active') mrr_cents")[0]
                    check('dashboard esperado','/api/dashboard',token,oracle=lambda data:assert_equal(data,expected))
                if u['role']=='subscriber':
                    own=ids(records('select id from contracts where subscriber_id='+quote(sid)))
                    check('portal próprio','/api/portal/overview',token,status=200,oracle=lambda d:assert_equal(ids(d['contracts']),own))
                    check('chamado de outro assinante','/api/portal/tickets/'+other_ticket,token,status=404 if t==tenants[0] else None)
                    for by in ['hour','day','week','year']:
                        check('série '+by,'/api/portal/usage-series?'+urlencode({'contract_id':contract,'by':by}),token,status=200)
                    for suffix in ['', '?contract_id=bad','?contract_id='+contract+'&by=bad','?contract_id='+contract+'&by=day&by=week','?by=bad&contract_id=bad']:
                        check('validação portal','/api/portal/usage-series'+suffix,token,status=400)
                    if t==tenants[0]:
                        expected_tickets=ids(records('select id from tickets where subscriber_id='+quote(sid)))
                        check('chamados próprios','/api/portal/tickets',token,status=200,oracle=lambda d:assert_equal(ids(d),expected_tickets))
                        expected_acceptances=ids(records("select id from acceptances where status<>'canceled' and subscriber_id="+quote(sid)))
                        check('aceites próprios','/api/portal/acceptances',token,status=200,oracle=lambda d:assert_equal(ids(d),expected_acceptances))
                        check('sem mensagem interna','/api/portal/tickets/'+ticket,token,status=200,oracle=lambda d:assert_equal([m['body'] for m in d['thread']],['fixture leitura pública']))
                        expected_surveys=ids(records('select id from satisfaction_surveys where subscriber_id='+quote(sid)+' and answered_at is null and expires_at>now()'))
                        check('pesquisas próprias','/api/portal/surveys',token,status=200,oracle=lambda d:assert_equal(ids(d),expected_surveys))
            admin=next(u for u in userrows if u['name']=='admin');token='contrato:'+admin['id']
            for suffix in ['?limit=0&offset=-1','?q=a&q=b&status=bad&tag=bad&company_id=bad&format=csv&format=x&limit=x','?status=inactive','?q='+('x'*101),'?limit=0x2','?limit=3&offset=2','?format=csv&limit=2','?format=csv&limit=2&offset=2']:
                check('filtro contratos','/api/contracts'+suffix,token)
            for path in paths:
                check('sem sessão',path,status=401)
                check('HEAD',path,token,method='HEAD')
        check('operador global','/api/me','contrato:'+records("select id from users where email='operator@contrato.invalid'")[0]['id'],status=200)
    finally:
        for t in tenants:sql('update tenants set modules='+quote('{'+','.join(t['modules'])+'}')+' where id='+quote(t['id']))
    report={'fase':2,'total':len(RESULTS),'aprovados':sum(r['ok'] for r in RESULTS),'casos':RESULTS}
    target=ROOT/'tests/contrato/relatorios'/('leituras-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.json')
    target.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k!='casos'}))
    return 0 if report['aprovados']==report['total'] else 1

if __name__=='__main__':sys.exit(main())
