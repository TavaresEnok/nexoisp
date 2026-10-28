"""NAS recency telemetry on an already owned, synthetic nexo_test DB.
Called by nativo.py; no daemon, credential discovery or packet transport here.
INSERT into radius_acct keeps an explicit seen_at: radius_acct_touch only
rewrites seen_at on an ingest UPDATE (db/migrations/00076).
"""
import json
import uuid
from lib import quote


def verify(api, call, sql):
    def records(q):
        return json.loads(sql("select coalesce(json_agg(r),'[]') from (" + q + ") r", 'nexo_test'))

    def lab_ip():
        raw = uuid.uuid4().bytes
        return '198.18.%d.%d' % (raw[0], 1 + (raw[1] % 254))

    def one(body, device):
        found = [row for row in body['items'] if row['device_id'] == device]
        assert len(found) == 1, (device, [row.get('device_id') for row in body['items']])
        return found[0]

    tenants = {r['email']: r for r in records("select tenant_id,id,email from users where email in ('admin@alfa.demo','admin@beta.demo')")}
    alfa = tenants['admin@alfa.demo']['tenant_id']
    beta = tenants['admin@beta.demo']['tenant_id']
    marker = 'tel-' + uuid.uuid4().hex
    nas_interim, nas_default, nas_beta = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    subscriber, plan, version, contract, resource = (str(uuid.uuid4()) for _ in range(5))
    empty_device, empty_subscriber, empty_plan, empty_version, empty_contract, empty_resource = (str(uuid.uuid4()) for _ in range(6))
    restricted, pop = str(uuid.uuid4()), str(uuid.uuid4())
    ip_interim, ip_default, ip_beta = lab_ip(), lab_ip(), lab_ip()
    user_now, user_late, user_default, user_beta = marker + '-now', marker + '-late', marker + '-def', marker + '-beta'
    try:
        sql(
            f"insert into devices(id,tenant_id,name,driver,vendor) values"
            f"('{empty_device}','{beta}',{quote('Tel sem NAS '+marker)},'radius','generic');"
            f"insert into subscribers(id,tenant_id,name) values('{empty_subscriber}','{beta}',{quote('Tel sem NAS '+marker)});"
            f"insert into plans(id,tenant_id,name) values('{empty_plan}','{beta}',{quote('Plano sem NAS '+marker)});"
            f"insert into plan_versions(id,tenant_id,plan_id,version,price_cents,down_kbps,up_kbps,profile_name) values('{empty_version}','{beta}','{empty_plan}',1,1000,1000,1000,'telemetry');"
            f"insert into contracts(id,tenant_id,subscriber_id,plan_version_id,due_day) values('{empty_contract}','{beta}','{empty_subscriber}','{empty_version}',10);"
            f"insert into service_resources(id,tenant_id,contract_id,device_id,pppoe_username,desired_profile) values('{empty_resource}','{beta}','{empty_contract}','{empty_device}',{quote(marker+'-orphan')},'telemetry');"
            f"insert into service_sessions(tenant_id,resource_id,session_key,started_at,bytes_in,bytes_out,reported_at) values('{beta}','{empty_resource}','orphan',timestamptz '2026-10-28 12:34:56+00',0,0,timestamptz '2026-10-28 12:34:56+00')",
            'nexo_test')
        beta_login = call('/api/auth/login', {'email': 'admin@beta.demo', 'password': 'demo1234', 'bearer': True})
        assert beta_login['status'] == 200, beta_login['json']
        empty = call('/api/radius/accounting/telemetry', token=beta_login['json']['token'])
        assert empty['status'] == 200, empty['json']
        assert empty['headers']['cache-control'] == 'no-store'
        empty_body = empty['json']
        assert empty_body['items'] == []
        assert isinstance(empty_body['generated_at'], str) and empty_body['generated_at']
        assert empty_body['last_usage_applied_at'] == '2026-10-28T12:34:56.000Z'
        assert empty_body['limit'] == 500 and empty_body['source'] == 'radius_acct'
        assert empty_body['open_accounting_is_online_proof'] is False and empty_body['packet_recency_is_policy_proof'] is False
        sql(
            f"insert into devices(id,tenant_id,name,driver,vendor,acct_interim_seconds) values"
            f"('{nas_interim}','{alfa}',{quote('Tel interim '+marker)},'radius','generic',60),"
            f"('{nas_default}','{alfa}',{quote('Tel default '+marker)},'radius','generic',null),"
            f"('{nas_beta}','{beta}',{quote('Tel beta '+marker)},'radius','generic',60);"
            f"insert into radius_nas(device_id,tenant_id,nas_ip,secret,last_packet_at) values"
            f"('{nas_interim}','{alfa}','{ip_interim}','telemetry-secret-ok',now()-interval '2 minutes'),"
            f"('{nas_default}','{alfa}','{ip_default}','telemetry-secret-ok',null),"
            f"('{nas_beta}','{beta}','{ip_beta}','telemetry-secret-ok',null);"
            f"insert into radius_acct(tenant_id,nas_device_id,unique_id,session_id,username,nas_ip,started_at,updated_at,bytes_in,bytes_out,seen_at) values"
            f"('{alfa}','{nas_interim}',{quote(user_late)},'late',{quote(user_late)},'{ip_interim}',now()-interval '10 minutes',now(),1,1,now()-interval '10 minutes'),"
            f"('{alfa}','{nas_interim}',{quote(user_now)},'now',{quote(user_now)},'{ip_interim}',now()-interval '1 minute',now(),1000,2000,now()),"
            f"('{alfa}','{nas_default}',{quote(user_default)},'def',{quote(user_default)},'{ip_default}',now()-interval '10 minutes',now(),1,1,now()-interval '10 minutes'),"
            f"('{beta}','{nas_beta}',{quote(user_beta)},'beta',{quote(user_beta)},'{ip_beta}',now()-interval '1 hour',now(),1,1,now()-interval '1 hour');"
            f"insert into radius_accounting_events(tenant_id,nas_device_id,source_ip,event_key,kind,session_id,username,data,status,received_at) values"
            f"('{alfa}','{nas_interim}','{ip_interim}',{quote(marker+'-delay')},'interim_update','now',{quote(user_now)},'{{\"delay\":\"42\"}}','applied',now()),"
            f"('{alfa}','{nas_interim}','{ip_interim}',{quote(marker+'-quar')},'interim_update','now',{quote(user_now)},'{{\"delay\":\"no\"}}','quarantine',now()),"
            f"('{alfa}','{nas_interim}','{ip_interim}',{quote(marker+'-old')},'interim_update','now',{quote(user_now)},'{{\"delay\":\"999\"}}','applied',now()-interval '25 hours');"
            f"insert into subscribers(id,tenant_id,name) values('{subscriber}','{alfa}',{quote('Tel '+marker)});"
            f"insert into plans(id,tenant_id,name) values('{plan}','{alfa}',{quote('Plano '+marker)});"
            f"insert into plan_versions(id,tenant_id,plan_id,version,price_cents,down_kbps,up_kbps,profile_name) values('{version}','{alfa}','{plan}',1,1000,1000,1000,'telemetry');"
            f"insert into contracts(id,tenant_id,subscriber_id,plan_version_id,due_day) values('{contract}','{alfa}','{subscriber}','{version}',10);"
            f"insert into service_resources(id,tenant_id,contract_id,device_id,pppoe_username,desired_profile) values('{resource}','{alfa}','{contract}','{nas_interim}',{quote(user_now)},'telemetry');"
            f"insert into pops(id,tenant_id,name) values('{pop}','{alfa}',{quote('Tel POP '+marker[:24])});"
            f"insert into users(id,tenant_id,email,name,password_hash,role) select '{restricted}',tenant_id,{quote(marker+'@synthetic.invalid')},'Telemetry POP fixture',password_hash,'noc' from users where email='admin@alfa.demo';"
            f"insert into user_pops(tenant_id,user_id,pop_id) values('{alfa}','{restricted}','{pop}')",
            'nexo_test')
        page = api('/api/radius/accounting/telemetry')
        assert page['status'] == 200, page['json']
        assert page['headers']['cache-control'] == 'no-store'
        body = page['json']
        assert body['limit'] == 500 and body['source'] == 'radius_acct'
        assert body['open_accounting_is_online_proof'] is False and body['packet_recency_is_policy_proof'] is False
        assert isinstance(body['generated_at'], str) and body['generated_at']
        interim, default = one(body, nas_interim), one(body, nas_default)
        assert all(row['device_id'] != nas_beta for row in body['items'])
        assert interim['nas_ip'] == ip_interim and interim['acct_interim_seconds'] == 60
        assert interim['threshold_seconds'] == 180 and interim['threshold_source'] == 'interim'
        assert interim['open_sessions'] == 2 and interim['overdue_sessions'] == 1
        assert interim['pending_usage_sessions'] == 1 and interim['events_24h'] == 2
        assert interim['max_reported_delay_seconds_24h'] == 42 and interim['quarantined_events'] == 1
        assert interim['last_packet_at'] and interim['oldest_open_seen_at'] < interim['last_accounting_at']
        assert default['nas_ip'] == ip_default and default['acct_interim_seconds'] is None
        assert default['threshold_seconds'] == 900 and default['threshold_source'] == 'default'
        assert default['open_sessions'] == 1 and default['overdue_sessions'] == 0 and default['pending_usage_sessions'] == 0
        assert default['events_24h'] == 0 and default['max_reported_delay_seconds_24h'] is None and default['last_packet_at'] is None
        for row in (interim, default):
            for key in ('open_sessions', 'overdue_sessions', 'events_24h', 'quarantined_events', 'pending_usage_sessions', 'threshold_seconds'):
                assert isinstance(row[key], int) and not isinstance(row[key], bool), (key, row[key])
            assert 'generated_at' not in row and 'last_usage_applied_at' not in row
        for query in ('tenant=foreign', 'nas=' + nas_interim, 'limit=1', 'state=open'):
            rejected = api('/api/radius/accounting/telemetry?' + query)
            assert rejected['status'] == 400 and rejected['json']['error'] == 'filtro desconhecido', rejected['json']
        repeated = api('/api/radius/accounting/telemetry?x=1&x=2')
        assert repeated['status'] == 400 and repeated['json']['error'] == 'filtro repetido', repeated['json']
        sql(f"insert into service_sessions(tenant_id,resource_id,session_key,started_at,bytes_in,bytes_out) values('{alfa}','{resource}',{quote(user_now)},now()-interval '1 minute',1000,2000)", 'nexo_test')
        applied = api('/api/radius/accounting/telemetry')
        assert applied['status'] == 200, applied['json']
        again = one(applied['json'], nas_interim)
        assert again['pending_usage_sessions'] == 0 and again['open_sessions'] == 2 and again['overdue_sessions'] == 1
        assert applied['json']['last_usage_applied_at'] and applied['json']['open_accounting_is_online_proof'] is False
        assert applied['json']['packet_recency_is_policy_proof'] is False
        beta_login = call('/api/auth/login', {'email': 'admin@beta.demo', 'password': 'demo1234', 'bearer': True})
        assert beta_login['status'] == 200, beta_login['json']
        beta_page = call('/api/radius/accounting/telemetry', token=beta_login['json']['token'])
        assert beta_page['status'] == 200, beta_page['json']
        assert one(beta_page['json'], nas_beta)['overdue_sessions'] == 1
        assert all(row['device_id'] not in (nas_interim, nas_default) for row in beta_page['json']['items'])
        assert beta_page['json']['open_accounting_is_online_proof'] is False
        pop_login = call('/api/auth/login', {'email': marker + '@synthetic.invalid', 'password': 'demo1234', 'bearer': True})
        assert pop_login['status'] == 200, pop_login['json']
        denied = call('/api/radius/accounting/telemetry', token=pop_login['json']['token'])
        assert denied['status'] == 403, denied['json']
        return {'ok': True, 'checks': ['interim threshold 180 and 10 minute overdue', 'default threshold 900', 'delay 42 inside 24h', 'pending usage clears when counters match', 'evidence flags false', 'tenant isolation', 'POP rejection', 'empty NAS keeps database generated_at and last_usage_applied_at'], 'hardware_homologation': False}
    finally:
        sql(
            f"delete from service_sessions where resource_id in ('{resource}','{empty_resource}');"
            f"delete from service_resources where id in ('{resource}','{empty_resource}');"
            f"delete from radius_acct where unique_id like {quote(marker+'%')};"
            f"delete from radius_accounting_events where event_key like {quote(marker+'%')};"
            f"delete from radius_nas where device_id in ('{nas_interim}','{nas_default}','{nas_beta}');"
            f"delete from devices where id in ('{nas_interim}','{nas_default}','{nas_beta}','{empty_device}');"
            f"delete from contracts where id in ('{contract}','{empty_contract}');"
            f"delete from plan_versions where id in ('{version}','{empty_version}');"
            f"delete from plans where id in ('{plan}','{empty_plan}');"
            f"delete from subscribers where id in ('{subscriber}','{empty_subscriber}');"
            f"delete from user_pops where user_id='{restricted}';"
            f"delete from sessions where user_id='{restricted}';"
            f"delete from users where id='{restricted}';"
            f"delete from pops where id='{pop}'",
            'nexo_test')
