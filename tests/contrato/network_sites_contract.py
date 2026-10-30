"""Contrato HTTP do inventário passivo no laboratório descartável."""
import json
import uuid

from lib import quote


def verify(api, call, sql):
    ids = [str(uuid.uuid4()) for _ in range(4)]
    visible, hidden, foreign, user = ids
    email = 'sites-' + uuid.uuid4().hex + '@synthetic.invalid'
    sql(
        "insert into pops(id,tenant_id,name) select " + quote(visible) + ",id,'Site visível' from tenants where slug='alfa';"
        "insert into pops(id,tenant_id,name) select " + quote(hidden) + ",id,'Site oculto' from tenants where slug='alfa';"
        "insert into pops(id,tenant_id,name) select " + quote(foreign) + ",id,'Site estrangeiro' from tenants where slug='beta';"
        "insert into users(id,tenant_id,email,name,password_hash,role) select " + quote(user) + ",tenant_id," + quote(email) + ",'Site restrito',password_hash,'noc' from users where email='admin@alfa.demo';"
        "insert into user_pops(tenant_id,user_id,pop_id) select tenant_id,id," + quote(visible) + " from users where id=" + quote(user),
        'nexo_test',
    )
    login = call('/api/auth/login', {'email': email, 'password': 'demo1234', 'bearer': True})
    assert login['status'] == 200, login['status']
    token = login['json']['token']
    beta = call('/api/auth/login', {'email': 'admin@beta.demo', 'password': 'demo1234', 'bearer': True})
    assert beta['status'] == 200, beta['status']
    path = '/api/network/sites'
    def scoped(suffix='', body=None, method=None):
        return call(path + suffix, body, method=method, token=token)
    created = scoped(body={'pop_id': visible, 'kind': 'pole', 'name': 'Poste nativo', 'notes': 'preservada'})
    assert created['status'] == 200, created
    site = created['json']['id']
    item = '/' + site
    assert scoped(item)['status'] == 200
    edited = scoped(item, {'name': 'Poste alterado'}, 'PATCH')
    assert edited['status'] == 200 and edited['json']['notes'] == 'preservada', edited
    archived = scoped(item, {'active': False}, 'PATCH')
    assert archived['status'] == 200 and archived['json']['active'] is False, archived
    listing = scoped('?status=archived&pop_id=' + visible)
    assert listing['status'] == 200 and any(row['id'] == site for row in listing['json']['items']), listing
    assert scoped(item, {'active': True}, 'PATCH')['status'] == 200
    for pop in (hidden, foreign):
        denied = scoped(body={'pop_id': pop, 'kind': 'tower', 'name': 'Negado'})
        assert denied['status'] == 404, denied
    assert scoped('?pop_id=' + hidden)['status'] == 404
    assert scoped(item, {'pop_id': hidden}, 'PATCH')['status'] == 404
    assert call(path + item, token=beta['json']['token'])['status'] == 404
