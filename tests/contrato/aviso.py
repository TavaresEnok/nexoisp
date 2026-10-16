#!/usr/bin/env python3
"""Página pública: bytes HTML, escape, cabeçalhos, inexistência e HEAD."""
import json
from lib import ROOT,records,sql,quote
from leituras import check,RESULTS


def main():
    tenant=records("select id,slug from tenants where slug like 'bench-%' order by id limit 1")[0]
    prior=records('select notice_page from tenant_settings where tenant_id='+quote(tenant['id']))
    page={'title':'Bloqueio <script> & "aspas" \'','blocked_text':'Linha um\nLinha dois <b>','reduced_text':'Reduzida & sem HTML','show_portal_link':True,'whatsapp':'5581999990000','phone':'(81) 99999-0000'}
    try:
        sql('insert into tenant_settings(tenant_id,notice_page) values('+quote(tenant['id'])+','+quote(json.dumps(page))+') on conflict(tenant_id) do update set notice_page=excluded.notice_page')
        for path in ['/aviso/'+tenant['slug'],'/aviso/'+tenant['slug']+'?m=reduzida','/aviso/'+tenant['slug']+'?m=reduzida&m=x','/aviso/nao-existe','/aviso/a','/aviso/inv%C3%A1lido']:
            check('HTML público',path)
            check('HTML HEAD',path,method='HEAD')
    finally:
        if prior:sql('update tenant_settings set notice_page='+('NULL' if prior[0]['notice_page'] is None else quote(json.dumps(prior[0]['notice_page']))+'::jsonb')+' where tenant_id='+quote(tenant['id']))
        else:sql('delete from tenant_settings where tenant_id='+quote(tenant['id']))
    report={'casos':len(RESULTS),'aprovados':sum(r['ok'] for r in RESULTS),'casos_detalhados':RESULTS}
    (ROOT/'tests/contrato/relatorios/aviso.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k!='casos_detalhados'}));assert report['casos']==report['aprovados']

if __name__=='__main__':main()
