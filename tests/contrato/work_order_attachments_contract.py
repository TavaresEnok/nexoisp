"""Contrato HTTP dos anexos de OS, com dados sintéticos no laboratório nativo."""
import base64
import json
import uuid
from lib import quote


def verify(api, call, sql):
    def ok(result, status=200):
        assert result['status'] == status, result
        return result['json']

    name = 'Titular anexo ' + uuid.uuid4().hex
    sub = ok(api('/api/subscribers', {'name': name}))
    wo = ok(api('/api/work-orders', {'subscriber_id': sub['id'], 'kind': 'repair', 'description': 'OS de anexo sintético'}))
    path = '/api/work-orders/' + wo['id'] + '/attachments'
    content = b'%PDF-anexo sintetico'
    assert call(path)['status'] in (401, 403)
    beta = ok(call('/api/auth/login', {'email': 'admin@beta.demo', 'password': 'demo1234', 'bearer': True}))['token']
    assert call(path, token=beta)['status'] == 404
    modules = sql("select modules::text from tenants where slug='alfa'", 'nexo_test').strip()
    try:
        sql("update tenants set modules=array_remove(modules,'field') where slug='alfa'", 'nexo_test')
        fresh = ok(call('/api/auth/login', {'email': 'admin@alfa.demo', 'password': 'demo1234', 'bearer': True}))['token']
        assert call(path, token=fresh)['status'] == 403
    finally:
        sql("update tenants set modules=" + quote(modules) + "::text[] where slug='alfa'", 'nexo_test')
    email = 'attachment-portal-' + uuid.uuid4().hex + '@synthetic.invalid'
    sql("insert into users(tenant_id,email,name,password_hash,role,subscriber_id) select tenant_id," + quote(email) + ",'Portal anexo',password_hash,'subscriber'," + quote(sub['id']) + " from users where email='admin@alfa.demo'", 'nexo_test')
    portal = ok(call('/api/auth/login', {'email': email, 'password': 'demo1234', 'bearer': True}))['token']
    assert call(path, token=portal)['status'] == 403
    # A restricted operator can see a subscriber without a contract, but not
    # one whose only contract belongs to a different POP.
    pop_a, pop_b, user_id = (str(uuid.uuid4()) for _ in range(3))
    restricted_email = 'attachment-pop-' + uuid.uuid4().hex + '@synthetic.invalid'
    sql("insert into pops(id,tenant_id,name) select " + quote(pop_a) + ",id,'Anexo POP A' from tenants where slug='alfa';"
        "insert into pops(id,tenant_id,name) select " + quote(pop_b) + ",id,'Anexo POP B' from tenants where slug='alfa';"
        "insert into users(id,tenant_id,email,name,password_hash,role) select " + quote(user_id) + ",tenant_id," + quote(restricted_email) + ",'Anexo POP',password_hash,'noc' from users where email='admin@alfa.demo';"
        "insert into user_pops(tenant_id,user_id,pop_id) select tenant_id,id," + quote(pop_a) + " from users where id=" + quote(user_id), 'nexo_test')
    restricted = ok(call('/api/auth/login', {'email': restricted_email, 'password': 'demo1234', 'bearer': True}))['token']
    assert call(path, token=restricted)['status'] == 200
    plan = ok(api('/api/plans', {'name': 'Plano anexo ' + uuid.uuid4().hex, 'price_cents': 100, 'down_kbps': 1000, 'up_kbps': 1000, 'profile_name': 'attachment' + uuid.uuid4().hex[:8]}))
    contract = ok(api('/api/contracts', {'subscriber_id': sub['id'], 'plan_id': plan['id'], 'due_day': 15}))
    sql("update contracts set pop_id=" + quote(pop_b) + " where id=" + quote(contract['id']), 'nexo_test')
    assert call(path, token=restricted)['status'] == 404
    sql("update contracts set pop_id=" + quote(pop_a) + " where id=" + quote(contract['id']), 'nexo_test')
    assert call(path, token=restricted)['status'] == 200
    item = ok(api(path, {'name': 'teste.pdf', 'content_base64': base64.b64encode(content).decode()}))
    removed = ok(api(path, {'name': 'remover.pdf', 'content_base64': base64.b64encode(content).decode()}))
    ok(api(path + '/' + removed['id'], method='DELETE'))
    assert api(path + '/' + removed['id'] + '/download')['status'] == 404
    deleted = json.loads(sql("select row_to_json(r) from (select content is null as erased, deleted_at is not null as deleted from documents where id=" + quote(removed['id']) + ") r", 'nexo_test'))
    assert deleted['erased'] and deleted['deleted'], deleted
    assert item['id'] in [x['id'] for x in ok(api(path))['items']]
    raw = api(path + '/' + item['id'] + '/download')
    assert raw['status'] == 200 and raw['body'] == content
    assert 'private' in raw['headers']['cache-control'] and 'no-store' in raw['headers']['cache-control']
    assert raw['headers']['x-content-type-options'] == 'nosniff'
    assert 'sandbox' in raw['headers']['content-security-policy']
    ok(api(path, {'name': 'inválido.pdf', 'content_base64': '!!!'}), 400)
    ok(api('/api/work-orders/' + str(uuid.uuid4()) + '/attachments/' + item['id'] + '/download'), 404)
    export = ok(api('/api/subscribers/' + sub['id'] + '/lgpd-export'))
    exported = [d for d in export['documents'] if d['name'] == 'teste.pdf']
    assert len(exported) == 1 and exported[0]['size_bytes'] == len(content) and exported[0]['deleted_at'] is None, exported
    anonymize = '/api/subscribers/' + sub['id'] + '/anonymize'
    anonymize_body = {'reason': 'Exercício sintético LGPD', 'confirm_name': name}
    ok(api(anonymize, anonymize_body), 409)
    assert sql("select status from contracts where id=" + quote(contract['id']), 'nexo_test').strip() == 'active'
    sql("update contracts set status='ended' where id=" + quote(contract['id']) + " and subscriber_id=" + quote(sub['id']) + " and status='active'", 'nexo_test')
    preconditions = json.loads(sql("select row_to_json(r) from (select (select count(*) from contracts where subscriber_id=" + quote(sub['id']) + " and status='active') as active_contracts,(select count(*) from invoices where subscriber_id=" + quote(sub['id']) + " and status in ('open','reconciling')) as pending_invoices) r", 'nexo_test'))
    assert preconditions == {'active_contracts': 0, 'pending_invoices': 0}, preconditions
    assert sql("select status from contracts where id=" + quote(contract['id']), 'nexo_test').strip() == 'ended'
    ok(api(anonymize, anonymize_body))
    row = json.loads(sql("select row_to_json(r) from (select content is null as erased, deleted_at is not null as deleted from documents where id=" + quote(item['id']) + ") r", 'nexo_test'))
    assert row['erased'] and row['deleted'], row
    ok(api(path, {'name': 'outro.pdf', 'content_base64': base64.b64encode(content).decode()}), 409)
