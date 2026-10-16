#!/usr/bin/env python3
"""Campanha local de 9 rodadas: CPU cgroup e percentis k6, sem proxy de produção."""
import argparse
from datetime import datetime, timezone
import json
import hashlib
import os
from pathlib import Path
import random
import statistics
import subprocess
import time
import urllib.request

from laboratorio import go, wait
from lib import ROOT, LOCAL, DB_CONTAINER, DB_PORT, command, go_env, records, sql

NAMES=['nexo-fase1-carga-'+str(i) for i in range(4)]
DATABASE='nexo_contrato_carga_lab'


def query(q):return sql(q,DATABASE)


def prepare():
    if not sql("select count(*) from pg_database where datname='"+DATABASE+"'",'postgres')=='1':
        sql('create database '+DATABASE,'postgres')
    env=go_env(DATABASE)
    command([str(ROOT/'apps/api-go/bin/nexo-db'),'up'],cwd=ROOT,env=env,stdout=subprocess.DEVNULL)
    query('create extension if not exists pg_stat_statements')
    if query("select count(*) from tenants where slug like 'bench-%'")=='0':
        seed=(ROOT/'tests/contrato/dados/seed.sql').read_text()
        query('\\set tenants 40\n\\set subscribers 300000\n\\set min_per_tenant 200\n'+seed)
        controls=(ROOT/'tests/contrato/dados/controles.sql').read_text().replace("<> 'nexo_contrato_lab'","not in ('nexo_contrato_lab','nexo_contrato_carga_lab')")
        query(controls)
    # O núcleo funciona com e sem módulos adicionais. Ambos entram na carga.
    query("update tenants set modules=case when mod(abs(hashtext(id::text)::bigint),2)=0 then array['crm','field'] else '{}'::text[] end")
    fixture_query='''select u.id uid,u.tenant_id,t.modules,u.email like '%-pop@contrato.invalid' restricted_pop,k.id contract,k.subscriber_id subscriber,
       coalesce((select count(*) from subscribers s where s.tenant_id=u.tenant_id),0) tenant_size
       from users u join tenants t on t.id=u.tenant_id join lateral
       (select c.id,c.subscriber_id from contracts c where c.tenant_id=u.tenant_id
         and (u.email not like '%-pop@contrato.invalid' or c.pop_id is null or c.pop_id in(select pop_id from user_pops where user_id=u.id))
        order by hashtext(c.id::text) limit 40) k on true
       where u.active and u.role in ('admin','attendant','finance','noc') and u.mfa_enabled
       and u.email like '%@contrato.invalid' order by u.id,k.id'''
    rows=json.loads(query("select json_agg(r) from ("+fixture_query+")r"))
    fixtures=[]
    for i,row in enumerate(rows):
        fixtures.append(dict(subscriber=row['subscriber'],contract=row['contract'],token='contrato:'+row['uid'],
                             cookie=i%2==0,offset=0 if i%10<7 else 20*(i%min(50,max(1,row['tenant_size']//20)))))
    (LOCAL/'carga-fixtures.json').write_text(json.dumps(fixtures));os.chmod(LOCAL/'carga-fixtures.json',0o600)
    return {'subscribers':int(query('select count(*) from subscribers')),'contracts':int(query('select count(*) from contracts')),
            'tenants':int(query('select count(*) from tenants')),'fixtures':len(fixtures),'cookie_fraction':.5,
            'pop_fraction':sum(r['restricted_pop'] for r in rows)/len(rows),'modulos':True,
            'amostragem':'40 contratos por usuário; provedores têm o mesmo peso, população segue Zipf'}


def stop():
    subprocess.run(['docker','rm','-f',*NAMES],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)


def start(candidate):
    stop();env=go_env(DATABASE)
    cores=sorted(os.sched_getaffinity(0));api_cores=cores[30:34] if len(cores)>=38 else cores[-4:]
    for i,name in enumerate(NAMES):
        args=['docker','run','-d','--name',name,'--network','host','--security-opt','seccomp=unconfined',
              '--cpus','1','--cpuset-cpus',str(api_cores[i]),'--memory','1g','--memory-swap','1g',
              '-v',str(ROOT)+':/app:ro','-w','/app']
        config=dict(env,GOMAXPROCS='1',NEXO_GO_DB_POOL='10',NEXO_PANEL_RATE_PER_MIN='1200',
                    PORT=str(18100+i),NEXO_GO_ADDR='127.0.0.1:'+str(18100+i),NEXO_GO_INTERNAL_ADDR='127.0.0.1:'+str(19100+i),
                    NEXO_GO_PLAN_CACHE_MODE='auto' if candidate=='go-auto' else 'force_custom_plan')
        for k in ('DATABASE_URL_APP','DATABASE_URL_GO','NEXO_REQUIRE_ADMIN_MFA','NEXO_AGENT_MTLS','GOMAXPROCS',
                  'NEXO_GO_DB_POOL','NEXO_PANEL_RATE_PER_MIN','PORT','NEXO_GO_ADDR','NEXO_GO_INTERNAL_ADDR','NEXO_GO_PLAN_CACHE_MODE'):
            args+=['-e',k+'='+config[k]]
        args+=['node:22-alpine','node','--import','tsx','tests/contrato/fastify.mjs'] if candidate=='fastify' else ['alpine:3.22','/app/apps/api-go/bin/api-carga']
        command(args,stdout=subprocess.DEVNULL)
    for i in range(4):wait('http://127.0.0.1:'+str(18100+i if candidate=='fastify' else 19100+i),'/api/health' if candidate=='fastify' else '/healthz')


def cpu(name):
    pid=json.loads(command(['docker','inspect',name],capture_output=True).stdout)[0]['State']['Pid']
    # cgroup v2 and v1 are both supported on the laboratory host.
    for line in Path(f'/proc/{pid}/cgroup').read_text().splitlines():
        _,controllers,path=line.split(':',2)
        if controllers=='':
            values=dict(x.split() for x in (Path('/sys/fs/cgroup')/path.lstrip('/')/'cpu.stat').read_text().splitlines())
            return int(values['usage_usec'])/1e6
        if 'cpuacct' in controllers.split(','):
            return int((Path('/sys/fs/cgroup/cpu,cpuacct')/path.lstrip('/')/'cpuacct.usage').read_text())/1e9
    raise RuntimeError('cgroup de CPU não encontrado')


def metrics(candidate):
    totals={}
    if candidate=='fastify':return totals
    for i in range(4):
        with urllib.request.urlopen('http://127.0.0.1:'+str(19100+i)+'/metrics') as response:
            for line in response.read().decode().splitlines():
                if not line.startswith('#'):
                    key,value=line.rsplit(' ',1)
                    if key.startswith(('nexo_pool_acquire_seconds','nexo_auth_')):
                        totals[key]=totals.get(key,0)+float(value)
    return totals


def k6(duration):
    args=['docker','run','--rm','--user',str(os.getuid())+':'+str(os.getgid()),'--network','host','--cpus','4','--cpuset-cpus',','.join(map(str,sorted(os.sched_getaffinity(0))[34:38])),'--security-opt','seccomp=unconfined',
             '-v',str(ROOT/'tests/contrato')+':/lab','-e','DURATION='+str(duration)+'s','grafana/k6:1.8.2',
             'run','--quiet','/lab/carga.js']
    result=subprocess.run(args,stdout=subprocess.DEVNULL)
    if result.returncode not in (0,99):raise RuntimeError('gerador falhou: '+str(result.returncode))
    return json.loads((LOCAL/'carga-summary.json').read_text())


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--duration',type=int,default=30);args=parser.parse_args()
    LOCAL.mkdir(exist_ok=True,parents=True)
    go('build','-o','bin/api-carga','./cmd/api',env=dict(os.environ,CGO_ENABLED='0'))
    dataset=prepare();cores=sorted(os.sched_getaffinity(0))
    db_cores=cores[:30] if len(cores)>=38 else cores[:-4]
    command(['docker','update','--cpus',str(len(db_cores)),'--cpuset-cpus',','.join(map(str,db_cores)),DB_CONTAINER],stdout=subprocess.DEVNULL)
    dest=ROOT/'tests/contrato/relatorios'/('carga-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'));dest.mkdir()
    results=[];order=['fastify','go-custom','go-auto'];random.Random(20261016).shuffle(order)
    try:
        for candidate in order:
            start(candidate);warmup=k6(15)
            (dest/(candidate+'-warmup.json')).write_text(json.dumps(warmup,indent=2)+'\n')
            for rep in range(1,4):
                query('select pg_stat_statements_reset()')
                before=[cpu(n) for n in NAMES];db_before=cpu(DB_CONTAINER);m_before=metrics(candidate)
                begin=time.monotonic();summary=k6(args.duration);elapsed=time.monotonic()-begin
                api_cpu=sum(cpu(n)-b for n,b in zip(NAMES,before));db_cpu=cpu(DB_CONTAINER)-db_before;m_after=metrics(candidate)
                values=summary['metrics'];count=values['http_reqs']['values']['count'];delta={k:v-m_before.get(k,0) for k,v in m_after.items()}
                row={'candidate':candidate,'rep':rep,'requests':count,'elapsed_s':elapsed,
                     'api_cpu_ms_req':api_cpu/count*1000,'db_cpu_ms_req':db_cpu/count*1000,
                     'p95_ms':values['http_req_duration']['values']['p(95)'],'p99_ms':values['http_req_duration']['values']['p(99)'],
                     'dropped':values.get('dropped_iterations',{'values':{'count':0}})['values']['count'],
                     'failed_rate':values['http_req_failed']['values']['rate'],'metrics_delta':delta}
                row['valid']=row['dropped']==0 and row['failed_rate']==0
                row['cache_hit_ratio']=delta.get('nexo_auth_cache_hits_total',0)/max(1,delta.get('nexo_auth_cache_hits_total',0)+delta.get('nexo_auth_cache_misses_total',0)) if candidate!='fastify' else None
                row['pg_statement_time_ms_req']=float(query("select coalesce(sum(total_exec_time+total_plan_time),0) from pg_stat_statements where userid=(select oid from pg_roles where rolname="+ ("'nexo_app'" if candidate=='fastify' else "'nexo_go'")+") and toplevel"))/count
                results.append(row);(dest/f'{candidate}-{rep}.json').write_text(json.dumps(summary,indent=2)+'\n')
                (dest/'measurements.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(row),flush=True)
    finally:stop()
    groups={}
    for name in order:
        rows=[r for r in results if r['candidate']==name]
        groups[name]={metric:{'mean':statistics.mean(r[metric] for r in rows),'stdev':statistics.stdev(r[metric] for r in rows)}
                      for metric in ('api_cpu_ms_req','db_cpu_ms_req','p95_ms','p99_ms')}
    f,g=groups['fastify'],groups['go-custom']
    gate={'carga_valida':all(r['valid'] for r in results if r['candidate']!='go-auto'),
          'api_cpu':g['api_cpu_ms_req']['mean']<=f['api_cpu_ms_req']['mean'],
          'p99':g['p99_ms']['mean']<=f['p99_ms']['mean'],
          'db_cpu':g['db_cpu_ms_req']['mean']<=f['db_cpu_ms_req']['mean']+f['db_cpu_ms_req']['stdev']}
    sources={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT/'apps/api-go').rglob('*.go')}
    provenance={'commit':command(['git','rev-parse','HEAD'],capture_output=True).stdout.strip(),
                'go_binary_sha256':hashlib.sha256((ROOT/'apps/api-go/bin/api-carga').read_bytes()).hexdigest(),
                'go_sources_sha256':hashlib.sha256(json.dumps(sources,sort_keys=True).encode()).hexdigest(),
                'workload_sha256':hashlib.sha256((ROOT/'tests/contrato/carga.js').read_bytes()).hexdigest()}
    report={'dataset':dataset,'provenance':provenance,'method':{'rate':1000,'repetitions':3,'duration_s':args.duration,'warmup_s':15,'instances':4,'cpu_each':1,'pool_each':10,'mix':[45,40,15],
                                     'api_cores':cores[30:34] if len(cores)>=38 else cores[-4:],'db_cores':db_cores,'generator':'k6 constant-arrival-rate; acesso direto balanceado entre quatro portas','order':order,
                                     'dispersao':'desvio padrão amostral entre três repetições'},'summary':groups,'gate':gate,'passed':all(gate.values())}
    (dest/'summary.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps(report,ensure_ascii=False,indent=2))
    (dest/'summary.md').write_text('# Laboratório fase 1\n\n'+json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    return not report['passed']


if __name__=='__main__':raise SystemExit(main())
