"""Contrato HTTP da cotação e do recebimento existente em duas réplicas."""
import concurrent.futures
import json
import uuid
from lib import quote


def verify(api, call, sql, bases):
    def ok(result, status=200):
        assert result['status'] == status, result
        return result['json']

    suffix = uuid.uuid4().hex[:8]
    item = ok(api('/api/stock/items', {'name': 'Item cotação ' + suffix, 'unit': 'un'}))
    supplier = ok(api('/api/stock/suppliers', {'name': 'Fornecedor ' + suffix}), 201)
    warehouse = ok(api('/api/stock/warehouses', {'name': 'Depósito ' + suffix}), 201)
    base = '/api/stock/quotations'
    assert call(base)['status'] in (401, 403)
    q = ok(api(base, {'title': 'Cotação ' + suffix, 'items': [{'item_id': item['id'], 'qty': 2}]}))
    path = base + '/' + q['id']
    assert q['id'] in [entry['id'] for entry in ok(api(base))['items']]
    assert api(base + '/' + str(uuid.uuid4()))['status'] == 404
    beta = ok(call('/api/auth/login', {'email': 'admin@beta.demo', 'password': 'demo1234', 'bearer': True}))['token']
    assert call(path, token=beta)['status'] == 404
    modules = sql("select modules::text from tenants where slug='alfa'", 'nexo_test').strip()
    try:
        sql("update tenants set modules=array_remove(modules,'field') where slug='alfa'", 'nexo_test')
        fresh = ok(call('/api/auth/login', {'email': 'admin@alfa.demo', 'password': 'demo1234', 'bearer': True}))['token']
        assert call(path, token=fresh)['status'] == 403
    finally:
        sql("update tenants set modules=" + quote(modules) + "::text[] where slug='alfa'", 'nexo_test')
    pop, user_id = str(uuid.uuid4()), str(uuid.uuid4())
    pop_email = 'quote-pop-' + suffix + '@synthetic.invalid'
    sql("insert into pops(id,tenant_id,name) select " + quote(pop) + ",id,'Cotação POP' from tenants where slug='alfa';"
        "insert into users(id,tenant_id,email,name,password_hash,role) select " + quote(user_id) + ",tenant_id," + quote(pop_email) + ",'Cotação POP',password_hash,'noc' from users where email='admin@alfa.demo';"
        "insert into user_pops(tenant_id,user_id,pop_id) select tenant_id,id," + quote(pop) + " from users where id=" + quote(user_id), 'nexo_test')
    restricted = ok(call('/api/auth/login', {'email': pop_email, 'password': 'demo1234', 'bearer': True}))['token']
    assert call(path, token=restricted)['status'] == 404
    assert call(path + '/offers', {'supplier_id': supplier['id'], 'prices': [{'item_id': item['id'], 'unit_cost_cents': 123}]}, token=restricted)['status'] == 404
    assert ok(api(path))['offers'] == []
    email = 'quote-reader-' + suffix + '@synthetic.invalid'
    sql("insert into users(tenant_id,email,name,password_hash,role) select tenant_id," + quote(email) + ",'Cotação leitura',password_hash,'attendant' from users where email='admin@alfa.demo'", 'nexo_test')
    reader = ok(call('/api/auth/login', {'email': email, 'password': 'demo1234', 'bearer': True}))['token']
    assert call(path, token=reader)['status'] == 200
    assert call(path + '/offers', {'supplier_id': supplier['id'], 'prices': []}, token=reader)['status'] == 403
    ok(api(path + '/offers', {'supplier_id': supplier['id'], 'prices': []}), 400)
    detail = ok(api(path + '/offers', {'supplier_id': supplier['id'], 'prices': [{'item_id': item['id'], 'unit_cost_cents': 123}]}))
    offer = detail['offers'][0]
    assert offer['total_cents'] == 246
    payload = {'offer_id': offer['id'], 'warehouse_id': warehouse['id']}
    sql("create function native_quote_fail_audit() returns trigger language plpgsql as $$begin if new.action='stock.quotation_convert' then raise exception 'synthetic rollback';end if;return new;end$$; create trigger native_quote_fail_audit before insert on audit_events for each row execute function native_quote_fail_audit()", 'nexo_test')
    try:
        assert api(path + '/purchase', payload)['status'] == 500
        row = json.loads(sql("select row_to_json(r) from (select status,purchase_order_id from stock_quotations where id=" + quote(q['id']) + ") r", 'nexo_test'))
        assert row == {'status': 'draft', 'purchase_order_id': None}, row
        assert int(sql("select count(*) from purchase_orders where note=(select note from stock_quotations where id=" + quote(q['id']) + ") and supplier_id=" + quote(supplier['id']), 'nexo_test')) == 0
    finally:
        sql('drop trigger native_quote_fail_audit on audit_events;drop function native_quote_fail_audit()', 'nexo_test')
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda b: api(path + '/purchase', payload, b), bases))
    orders = [ok(r) for r in results]
    assert orders[0] == orders[1]
    purchase = orders[0]['purchase_order_id']
    ok(api(path + '/purchase', dict(payload, expected_at='2026-11-01')), 409)
    def counts():
        return json.loads(sql("select row_to_json(r) from (select (select count(*) from purchase_orders where id=" + quote(purchase) + ") as orders,(select count(*) from stock_movements where purchase_order_id=" + quote(purchase) + ") as movements) r", 'nexo_test'))
    assert counts() == {'orders': 1, 'movements': 0}
    ok(api('/api/stock/purchases/' + purchase + '/receive', {}))
    assert counts() == {'orders': 1, 'movements': 1}
    assert api('/api/stock/purchases/' + purchase + '/receive', {})['status'] in (400, 409)
    assert counts()['movements'] == 1
