#!/usr/bin/env python3
"""Últimas leituras: validação, filtros, cálculos e dados privados por papel."""
import copy,json,sys,time,math
from datetime import datetime,timezone
from contrato import same
from urllib.parse import urlencode
from lib import ROOT,records,request,sql,quote
from leituras import check as contract_check,RESULTS,assert_equal,ids
ZERO='00000000-0000-0000-0000-000000000000'


def availability_equal(a,b):
    if not isinstance(a,dict) or not isinstance(b,dict) or not a.get('total') or not b.get('total'):return same(a,b)
    # Calls use separate PostgreSQL transactions. Only elapsed seconds can differ.
    a,b=copy.deepcopy(a),copy.deepcopy(b)
    for data in (a,b):
        total=data['total'];w=total['window_seconds'];online=total['online_seconds']
        assert total['availability_pct']==math.floor(min(100,online/w*1000)+.5)/10
    if abs(a['total']['window_seconds']-b['total']['window_seconds'])>2:return False
    for left,right in zip(a['days'],b['days']):
        if left['day']!=right['day']:return False
        if abs(left['offline_seconds']-right['offline_seconds'])>2:return False
        if left['online_seconds']==0 and right['online_seconds']==0:
            if left['availability_pct'] not in (0,None) or right['availability_pct'] not in (0,None):return False
        elif left['availability_pct']!=right['availability_pct']:return False
        left['offline_seconds']=right['offline_seconds']
    a['total']['window_seconds']=b['total']['window_seconds']
    a['total']['availability_pct']=b['total']['availability_pct']
    return same(a,b)


def check(name,path,*args,**kwargs):
    if '/availability' in path:kwargs['compare']=availability_equal
    return contract_check(name,path,*args,**kwargs)


