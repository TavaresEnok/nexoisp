#!/usr/bin/env python3
"""Ensaio concentrado das escritas: banco descartável e nenhuma saída externa."""
import concurrent.futures
import json
import uuid
from lib import ROOT, records, request, sql, quote

GO = 'http://127.0.0.1:18082'
NODE = 'http://127.0.0.1:18081'
checks = []

def check(name, condition, detail=None):
    if not condition:
        raise AssertionError(name + ': ' + str(detail))
    checks.append(name)

def call(base, path, token, body=None, headers=None, method=None):
    headers = dict(headers or {})
    if body is not None:
        headers['content-type'] = 'application/json'
    return request(base, path, token=token, method=method or ('POST' if body is not None else 'GET'),
                   headers=headers, body=json.dumps(body, ensure_ascii=False).encode() if body is not None else None)

def main():
    u = records("select id,tenant_id from users where email like '%-admin@contrato.invalid' order by id limit 1")[0]
    tenant = quote(u['tenant_id'])
    token = 'contrato:' + u['id']
    sql('update sessions set expires_at=now()+interval \'12 hours\' where user_id='+quote(u['id']))
    modules = records('select modules from tenants where id='+tenant)[0]['modules']
    try:
        sql("update tenants set modules=array['api','noc','crm','field','messages','olt','ipam','ftth','notices']::text[] where id="+tenant)
        sub = records('select id from subscribers where tenant_id='+tenant+' order by id limit 1')[0]['id']
        contract = records('select id from contracts where tenant_id='+tenant+' order by id limit 1')[0]['id']
        r = call(GO, '/api/api-tokens', token, {'name':'Consolidação Go', 'scopes':['subscribers:read','tickets:write','work_orders:write','work_orders:read'], 'rate_limit_per_min':60})
        check('token de aplicação', r['status']==200, r['json'])
        app = r['json']['token']
        r = call(GO, '/public/v1/subscribers?limit=1', app)
        check('API pública com limite e escopo', r['status']==200 and r['headers'].get('x-ratelimit-limit')=='60' and len(r['json'])==1, r)
        idem = 'go-'+str(uuid.uuid4())
        body = {'subscriber_id':sub,'subject':'Consolidação de atendimento','category':'technical','body':'Solicitação sintética de laboratório'}
        r = call(GO, '/public/v1/tickets', app, body, {'Idempotency-Key':idem})
        check('abertura por token sem usuário', r['status']==201, r['json'])
        replay = call(NODE, '/public/v1/tickets', app, body, {'Idempotency-Key':idem})
        check('idempotência misturada Go/Fastify', replay['status']==201 and replay['json']==r['json'] and replay['headers'].get('idempotent-replay')=='true', replay)
        n = records("select count(*)::int as n from audit_events where actor_type='api' and entity_id="+quote(r['json']['id']))[0]['n']
        check('auditoria da API sem duplicação', n==1, n)
        wo = call(GO, '/public/v1/work-orders', app, {'kind':'repair','subscriber_id':sub,'description':'OS sintética'})
        check('OS por token sem usuário', wo['status']==201, wo['json'])
        wo_id = wo['json']['id']
        state = call(GO, '/api/work-orders/'+wo_id+'/status', token, {'status':'analysis'})
        check('transição de OS', state['status']==200 and state['json']['status']=='analysis', state['json'])
        noc = call(GO, '/api/noc/overview', token)
        check('NOC e sweep', noc['status']==200 and 'counters' in noc['json'], noc['json'])
        diag = call(GO, '/api/contracts/'+contract+'/diagnosis', token)
        check('diagnóstico do contrato', diag['status']==200 and 'findings' in diag['json'], diag['json'])
        source = 'go-'+uuid.uuid4().hex[:12]
        csv = 'id_externo;nome;plano;vencimento_dia\n1;Assinante sintético;;\n1;Repetido;;\n'
        b = {'kind':'subscribers','source':source,'csv':csv}
        previews = [call(base,'/api/import/preview',token,b) for base in [GO,NODE]]
        for p in previews:
            check('prévia CSV',p['status']==200 and p['json']['totals']['created']==1 and p['json']['totals']['error']==1,p['json'])
        check('totais CSV iguais nas duas stacks',previews[0]['json']['totals']==previews[1]['json']['totals'])
        check('prévia CSV desfaz escrita',not records('select id from subscribers where external_source='+quote(source)))
        applied = call(GO,'/api/import/apply',token,b)
        check('aplicação CSV com savepoint por linha',applied['status']==200 and applied['json']['applied'],applied['json'])
        again = call(GO,'/api/import/apply',token,b)
        check('reimportação sem duplicar cadastro',again['status']==200 and again['json']['totals']['unchanged']==1,again['json'])
        invoice = call(GO,'/api/invoices',token,{'contract_id':contract,'description':'Concorrência sintética','amount_cents':3500,'due_date':'2026-10-20'})
        check('fatura manual',invoice['status']==200,invoice['json'])
        invoice_id = invoice['json']['id']
        def pay(base):
            return call(base,'/api/invoices/'+invoice_id+'/manual-payment',token,{'amount_cents':3500,'paid_at':'2026-10-16','note':'Consolidação concorrente'})
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            payments=list(pool.map(pay,[GO,NODE]))
        check('baixa concorrente entre stacks',sorted(p['status'] for p in payments)==[200,400],payments)
        paid=records('select id,amount_cents from payments where invoice_id='+quote(invoice_id))
        check('invariante: um pagamento na fatura',len(paid)==1 and paid[0]['amount_cents']==3500,paid)
        reverse=call(GO,'/api/invoices/'+invoice_id+'/payments/'+paid[0]['id']+'/reverse',token,{'reason':'Estorno sintético da consolidação'})
        check('estorno e saldo reaberto',reverse['status']==200 and reverse['json']=={'status':'open','paid_cents':0},reverse['json'])
        duplicate=call(NODE,'/api/invoices/'+invoice_id+'/payments/'+paid[0]['id']+'/reverse',token,{'reason':'Estorno sintético repetido'})
        check('estorno repetido entre stacks',duplicate['status']==409,duplicate['json'])
    finally:
        sql('update tenants set modules=array['+','.join(quote(v) for v in modules)+']::text[] where id='+tenant)
    report={'checks':checks,'passed':len(checks),'scope':'laboratório descartável; validação concentrada, sem carga nem canário operacional'}
    target=ROOT/'tests/contrato/relatorios/consolidacao.json'
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(str(len(checks))+' verificações de consolidação passaram')

if __name__=='__main__':main()
