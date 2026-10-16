#!/usr/bin/env python3
"""Leituras SQL revisadas: comparação, validação e sentinelas multi-provedor."""
import json
import sys
import time
from datetime import datetime,timezone

from lib import ROOT,records,request,sql,quote
from leituras import check,RESULTS,assert_equal,ids

TABLES={
 '/api/addons':'addon_products','/api/anatel/municipalities':'municipalities','/api/pops':'pops',
 '/api/notice-channels':'notice_channels','/api/notice-rules':'notice_rules','/api/companies':'companies',
 '/api/tags':'tags','/api/maintenance-notices':'maintenance_notices','/api/staff':'users',
 '/api/stock/items':'stock_items','/api/ftth/boxes':'ftth_boxes','/api/sla-policies':'sla_policies',
 '/api/users':'users','/api/import/batches':'import_batches','/api/api-tokens':'api_tokens',
 '/api/webhook-endpoints':'webhook_endpoints','/api/ipam/pools':'ip_pools',
 '/api/olt/discoveries':'onu_discoveries','/api/onus':'onus','/api/install-kits':'install_kits','/api/commission-rules':'commission_rules'
}


def main():
    specs=json.loads((ROOT/'apps/api-go/internal/modules/leitura/consultas.json').read_text())
    tenants=records("select t.id,t.modules,(select count(*) from subscribers where tenant_id=t.id) n from tenants t where slug like 'bench-%' order by n desc")
    tenants=[tenants[0],tenants[len(tenants)//2],tenants[-1]]
    try:
        for t in tenants:
            tenant=t['id'];sql('update tenants set modules=\'{crm,field,ftth,ipam,olt,noc,notices,messages,api}\' where id='+quote(tenant))
            users=records("select id,name,role from users where tenant_id="+quote(tenant)+" and email like '%@contrato.invalid' order by name")
            admin=next(u for u in users if u['name']=='admin')
            for _ in range(100):
                if len(request('http://127.0.0.1:18082','/api/me','contrato:'+admin['id'])['json']['modules'])==9:break
                time.sleep(.02)
            subscriber=records('select id from subscribers where tenant_id='+quote(tenant)+' order by id limit 1')[0]['id']
            contract=records('select id from contracts where subscriber_id='+quote(subscriber)+' order by id limit 1')[0]['id']
            for spec in specs:
                path=spec['path'];value=contract if '/contracts/' in path else subscriber if '/subscribers/' in path else admin['id'] if '/users/' in path else '00000000-0000-0000-0000-000000000000'
                path=path.replace(':id',value)
                for u in users:
                    check(u['name'],path,'contrato:'+u['id'])
                token='contrato:'+admin['id']
                check('cookie',path,token,True)
                check('HEAD',path,token,method='HEAD')
                check('sem sessão',path,status=401)
                if ':id' in spec['path']:check('UUID inválido',spec['path'].replace(':id','invalid'),token,status=400)
                table=TABLES.get(spec['path'])
                if table and table!='municipalities':
                    exists=records("select to_regclass("+quote(table)+")::text t")[0]['t']
                    assert exists,'oráculo com tabela inexistente: '+table
                    expected=ids(records('select id from '+table+' where tenant_id='+quote(tenant)))
                    check('sentinela provedor',path,token,oracle=lambda rows:assert_equal(ids(rows)-expected,set()))
                if spec['path']=='/api/stock/items':check('CSV de estoque',path+'?format=csv',token)
    finally:
        for t in tenants:sql('update tenants set modules='+quote('{'+','.join(t['modules'])+'}')+' where id='+quote(t['id']))
    report={'fase':3,'rotas':len(specs),'total':len(RESULTS),'aprovados':sum(r['ok'] for r in RESULTS),'casos':RESULTS}
    target=ROOT/'tests/contrato/relatorios'/('consultas-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.json');target.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k!='casos'}));return 0 if report['total']==report['aprovados'] else 1

if __name__=='__main__':sys.exit(main())
