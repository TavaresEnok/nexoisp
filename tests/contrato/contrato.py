#!/usr/bin/env python3
"""Contrato HTTP diferencial + oráculo independente com filtros explícitos no banco."""
import argparse
from datetime import datetime, timezone
import json
import os
import re
from pathlib import Path
import sys
import time
from urllib.parse import urlencode, parse_qs

from lib import ROOT, records, request, sql, quote

HEADERS = ('content-type', 'x-total-count', 'retry-after', 'content-disposition', 'cache-control',
           'set-cookie', 'x-content-type-options', 'x-frame-options', 'referrer-policy',
           'permissions-policy', 'strict-transport-security', 'content-security-policy', 'link')


def normalize(value, field=None):
    if isinstance(value, dict):
        return {k: normalize(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [normalize(v) for v in value]
    if value is not None and field in ('latitude', 'longitude'):
        return f'{value:.6f}'
    if isinstance(value, str) and field in ('created_at', 'updated_at', 'at', 'anonymized_at', 'credit_restricted_at'):
        dt = datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc)
        return dt.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    return value


def same(a, b):
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    if type(a) != type(b) and not (type(a) in (int, float) and type(b) in (int, float)):
        return False
    return a == b


def visible_contract(scope, alias='c'):
    where = alias + '.tenant_id=' + quote(scope['tenant'])
    if scope.get('pop'):
        where += f' and ({alias}.pop_id is null or {alias}.pop_id={quote(scope["pop"])})'
    return where


def visible_subscriber(scope):
    where = 's.tenant_id=' + quote(scope['tenant'])
    if scope.get('pop'):
        where += f' and (not exists(select 1 from contracts allc where allc.subscriber_id=s.id) or exists(select 1 from contracts c where c.subscriber_id=s.id and {visible_contract(scope)}))'
    return where


def contracts(scope, extra):
    query = f'''select c.*, s.name subscriber_name,s.document subscriber_document,
        p.id plan_id,p.name plan_name,pv.version plan_version,pv.price_cents,pv.down_kbps,pv.up_kbps,pv.profile_name,
        coalesce((select json_agg(x order by x.name) from (select t.id,t.name from tags t join contract_tags ct on ct.tag_id=t.id where ct.contract_id=c.id) x),'[]') tags
        from contracts c join subscribers s on c.subscriber_id=s.id
        join plan_versions pv on c.plan_version_id=pv.id join plans p on pv.plan_id=p.id
        where {visible_contract(scope)} and {extra} order by c.created_at desc'''
    return normalize(records(query))


def expected(scope, path):
    route, _, query = path.partition('?')
    if route == '/api/subscribers':
        q = parse_qs(query, keep_blank_values=True)
        where = visible_subscriber(scope)
        text = q.get('q', [''])[0].strip()
        digits = ''.join(x for x in text if '0' <= x <= '9')
        if text:
            pattern = quote('%' + text + '%')
            where += f' and (s.name ilike {pattern} or s.email ilike {pattern}'
            if digits:
                pattern = quote('%' + digits + '%')
                where += f' or s.document like {pattern} or s.phone like {pattern}'
            where += ')'
        if q.get('status'):
            where += ' and s.status=' + quote(q['status'][0])
        cap = 5000 if q.get('format') == ['csv'] else 500
        raw_limit = str(q.get('limit', [cap])[0])
        limit = min(int(raw_limit, 0) if raw_limit.lower().startswith(('0x','0b','0o')) else int(float(raw_limit)), cap)
        offset = int(q.get('offset', [0])[0])
        total = int(sql(f'select count(*) from subscribers s where {where}'))
        rows = records(f'''select s.*,(select count(*) from contracts c where c.subscriber_id=s.id and c.status='active' and {visible_contract(scope)}) active_contracts
            from subscribers s where {where} order by s.name,s.id limit {limit} offset {offset}''')
        return 200, normalize(rows), str(total)
    resource = route.rsplit('/', 1)[1]
    if '/subscribers/' in route:
        rows = records(f'select s.* from subscribers s where {visible_subscriber(scope)} and s.id={quote(resource)}')
        if not rows:
            return 404, {'error': 'assinante não encontrado'}, None
        row = normalize(rows[0]); row['contracts'] = contracts(scope, 'c.subscriber_id=' + quote(resource))
        return 200, row, None
    rows = contracts(scope, 'c.id=' + quote(resource))
    if not rows:
        return 404, {'error': 'contrato não encontrado'}, None
    row = rows[0]
    row['history'] = normalize(records(f'''select h.at,h.event,h.detail,u.name actor_name from contract_history h left join users u on u.id=h.actor_id
        where h.contract_id={quote(resource)} and h.tenant_id={quote(scope['tenant'])} order by h.id desc'''))
    return 200, row, None


class Harness:
    def __init__(self, fastify, go, selected=None):
        self.fastify, self.go = fastify, go
        self.results = []
        self.selected=selected
        self.specs=[]
        for path in sorted((ROOT/'tests/contrato/rotas').glob('*.yaml')):
            spec=json.loads(path.read_text())
            if spec['fase']==1:
                assert spec['resposta']['chaves_exatas'] and not spec['resposta']['volateis']
                pattern='^'+re.escape(spec['rota'].split(' ',1)[1]).replace(':id','[^/]+')+'$'
                self.specs.append((re.compile(pattern),spec))
        assert len(self.specs)==3,'especificações incompletas'

    def check(self, name, path, token=None, cookie=False, scope=None, status=None, **kwargs):
        spec=next((spec for pattern,spec in self.specs if pattern.fullmatch(path.split('?',1)[0])),None)
        assert spec is not None,'rota sem especificação: '+path
        if self.selected and spec['rota']!=self.selected:return None,None
        a, b = [request(base, path, token, cookie, **kwargs) for base in (self.fastify, self.go)]
        failures = []
        if a['status'] != b['status']:
            failures.append(f'status Fastify={a["status"]}, Go={b["status"]}')
        if a['json'] is not None:
            if not same(a['json'], b['json']):
                failures.append('corpo JSON divergente')
        elif a['body'] != b['body']:
            failures.append('bytes divergentes')
        for header in HEADERS:
            if a['headers'].get(header) != b['headers'].get(header):
                failures.append('cabeçalho divergente: ' + header)
        if status is not None and (a['status'] != status or b['status'] != status):
            failures.append('status esperado: ' + str(status))
        if scope and a['status'] in (200, 404) and 'format=csv' not in path:
            e_status, e_body, e_total = expected(scope, path)
            for label, response in (('Fastify', a), ('Go', b)):
                if response['status'] != e_status or not same(response['json'], e_body) or response['headers'].get('x-total-count') != e_total:
                    failures.append('oráculo do banco: ' + label)
        self.results.append({'caso': name, 'rota': path, 'ok': not failures, 'falhas': failures})
        if failures:
            # Somente dados sintéticos, sem credencial ou cabeçalho de autenticação.
            self.results[-1]['respostas'] = {label: {'status': x['status'], 'corpo': x['body'][:1200].decode('utf-8', errors='replace')} for label, x in (('Fastify', a), ('Go', b))}
            print(name + ': ' + '; '.join(failures), flush=True)
        return a, b

    def assertion(self, name, condition):
        self.results.append({'caso': name, 'ok': bool(condition), 'falhas': [] if condition else ['asserção falhou']})


def suite(h):
    tenants = records("select t.id,count(s.*) n from tenants t join subscribers s on s.tenant_id=t.id where t.slug like 'bench-%' group by t.id order by n desc,t.id")
    selected = [tenants[0], tenants[len(tenants)//2], tenants[-1]]
    missing = '00000000-0000-4000-8000-000000000000'
    all_users = records("select * from users where email like '%@contrato.invalid'")
    operator = next(u for u in all_users if u['role'] == 'saas_operator')
    for index, t in enumerate(selected):
        tenant = t['id']; other = selected[(index + 1) % len(selected)]['id']
        users = [u for u in all_users if u['tenant_id'] == tenant]
        admin = next(u for u in users if u['email'].endswith('-admin@contrato.invalid'))
        sub = sql(f'select id from subscribers where tenant_id={quote(tenant)} order by id limit 1')
        con = sql(f'select id from contracts where tenant_id={quote(tenant)} order by id limit 1')
        other_sub = sql(f'select id from subscribers where tenant_id={quote(other)} order by id limit 1')
        other_con = sql(f'select id from contracts where tenant_id={quote(other)} order by id limit 1')
        identities = [(u, 'contrato:' + u['id'], False) for u in users]
        identities += [(operator, 'contrato:' + operator['id'], False), (operator, 'support:' + tenant, True)]
        for user, token, support in identities:
            name = user['email'].split('@')[0] + ('-support' if support else '')
            allowed = user['role'] != 'subscriber' and (user['role'] != 'saas_operator' or support)
            status = None if allowed else 403
            if not user['active']: status = 401
            elif not user['mfa_enabled'] and user['role'] in ('admin', 'saas_operator'): status = 403
            scope = {'tenant': tenant}
            if user['email'].endswith('-pop@contrato.invalid'):
                scope['pop'] = sql(f'select pop_id from user_pops where user_id={quote(user["id"])}')
            for cookie in (False, True):
                for path in ('/api/subscribers?limit=3', '/api/subscribers/' + sub, '/api/contracts/' + con,
                             '/api/subscribers/' + other_sub, '/api/contracts/' + other_con,
                             '/api/subscribers/' + missing, '/api/contracts/' + missing):
                    h.check(name + (' cookie' if cookie else ' bearer'), path, token, cookie,
                            scope=scope if status is None else None, status=status,
                            headers={'X-Bench-Tenant': other, 'X-Nexo-Tenant': other})
            if 'pop' in scope:
                for p in records(f'select distinct on (pop_id) id,pop_id from contracts where tenant_id={quote(tenant)} order by pop_id,id'):
                    h.check(name + ' POP', '/api/contracts/' + p['id'], token, scope=scope)
        token = 'contrato:' + admin['id']; scope = {'tenant': tenant}
        for query in ('', 'limit=1', 'limit=5000', 'limit=3&offset=2', 'offset=99999', 'status=active', 'status=inactive',
                      'q=Teste', 'q=%40', 'q=123', 'q=%20%20', 'q=%25', 'q=_', 'format=csv&limit=2', 'format=csv',
                      'format=csv&offset=99999', 'limit=0x10', 'limit=1e1', 'limit=%20', 'limit=1.5', 'offset=-1',
                      'limit=5001', 'limit=x', 'q=' + 'x'*101, 'q=a&q=b', 'status=wrong', 'status=a&status=b',
                      'limit=1&limit=2', 'q=' + 'x'*101 + '&status=wrong&limit=0&offset=-1'):
            h.check('filtros/paginação/CSV', '/api/subscribers?' + query, token, scope=None if any(x in query for x in ('5001', '1.5', '-1', 'limit=x', 'x'*101, 'q=a&q=b', 'status=wrong', 'status=a&status=b', 'limit=1&limit=2', 'limit=%20')) else scope)
        for path in ('/api/subscribers', '/api/subscribers/' + sub, '/api/contracts/' + con):
            h.check('sem credencial', path, status=401)
            h.check('token inválido', path, 'invalid', status=401)
            h.check('sessão expirada', path, 'expired:' + admin['id'], status=401)
            h.check('HTTPS cabeçalhos', path, token, headers={'X-Forwarded-Proto': 'https'})
            h.check('HEAD implícito do Fastify',path,token,method='HEAD')
        h.check('HEAD CSV mantém JSON sem exportação','/api/subscribers?format=csv&limit=1',token,method='HEAD')
        h.check('format repetido não exporta CSV','/api/subscribers?format=csv&format=json&limit=1',token)
        for path in ('/api/subscribers/invalid', '/api/contracts/invalid'):
            h.check('UUID inválido autenticado', path, token, status=400)
            h.check('UUID inválido sem permissão', path, 'contrato:' + next(u['id'] for u in users if u['role']=='subscriber'), status=403)
        audit_checks(h, tenant, token)


def audit_checks(h, tenant, token):
    for base, label in ((h.fastify, 'Fastify'), (h.go, 'Go')):
        before = int(sql('select coalesce(max(id),0) from audit_events'))
        request(base, '/api/subscribers?format=csv&limit=1', token)
        rows = records(f'select action,entity_type,entity_id,result,detail from audit_events where id>{before}')
        h.assertion('export.csv no banco ' + label, rows == [{'action':'export.csv','entity_type':'list','entity_id':None,'result':'ok','detail':{'path':'/api/subscribers','rows':1}}])
        portal = sql(f"select id from users where tenant_id={quote(tenant)} and role='subscriber'")
        before = int(sql('select coalesce(max(id),0) from audit_events'))
        request(base, '/api/subscribers?limit=1', 'contrato:' + portal)
        rows = records(f'select action,result,detail from audit_events where id>{before}')
        h.assertion('access.denied no banco ' + label, rows == [{'action':'access.denied','result':'denied','detail':{'url':'/api/subscribers?limit=1'}}])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fastify', default=os.getenv('NEXO_CONTRATO_FASTIFY', 'http://127.0.0.1:18081'))
    parser.add_argument('--go', default=os.getenv('NEXO_CONTRATO_GO', 'http://127.0.0.1:18082'))
    parser.add_argument('--rotas', default='fase1', choices=['fase1'])
    parser.add_argument('--rota', choices=['GET /api/subscribers','GET /api/subscribers/:id','GET /api/contracts/:id'])
    args = parser.parse_args()
    h = Harness(args.fastify, args.go,args.rota)
    suite(h)
    dest = ROOT/'tests/contrato/relatorios'/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    dest.mkdir(parents=True)
    report = {'casos':len(h.results),'aprovados':sum(x['ok'] for x in h.results),'falhas':sum(not x['ok'] for x in h.results),'resultados':h.results}
    (dest/'contrato.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    (dest/'contrato.md').write_text(f'# Contrato fase 1\n\nCasos: {report["casos"]}; aprovados: {report["aprovados"]}; falhas: {report["falhas"]}.\n' + '\n'.join('- '+x['caso']+': '+('; '.join(x['falhas']) or 'ok') for x in h.results))
    print(json.dumps({k:v for k,v in report.items() if k!='resultados'}),flush=True)
    return bool(report['falhas'])


if __name__ == '__main__':
    sys.exit(main())
