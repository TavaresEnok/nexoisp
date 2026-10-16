#!/usr/bin/env python3
"""Leituras compostas: estados, filhos, auditoria, evidência e isolamento."""
import json
import sys
import time
from datetime import datetime,timezone
from lib import ROOT,records,request,sql,quote
from leituras import check,RESULTS,assert_equal,ids


def main():
    specs=json.loads((ROOT/'apps/api-go/internal/modules/leitura/grupos.json').read_text())
    specs += [{'path':p} for p in ['/api/integrations/catalog','/api/acs/status','/api/finance/settings','/api/invoices/:id/due','/api/contracts/:id/trust-release','/api/noc/settings']]
    tenants=records("select t.id,t.modules,(select count(*) from subscribers where tenant_id=t.id) n from tenants t where slug like 'bench-%' order by n desc")
    tenants=[tenants[0],tenants[len(tenants)//2],tenants[-1]]
    try:
        for t in tenants:
            tenant=t['id'];sql('update tenants set modules=\'{crm,field,ftth,ipam,olt,noc,notices,messages,api}\' where id='+quote(tenant))
            users=records("select id,name from users where tenant_id="+quote(tenant)+" and email like '%@contrato.invalid' order by name")
            admin=next(u for u in users if u['name']=='admin');token='contrato:'+admin['id']
            for _ in range(100):
                if len(request('http://127.0.0.1:18082','/api/me',token)['json']['modules'])==9:break
                time.sleep(.02)
            for spec in specs:
                path=spec['path'];id='00000000-0000-0000-0000-000000000000'
                table=next((table for prefix,table in [('/api/contracts/','contracts'),('/api/leads/','leads'),('/api/tickets/','tickets'),('/api/work-orders/','work_orders'),('/api/ftth/boxes/','ftth_boxes'),('/api/invoices/','invoices'),('/api/acceptances/','acceptances')] if path.startswith(prefix)),None)
                if table:
                    rows=records('select id from '+table+' where tenant_id='+quote(tenant)+' order by id limit 1')
                    if rows:id=rows[0]['id']
                actual=path.replace(':id',id)
                for u in users:check(u['name'],actual,'contrato:'+u['id'])
                check('cookie',actual,token,True)
                check('HEAD',actual,token,method='HEAD')
                check('sem sessão',actual,status=401)
                if ':id' in path:
                    check('UUID inválido',path.replace(':id','bad'),token,status=400)
                    check('ausente',path.replace(':id','00000000-0000-0000-0000-000000000000'),token)
                    other=records('select id from '+table+' where tenant_id<>'+quote(tenant)+' order by id limit 1')
                    if other:check('outro provedor',path.replace(':id',other[0]['id']),token)
                if path=='/api/tenants':
                    operator=records("select id from users where email='operator@contrato.invalid'")[0]['id']
                    check('operador','/api/tenants','contrato:'+operator,status=200,oracle=lambda r:assert_equal(ids(r),ids(records('select id from tenants'))))
                if path=='/api/tickets/:id' and id!='00000000-0000-0000-0000-000000000000':
                    expected=records('select count(*)::int n from ticket_messages where ticket_id='+quote(id))[0]['n']
                    check('mensagens da equipe',actual,token,status=200,oracle=lambda r:assert_equal(len(r['thread']),expected))
    finally:
        for t in tenants:sql('update tenants set modules='+quote('{'+','.join(t['modules'])+'}')+' where id='+quote(t['id']))
    report={'fase':3,'rotas':len(specs),'total':len(RESULTS),'aprovados':sum(r['ok'] for r in RESULTS),'casos':RESULTS}
    (ROOT/'tests/contrato/relatorios'/('grupos-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k!='casos'}));return 0 if report['aprovados']==report['total'] else 1

if __name__=='__main__':sys.exit(main())
