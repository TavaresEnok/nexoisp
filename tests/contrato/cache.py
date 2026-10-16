#!/usr/bin/env python3
"""Invalidação real por transações do produto + notificações e reconexão."""
from datetime import datetime, timezone
import json
import time

from lib import ROOT, quote, records, request, sql

BASE='http://127.0.0.1:18082'
FASTIFY='http://127.0.0.1:18081'


def await_status(token,status,path='/api/subscribers?limit=1'):
    start=time.monotonic()
    while time.monotonic()-start<1:
        if request(BASE,path,token)['status']==status:return time.monotonic()-start
        time.sleep(.01)
    raise AssertionError('invalidação não observada em 1 s: '+str(status))


def main():
    tests=[]
    user=records("select * from users where email like '%-admin@contrato.invalid' order by id limit 1")[0]
    uid,tenant=user['id'],user['tenant_id'];token='contrato:'+uid
    operator=records("select * from users where role='saas_operator' and email='operator@contrato.invalid'")[0]
    op_token='contrato:'+operator['id']
    assert request(BASE,'/api/subscribers?limit=1',token)['status']==200
    # Alteração pelo Fastify real: suspensão e reativação, sem implementar escrita no Go.
    response=request(FASTIFY,'/api/tenants/'+tenant,op_token,method='PATCH',headers={'Content-Type':'application/json'},body=b'{"status":"suspended"}')
    assert response['status']==200, response['body']
    try:tests.append({'caso':'suspensão pelo Fastify','atraso_s':await_status(token,401)})
    finally:sql(f"update tenants set status='active' where id={quote(tenant)}")
    await_status(token,200)
    for label,change,restore,status in (
        ('usuário inativo',f"update users set active=false where id={quote(uid)}",f"update users set active=true where id={quote(uid)}",401),
        ('papel alterado',f"update users set role='finance' where id={quote(uid)}",f"update users set role='admin' where id={quote(uid)}",200),
        ('MFA desativado',f"update users set mfa_enabled=false where id={quote(uid)}",f"update users set mfa_enabled=true where id={quote(uid)}",403)):
        request(BASE,'/api/subscribers?limit=1',token);sql(change)
        try:tests.append({'caso':label,'atraso_s':await_status(token,status)})
        finally:sql(restore)
        await_status(token,200)
    # A revogação é feita pelo handler de logout original.
    response=request(FASTIFY,'/api/auth/logout',token,method='POST',headers={'Content-Type':'application/json'},body=b'{}')
    assert response['status']==200,response['body']
    try:tests.append({'caso':'logout pelo Fastify','atraso_s':await_status(token,401)})
    finally:sql(f"insert into sessions(user_id,token_hash,expires_at) values({quote(uid)},encode(digest({quote(token)},'sha256'),'hex'),now()+interval '12 hours')")
    await_status(token,200)
    # A escuta é uma conexão dedicada, identificada por application_name e estado LISTEN.
    pid=sql("select pid from pg_stat_activity where application_name='nexo-go' and query='listen nexo_auth' order by backend_start limit 1")
    assert pid,'conexão LISTEN não encontrada'
    sql('select pg_terminate_backend('+pid+')')
    tests.append({'caso':'queda LISTEN sem interrupção da leitura','atraso_s':await_status(token,200)})
    # A expiração ocorre dentro do TTL de 5 segundos.
    short='expira:'+uid
    sql(f"insert into sessions(user_id,token_hash,expires_at) values({quote(uid)},encode(digest({quote(short)},'sha256'),'hex'),now()+interval '0.3 second')")
    assert request(BASE,'/api/subscribers?limit=1',short)['status']==200
    time.sleep(.35);tests.append({'caso':'expires_at dentro do TTL','atraso_s':await_status(short,401)})
    sql(f"delete from sessions where token_hash=encode(digest({quote(short)},'sha256'),'hex')")
    pop_user=records(f"select * from users where tenant_id={quote(tenant)} and email like '%-pop@contrato.invalid'")[0]
    pop=sql(f"select pop_id from user_pops where user_id={quote(pop_user['id'])}")
    outside=sql(f"select id from contracts where tenant_id={quote(tenant)} and pop_id is not null and pop_id<>{quote(pop)} limit 1")
    pop_token='contrato:'+pop_user['id'];pop_path='/api/contracts/'+outside
    assert request(BASE,pop_path,pop_token)['status']==404
    response=request(FASTIFY,'/api/users/'+pop_user['id']+'/pops',token,method='PUT',headers={'Content-Type':'application/json'},body=b'{"pop_ids":[]}')
    assert response['status']==200,response['body']
    try:tests.append({'caso':'POP removido pelo Fastify','atraso_s':await_status(pop_token,200,pop_path)})
    finally:sql(f"insert into user_pops(tenant_id,user_id,pop_id) values({quote(tenant)},{quote(pop_user['id'])},{quote(pop)})")
    await_status(pop_token,404,pop_path)
    assert request(BASE,'/api/subscribers?limit=1',op_token)['status']==403
    response=request(FASTIFY,'/api/support/enter',op_token,method='POST',headers={'Content-Type':'application/json'},body=json.dumps({'tenant_id':tenant,'reason':'teste de invalidação do suporte'}).encode())
    assert response['status']==200,response['body']
    try:
        tests.append({'caso':'entrada no suporte pelo Fastify','atraso_s':await_status(op_token,200)})
        before=int(sql('select coalesce(max(id),0) from audit_events'))
        request(BASE,'/api/subscribers?format=csv&limit=1',op_token)
        events=records(f"select detail from audit_events where id>{before} and action='export.csv'")
        assert len(events)==1 and events[0]['detail'].get('support_access') is True
        tests.append({'caso':'suporte auditado na exportação','atraso_s':0})
    finally:
        response=request(FASTIFY,'/api/support/exit',op_token,method='POST',headers={'Content-Type':'application/json'},body=b'{}')
        assert response['status']==200,response['body']
    tests.append({'caso':'saída do suporte pelo Fastify','atraso_s':await_status(op_token,403)})
    path=ROOT/'tests/contrato/relatorios'/('cache-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.json')
    path.write_text(json.dumps({'casos':len(tests),'aprovados':len(tests),'resultados':tests},ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'cache':len(tests),'aprovados':len(tests)}))


if __name__=='__main__':main()
