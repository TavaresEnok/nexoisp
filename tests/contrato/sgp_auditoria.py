#!/usr/bin/env python3
"""Regressões da auditoria SGP: somente banco sintético e API local isolada."""
import base64
from concurrent.futures import ThreadPoolExecutor
import json
import os
import subprocess

from lib import ROOT, LOCAL, command, go, go_env, request, sql, wait
from nativo import up


def main():
    up()
    LOCAL.mkdir(parents=True, exist_ok=True)
    for target, package in [('api', './cmd/api'), ('nexo-db', './cmd/nexo-db')]:
        go('build', '-o', 'bin/' + target, package, capture_output=True)
    # This database name is explicitly allowed by lib.sql; no product .env is read.
    sql('drop database if exists nexo_test with (force);create database nexo_test', 'postgres')
    env = dict(go_env('nexo_test'), NEXO_DEMO_MODE='1', NEXO_REQUIRE_ADMIN_MFA='0',
               NEXO_GO_JOBS='0', NEXO_GO_ADDR='127.0.0.1:18891',
               NEXO_GO_INTERNAL_ADDR='127.0.0.1:19891', NEXO_GO_AGENT_ADDR='127.0.0.1:18893',
               NEXO_SECRET_KEY=base64.b64encode(os.urandom(32)).decode(),
               NEXO_OP_SIGNING_KEY=base64.b64encode(subprocess.check_output(
                   ['openssl', 'genpkey', '-algorithm', 'ed25519', '-outform', 'DER'])).decode())
    for operation in ['prepare', 'seed-demo']:
        command([str(ROOT/'apps/api-go/bin/nexo-db'), operation], env=env, cwd=ROOT, capture_output=True)
    checks = []
    with (LOCAL/'sgp-auditoria.log').open('w') as log:
        proc = subprocess.Popen([str(ROOT/'apps/api-go/bin/api')], env=env, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        try:
            wait('http://127.0.0.1:18891', '/api/health', proc)
            base = 'http://127.0.0.1:18891'

            def call(path, body=None, method=None, token=None, expected=200):
                result = request(base, '/api'+path, token=token,
                                 method=method or ('POST' if body is not None else 'GET'),
                                 headers={'Content-Type': 'application/json'} if body is not None else {},
                                 body=json.dumps(body).encode() if body is not None else None)
                allowed = expected if isinstance(expected, tuple) else (expected,)
                assert result['status'] in allowed, (path, result['status'], result['json'])
                return result['json']

            def login(email):
                return call('/auth/login', {'email': email, 'password': 'demo1234', 'bearer': True})['token']

            admin = login('admin@alfa.demo')
            other = login('admin@beta.demo')
            finance = login('financeiro@alfa.demo')

            def api(path, body=None, method=None, token=admin, expected=200):
                return call(path, body, method, token, expected)

            sub = api('/subscribers', {'name': 'Pessoa fictícia auditoria'})
            # Calendar validation belongs in the API, before a PostgreSQL cast.
            for invalid in ['2026-02-30', '0000-01-01', '2026-2-01']:
                api('/subscribers', {'name': 'Data inválida', 'birth_date': invalid}, expected=400)
            leap = api('/subscribers', {'name': 'Ano bissexto', 'birth_date': '2024-02-29'})
            assert leap['birth_date'].startswith('2024-02-29')
            editable = api('/subscribers', {'name': 'Cadastro para editar', 'phone': '11955550000',
                                           'email': 'pessoa@auditoria.invalid', 'status': 'inactive', 'birth_date': '2024-02-29'})
            changed = api('/subscribers/'+editable['id'], {'name': 'Nome corrigido'}, 'PATCH')
            assert changed['phone'] == editable['phone'] and changed['email'] == editable['email']
            assert changed['status'] == 'inactive' and changed['birth_date'] == editable['birth_date']
            api('/subscribers/'+editable['id'], {'phone': None}, 'PATCH')
            assert api('/subscribers/'+editable['id'])['phone'] is None
            checks.append('AUD-07: PATCH parcial preserva campos e inatividade; null explícito limpa telefone')
            plan = api('/plans', {'name': 'Plano de auditoria', 'price_cents': 3500,
                                  'down_kbps': 1000, 'up_kbps': 1000, 'profile_name': 'auditoria'})
            api('/contracts', {'subscriber_id': sub['id'], 'plan_id': plan['id'], 'due_day': 10,
                               'start_date': '2026-04-31'}, expected=400)
            contract = api('/contracts', {'subscriber_id': sub['id'], 'plan_id': plan['id'], 'due_day': 10})
            api('/invoices', {'contract_id': contract['id'], 'description': 'Somente teste',
                              'amount_cents': 3500, 'due_date': '2026-02-30'}, expected=400)
            checks.append('AUD-01: datas reais, ano bissexto, contrato e fatura sem erro 500')

            for key, kind, required in [('aud_date', 'date', False), ('aud_text', 'text', True)]:
                api('/custom-fields', {'entity': 'subscriber', 'key': key, 'label': key,
                                       'type': kind, 'required': required})
            api('/subscribers/'+sub['id']+'/custom', {'values': {'aud_date': '2026-02-30'}}, 'PUT', expected=400)
            api('/subscribers/'+sub['id']+'/custom', {'values': {'aud_text': '   '}}, 'PUT', expected=400)
            api('/subscribers/'+sub['id']+'/custom', {'values': {'aud_date': '2024-02-29', 'aud_text': 'válido'}}, 'PUT')
            read = api('/subscribers/'+sub['id'])
            assert read['custom']['aud_date'] == '2024-02-29'
            api('/subscribers/'+sub['id']+'/custom', {'values': {'aud_text': 'outro'}}, 'PUT', token=other, expected=404)
            api('/subscribers/'+sub['id']+'/custom', {'values': {'aud_text': 'outro'}}, 'PUT', token=finance, expected=403)
            anonymous = api('/subscribers', {'name': 'Titular fictício removível'})
            api('/subscribers/'+anonymous['id']+'/anonymize', {'reason': 'Exercício sintético de anonimização', 'confirm_name': anonymous['name']})
            api('/subscribers/'+anonymous['id']+'/custom', {'values': {'aud_text': 'reintrodução'}}, 'PUT', expected=409)
            assert api('/subscribers/'+anonymous['id'])['custom'] == {}
            checks.append('AUD-02: custom persistido, vazio/data recusados, RLS, papel e bloqueio após anonimização')

            staff = api('/staff')
            helper = next(u['id'] for u in staff if u['role'] == 'noc')
            assistant = next(u['id'] for u in staff if u['role'] == 'attendant')
            wo = api('/work-orders', {'subscriber_id': sub['id'], 'contract_id': contract['id'],
                                      'kind': 'repair', 'description': 'OS fictícia de auditoria'})
            path = '/work-orders/'+wo['id']
            api(path+'/helpers', {'user_id': helper})
            api(path+'/helpers', {'user_id': helper})
            detail = api(path)
            assert len(detail['helpers']) == 1
            assert sum(e['event'] == 'helper_added' for e in detail['events']) == 1
            api(path, {'assignee_id': helper}, 'PATCH')
            assert api(path)['helpers'] == []
            api(path+'/helpers', {'user_id': helper}, expected=400)
            api(path+'/helpers', {'user_id': assistant})
            api(path+'/helpers', {'user_id': assistant}, token=other, expected=404)
            api(path+'/helpers', {'user_id': assistant}, token=finance, expected=403)
            api(path+'/status', {'status': 'in_progress'})
            api(path+'/status', {'status': 'done', 'resolution': 'Ensaio sem atividade de rede'})
            api(path+'/helpers', {'user_id': assistant}, expected=400)
            api(path+'/helpers/'+assistant, method='DELETE', expected=400)
            assert len(api(path)['helpers']) == 1
            checks.append('AUD-03: auxiliares idempotentes, promoção, histórico e OS concluída protegida')

            raced = api('/work-orders', {'subscriber_id': sub['id'], 'kind': 'repair', 'description': 'Concorrência fictícia'})
            racepath = '/work-orders/'+raced['id']
            with ThreadPoolExecutor(2) as pool:
                f1 = pool.submit(api, racepath+'/helpers', {'user_id': assistant}, expected=(200, 400))
                f2 = pool.submit(api, racepath, {'assignee_id': assistant}, 'PATCH')
                f1.result(); f2.result()
            # One ordering promotes; the other rejects addition to the assignee.
            assert not api(racepath)['helpers']
            checks.append('AUD-04: concorrência de atribuição/auxiliares sem papel duplo')

            # Stock/OS effects must roll back together when a kit is short.
            item = api('/stock/items', {'name': 'Conector sintético', 'unit': 'un'})
            api('/stock/items/'+item['id']+'/movements', {'kind': 'in', 'qty': 2})
            kit = api('/install-kits', {'name': 'Kit sintético', 'items': [{'item_id': item['id'], 'qty': 3}]})
            api(racepath+'/kit', {'kit_id': kit['id']}, expected=409)
            assert next(i for i in api('/stock/items') if i['id'] == item['id'])['balance'] == 2
            api(racepath+'/materials', {'item_id': item['id'], 'qty': 1})
            api(racepath+'/materials', {'item_id': item['id'], 'qty': -2}, expected=400)
            api(racepath+'/materials', {'item_id': item['id'], 'qty': -1})
            assert next(i for i in api('/stock/items') if i['id'] == item['id'])['balance'] == 2
            small = api('/install-kits', {'name': 'Kit suficiente', 'items': [{'item_id': item['id'], 'qty': 1}]})
            api(racepath+'/kit', {'kit_id': small['id']})
            assert next(i for i in api('/stock/items') if i['id'] == item['id'])['balance'] == 1
            checks.append('AUD-05: material, devolução limitada e kit insuficiente sem perda de saldo')
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill(); proc.wait()
    result = {'ok': True, 'environment': 'nexo_test sintético; sem rede/pagamento externo', 'checks': checks}
    reports = ROOT/'tests/contrato/relatorios'
    reports.mkdir(parents=True, exist_ok=True)
    (reports/'sgp-auditoria.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
