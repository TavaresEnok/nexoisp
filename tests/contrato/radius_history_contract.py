"""Focused history/CSV contract on an already owned, synthetic nexo_test DB.
Called by nativo.py; no daemon, credential discovery or packet transport here.
"""
import csv
import io
import json
import uuid
from lib import quote


def verify(api, call, sql):
    def records(q):
        return json.loads(sql("select coalesce(json_agg(r),'[]') from (" + q + ") r", 'nexo_test'))
    tenants = {r['email']: r for r in records("select tenant_id,id,email from users where email in ('admin@alfa.demo','admin@beta.demo')")}
    alfa = tenants['admin@alfa.demo']['tenant_id']
    beta = tenants['admin@beta.demo']['tenant_id']
    marker = 'history-' + uuid.uuid4().hex
    nas = str(uuid.uuid4())
    restricted = str(uuid.uuid4())
    pop = str(uuid.uuid4())
    try:
        sql(f"insert into devices(id,tenant_id,name,driver,vendor) values('{nas}','{alfa}','History fixture','radius','generic');"
            f"insert into radius_acct(tenant_id,unique_id,username,session_id,nas_device_id,nas_ip,started_at,updated_at,stopped_at,bytes_in,bytes_out,framed_ipv6_address,framed_ipv6_prefix,delegated_ipv6_prefix) "
            f"select '{alfa}',{quote(marker)}||g,{quote(marker)},'reused-external-session','{nas}','198.18.0.1',now()-g*interval '1 hour',now(),case when g%2=0 then now() end,9223372036854775807,4294967300,'2001:db8::2','2001:db8:1::/64','2001:db8:200::/56' from generate_series(1,103) g;"
            f"insert into radius_acct(tenant_id,unique_id,username,session_id,started_at,updated_at) values('{beta}',{quote(marker+'-peer')},{quote(marker)},'peer',now(),now());"
            f"insert into pops(id,tenant_id,name) values('{pop}','{alfa}','History restricted fixture');"
            f"insert into users(id,tenant_id,email,name,password_hash,role) select '{restricted}',tenant_id,{quote(marker+'@synthetic.invalid')},'History POP fixture',password_hash,'noc' from users where email='admin@alfa.demo';"
            f"insert into user_pops(tenant_id,user_id,pop_id) values('{alfa}','{restricted}','{pop}')", 'nexo_test')
        path = '/api/radius/accounting/sessions?username=' + marker
        page = api(path)
        assert page['status'] == 200, page['json']
        first = page['json']
        assert len(first['items']) == 100 and first['next_before'] == first['items'][-1]['id']
        assert first['live_connection_proof'] is False
        assert all(r['nas_device_id'] == nas and r['bytes_in'] == '9223372036854775807' and r['bytes_out'] == '4294967300' for r in first['items'])
        assert all(r['ipv6_address'] == '2001:db8::2' and r['ipv6_prefix'] == '2001:db8:1::/64' and r['delegated_ipv6_prefix'] == '2001:db8:200::/56' for r in first['items'])
        # New rows between pages do not repeat an earlier generation.
        sql(f"insert into radius_acct(tenant_id,unique_id,username,session_id,started_at,updated_at) values('{alfa}',{quote(marker+'-new')},{quote(marker)},'later-arrival',now(),now())", 'nexo_test')
        tail = api(path + '&before=' + first['next_before'])['json']
        assert len(tail['items']) == 3 and tail['next_before'] is None
        assert not ({r['id'] for r in first['items']} & {r['id'] for r in tail['items']})
        exported = api(path + '&before=' + first['next_before'] + '&format=csv')
        assert exported['status'] == 200 and exported['headers']['cache-control'] == 'no-store'
        data = list(csv.DictReader(io.StringIO(exported['body'].decode('utf-8-sig')), delimiter=';'))
        assert len(data) == 3 and data[0]['bytes_in'] == '9223372036854775807'
        assert [r['id'] for r in data] == [r['id'] for r in tail['items']]
        assert data[0]['delegated_ipv6_prefix'] == '2001:db8:200::/56'
        for state in ['open', 'closed']:
            rows = api(path + '&state=' + state + '&nas=' + nas)['json']['items']
            assert rows and all(r['state'] == state for r in rows)
        empty = api(path + '&nas=' + str(uuid.uuid4()) + '&format=csv')
        assert len(list(csv.reader(io.StringIO(empty['body'].decode('utf-8-sig')), delimiter=';'))) == 1
        assert 'delegated_ipv6_prefix' in empty['body'].decode()
        for query in ['state=live', 'before=0', 'before=9223372036854775808', 'nas=x', 'format=zip', 'state=open&state=closed', 'tenant=foreign']:
            assert api('/api/radius/accounting/sessions?' + query)['status'] == 400, query
        for email in ['admin@beta.demo', marker+'@synthetic.invalid']:
            login = call('/api/auth/login', {'email': email, 'password': 'demo1234', 'bearer': True})
            assert login['status'] == 200
            for suffix in ['', '&format=csv']:
                response = call(path + suffix, token=login['json']['token'])
                if email.startswith('admin@beta'):
                    assert response['status'] == 200
                    if not suffix: assert len(response['json']['items']) == 1 and response['json']['items'][0]['session_id'] == 'peer'
                    else: assert '2001:db8' not in response['body'].decode()
                else: assert response['status'] == 403, response['json']
        audits = records("select detail from audit_events where tenant_id=" + quote(alfa) + " and action='export.csv' and entity_type='radius_accounting' and detail->>'username'=" + quote(marker) + " order by id desc limit 2")
        assert len(audits) == 2 and {a['detail']['rows'] for a in audits} == {0, 3}
        return {'ok': True, 'checks': ['generation cursor and concurrent insert', 'bigint exact JSON/CSV', 'IPv6 address/prefix/delegation', 'open/closed and NAS filters', 'empty CSV header', 'tenant isolation JSON/CSV', 'POP rejection JSON/CSV', 'invalid filters', 'export audit'], 'hardware_homologation': False}
    finally:
        sql("delete from radius_acct where username="+quote(marker)+f";delete from user_pops where user_id='{restricted}';delete from sessions where user_id='{restricted}';delete from users where id='{restricted}';delete from pops where id='{pop}';delete from devices where id='{nas}'", 'nexo_test')