def main():
    specs=[s for s in json.loads((ROOT/'apps/api-go/internal/modules/leitura/dinamicas.json').read_text()) if s['path'].startswith('/api/')]
    sql((ROOT/'tests/contrato/dados/dinamicas.sql').read_text())
    tenants=records("select t.id,t.modules,(select count(*) from subscribers where tenant_id=t.id)n from tenants t where slug like 'bench-%' order by n desc")
    tenants=[tenants[0],tenants[len(tenants)//2],tenants[-1]]
    try:
        for t in tenants:
            tenant=t['id'];sql('update tenants set modules=\'{crm,field,ftth,ipam,olt,noc,notices,messages,api}\' where id='+quote(tenant))
            users=records("select id,name from users where tenant_id="+quote(tenant)+" and email like '%@contrato.invalid' order by name")
            admin=next(u for u in users if u['name']=='admin');token='contrato:'+admin['id']
            for _ in range(100):
                if len(request('http://127.0.0.1:18082','/api/me',token)['json']['modules'])==9:break
                time.sleep(.02)
            defaults={'/api/search':'?q=Contrato','/api/crm/report':'?from=2020-01-01&to=2030-01-01','/api/agenda':'?date=2026-10-16','/api/agenda/free':'?date=2026-10-16&assignee_id='+admin['id'],'/api/map/points':'?south=-90&north=90&west=-180&east=180','/api/cgnat/plans/:id/lookup':'?private_ip=100.64.0.1'}
            for spec in specs:
                path=spec['path'];table=next((table for prefix,table in [('/api/contracts/','contracts'),('/api/subscribers/','subscribers'),('/api/cgnat/plans/','cgnat_plans'),('/api/radius/devices/','devices')] if path.startswith(prefix)),None)
                rows=records('select id from '+table+' where tenant_id='+quote(tenant)+' order by id limit 1') if table else []
                id=rows[0]['id'] if rows else ZERO
                actual=path.replace(':id',id)+defaults.get(path,'')
                for u in users:check(u['name'],actual,'contrato:'+u['id'])
                check('cookie',actual,token,True)
                check('HEAD',actual,token,method='HEAD')
                check('sem sessão',actual,status=401)
                if ':id' in path:
                    check('UUID inválido',path.replace(':id','bad')+defaults.get(path,''),token,status=400)
                    check('ausente',path.replace(':id',ZERO)+defaults.get(path,''),token)
                    other=records('select id from '+table+' where tenant_id<>'+quote(tenant)+' order by id limit 1')
                    if other:check('outro provedor',path.replace(':id',other[0]['id'])+defaults.get(path,''),token)
            invalids={
              '/api/search':['','?q=a','?q=a&q=b','?q='+('x'*101)],
              '/api/crm/report':['','?from=bad&to=bad','?from=2026-01-02&to=2026-01-01'],
              '/api/agenda':['','?date=x&days=0&assignee_id=bad','?date=2026-01-01&days=1.5'],
              '/api/agenda/free':['','?date=x&assignee_id=bad&minutes=0&from_hour=24&to_hour=0','?date=2026-01-01&assignee_id='+admin['id']+'&from_hour=18&to_hour=8'],
              '/api/map/points':['','?south=x&north=91&west=-181&east=181','?south=0&south=1&north=0&west=0&east=0&status=bad'],
              '/api/invoices':['?limit=0&offset=-1','?status=bad&contract_id=bad&company_id=bad','?q=a&q=b&format=x&format=y'],
              '/api/reports/sla':['?from=bad&to=bad'],
            }
            for path,suffixes in invalids.items():
                for suffix in suffixes:check('validação',path+suffix,token,status=400)
            # Cada fabricante nas três modalidades devolve comandos completos, sem segredos persistidos.
            for nas in records("select d.id,d.vendor,d.name from devices d join radius_nas n on n.device_id=d.id where d.tenant_id="+quote(tenant)+" and d.name like 'fixture %' order by d.id"):
                def nas_oracle(data,nas=nas):
                    setup=data['setup'];assert_equal(setup['vendor'],nas['vendor'])
                    assert_equal(setup['connection'],nas['name'].split()[-1])
                    assert '<SEGREDO>' in setup['commands']
                    assert 'segredo-descartavel-local' not in json.dumps(data)
                check('instruções '+nas['name'],'/api/radius/devices/'+nas['id']+'/setup',token,status=200,oracle=nas_oracle)
            plan=records('select id from cgnat_plans where tenant_id='+quote(tenant)+' order by id limit 1')[0]['id']
            base='/api/cgnat/plans/'+plan
            for suffix in ['/map?limit=2&offset=62','/map?offset=255','/map?offset=256','/map?offset=1e20','/map?limit=0&offset=-1','/map?limit=1.5&offset=x','/lookup','/lookup?private_ip=999.1.1.1','/lookup?private_ip=100.064.000.001','/lookup?private_ip=100.65.0.0']:
                check('CGNAT borda',base+suffix,token)
            expected={'private_ip':'100.64.0.63','public_ip':'198.51.100.1','port_start':1024,'port_end':2047}
            check('mapeamento independente',base+'/lookup?private_ip=100.64.0.63',token,status=200,oracle=lambda data:assert_equal(data,expected))
            check('capacidade independente',base+'/map?limit=1&offset=63',token,status=200,oracle=lambda data:assert_equal((data['total'],data['rows']), (256,[expected])))
            contract=records('select id from contracts where subscriber_id='+quote(records('select id from subscribers where tenant_id='+quote(tenant)+' order by id limit 1')[0]['id'])+' order by id limit 1')[0]['id']
            def availability_oracle(data):
                assert_equal(data['total']['online_seconds'],7200)
                assert_equal(sum(d['sessions'] for d in data['days']),1)
                yesterday=datetime.fromisoformat(records("select to_char((now() at time zone "+quote(data['timezone'])+")::date-1,'YYYY-MM-DD') d")[0]['d']).date().toordinal()
                prev=next(d for d in data['days'] if datetime.fromisoformat(d['day']).date().toordinal()==yesterday)
                assert_equal((prev['online_seconds'],prev['offline_seconds'],prev['availability_pct']),(7200,79200,8.3))
            check('disponibilidade independente','/api/contracts/'+contract+'/availability',token,status=200,oracle=availability_oracle)
            for suffix in ['?status=overdue&limit=1','?limit=2&offset=1','?status=paid','?format=csv','?q=fixture']:
                check('faturas filtradas','/api/invoices'+suffix,token,status=200)
            for layers in ['contracts','boxes','pops','contracts,boxes','none','']:
                check('camadas do mapa','/api/map/points?'+urlencode({'south':-90,'north':90,'west':-180,'east':180,'layers':layers}),token,status=200)
            # Dois serviços começam às 09:00 e 09:30 locais: só o segundo conflita.
            def agenda_oracle(data):
                own=next(g for g in data['technicians'] if g['assignee_id']==admin['id'])
                assert_equal([x['conflict'] for x in own['items']],[False,True])
            check('sobreposição independente','/api/agenda?date=2026-10-16',token,status=200,oracle=agenda_oracle)
            def free_oracle(data):
                assert_equal(data['free'],[{'from':'2026-10-16T11:00:00.000Z','to':'2026-10-16T12:00:00.000Z'},{'from':'2026-10-16T13:30:00.000Z','to':'2026-10-16T21:00:00.000Z'}])
            check('intervalos independentes','/api/agenda/free?date=2026-10-16&assignee_id='+admin['id'],token,status=200,oracle=free_oracle)
            sub=records('select id,name,document from subscribers where tenant_id='+quote(tenant)+' order by id limit 1')[0]
            for term in [sub['name'],sub['document'],'%',"'",'192.0.2.1','a_b','AA:BB:CC:DD:EE:FF','9000001','0000000001']:
                if len(term)>=2:check('busca '+term,'/api/search?'+urlencode({'q':term}),token)
            for path in ['/api/subscribers/'+sub['id']+'/timeline?limit=9','/api/subscribers/'+sub['id']+'/timeline?limit=501','/api/subscribers/'+sub['id']+'/timeline?limit=x']:
                check('validação limite',path,token,status=400)
    finally:
        for t in tenants:sql('update tenants set modules='+quote('{'+','.join(t['modules'])+'}')+' where id='+quote(t['id']))
    report={'fase':3,'rotas':len(specs),'total':len(RESULTS),'aprovados':sum(r['ok'] for r in RESULTS),'casos':RESULTS}
    (ROOT/'tests/contrato/relatorios'/('dinamicas-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k!='casos'}));return 0 if report['aprovados']==report['total'] else 1
if __name__=='__main__':sys.exit(main())
