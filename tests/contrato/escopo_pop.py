#!/usr/bin/env python3
"""Compara RLS e função otimizadas com SQL independente, incluindo INSERT RETURNING."""
import json
from lib import ROOT,records,sql,quote


def main():
    checks=0
    tenants=records("select id from tenants where slug like 'bench-%' order by id limit 3")
    for t in tenants:
        tenant=t['id'];pops=records('select id from pops where tenant_id='+quote(tenant)+' order by id')
        subscribers=records('select id from subscribers where tenant_id='+quote(tenant)+' order by id limit 2')
        for pop in ['',pops[0]['id'],'00000000-0000-0000-0000-000000000000']:
            for sid in ['',subscribers[0]['id']]:
                config=f"select set_config('app.tenant_id',{quote(tenant)},true),set_config('app.pop_ids',{quote(pop)},true),set_config('app.subscriber_id',{quote(sid)},true);"
                expected=json.loads(sql('begin;'+config+f"select coalesce(json_agg(id order by id),'[]') from subscribers where tenant_id={quote(tenant)} and ({quote(sid)}='' or id::text={quote(sid)}) and ({quote(pop)}='' or not exists(select 1 from contracts k where k.tenant_id={quote(tenant)} and k.subscriber_id=subscribers.id) or exists(select 1 from contracts k where k.tenant_id={quote(tenant)} and k.subscriber_id=subscribers.id and (k.pop_id is null or k.pop_id=any(app_pops()))));rollback;").splitlines()[-1])
                actual=json.loads(sql('begin;set local role nexo_go;'+config+"select coalesce(json_agg(id order by id),'[]') from subscribers;rollback;").splitlines()[-1])
                assert actual==expected,(tenant,pop,sid);checks+=1
                # Mesma função pública, com o predicado original mesmo fora do RLS.
                mismatches=sql('begin;'+config+"select count(*) from subscribers s where subscriber_in_pops(s.id) is distinct from (not exists(select 1 from contracts k where k.subscriber_id=s.id and k.tenant_id=app_tenant()) or exists(select 1 from contracts k where k.subscriber_id=s.id and k.tenant_id=app_tenant() and (k.pop_id is null or k.pop_id=any(app_pops()))));rollback;").splitlines()[-1]
                assert mismatches=='0';checks+=1
        pop=pops[0]['id']
        # O cadastro real usa RETURNING; uma política baseada só em IDs pré-existentes falharia aqui.
        config=f"select set_config('app.tenant_id',{quote(tenant)},true),set_config('app.pop_ids',{quote(pop)},true),set_config('app.subscriber_id','',true);"
        result=sql('begin;set local role nexo_go;'+config+f"insert into subscribers(id,tenant_id,name) values(md5('pop-policy-new')::uuid,{quote(tenant)},'Novo assinante restrito') returning id; update subscribers set phone='1234' where id=md5('pop-policy-new')::uuid returning id; select count(*) from subscribers where id=md5('pop-policy-new')::uuid and phone='1234';rollback;")
        assert result.splitlines()[-1]=='1';checks+=1
    report={'casos':checks,'aprovados':checks,'predicado_anterior_igual':True,'funcao_predicado_original_igual':True,'insert_update_com_pop':True}
    (ROOT/'tests/contrato/relatorios/escopo-pop.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))

if __name__=='__main__':main()
