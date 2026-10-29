"""Contrato B15 do laboratório nativo. Chamado por nativo.py.

Não é runner. Não liga NEXO_CLOUD_API, não cria conta permanente e não chama a Meta.
R2 e G continuam pendentes de PostgreSQL: a gerência executa NEXO_CLOUD_PG_REQUIRED=1
em tests/contrato/go_integration.py, o runner que já existe. Skip não aprova esses dois.
"""
import json
from pathlib import Path

from lib import quote

ROOT = Path(__file__).resolve().parents[2]
INTERNAL = "http://127.0.0.1:19881"
ACCOUNT = "00000000-0000-4000-8000-00000000c015"


def verify(api, call, sql):
    def records(query):
        return json.loads(sql("select coalesce(json_agg(r),'[]') from (" + query + ") r", "nexo_test"))

    def one(query):
        found = records(query)
        assert len(found) == 1, found
        return found[0]

    migration = (ROOT / "db/migrations/00079_cloud_notice_journal.sql").read_text()
    up = migration.split("-- +goose Down", 1)[0]
    assert "insert into cloud_accounts" not in up.lower()
    assert "active boolean not null default false" in up
    assert "adapter text not null default 'generic_http'" in up
    assert "cloud_lock_timeouts integer not null default 0" in up

    gate = (ROOT / "apps/api-go/internal/outbound/notices_cloud.go").read_text()
    assert "func provenGraphVersions() []string {\n\treturn nil\n}" in gate
    assert 'os.Getenv("NEXO_CLOUD_API") == "on"' in gate
    assert gate.count("os.Getenv") == 1
    status = (ROOT / "apps/api-go/internal/outbound/cloudjournal/status.go").read_text()
    assert "func (UnprovedAuthenticator) Proven() bool { return false }" in status
    nativo = (ROOT / "tests/contrato/nativo.py").read_text()
    assert "NEXO_CLOUD_API" not in nativo

    applied = one(
        "select count(*) filter (where version_id = 79 and is_applied) as v79,"
        " max(version_id) as max_version from goose_db_version"
    )
    assert int(applied["v79"]) == 1 and int(applied["max_version"]) == 79, applied

    # Antes de qualquer fixture deste contrato.
    before = one(
        "select (select count(*) from cloud_accounts) as accounts,"
        " (select count(*) from cloud_notice_attempts) as attempts,"
        " (select count(*) from cloud_notice_status) as statuses,"
        " (select count(*) from notice_channels where adapter is distinct from 'generic_http') as other_adapters,"
        " (select column_default from information_schema.columns"
        "   where table_schema = 'public' and table_name = 'cloud_accounts' and column_name = 'active') as active_default,"
        " (select column_default from information_schema.columns"
        "   where table_schema = 'public' and table_name = 'notice_channels' and column_name = 'adapter') as adapter_default,"
        " (select column_default from information_schema.columns"
        "   where table_schema = 'public' and table_name = 'notice_log' and column_name = 'cloud_lock_timeouts') as timeout_default,"
        " (select count(*) from payments) as payments,"
        " (select coalesce(sum(signed_cents), 0) from payments) as signed_cents,"
        " (select count(*) from invoices) as invoices,"
        " (select count(*) from invoice_movements) as movements,"
        " (select count(*) from notice_log) as notices,"
        " (select count(*) from provider_notices) as provider_notices,"
        " (select count(*) from notifications) as notifications,"
        " (select count(*) from webhook_deliveries) as deliveries"
    )
    assert int(before["accounts"]) == 0, before
    assert int(before["attempts"]) == 0 and int(before["statuses"]) == 0, before
    assert int(before["other_adapters"]) == 0, before
    assert "false" in before["active_default"], before["active_default"]
    assert "generic_http" in before["adapter_default"], before["adapter_default"]
    assert before["timeout_default"] is not None and "0" in str(before["timeout_default"]), before["timeout_default"]

    locks = one(
        "select (select relrowsecurity from pg_class where relname = 'cloud_accounts') as accounts_rls,"
        " (select relrowsecurity from pg_class where relname = 'cloud_notice_status') as status_rls,"
        " (select confdeltype = 'c' from pg_constraint where conname = 'cloud_notice_attempts_notice_fk') as attempts_cascade,"
        " (select has_table_privilege('nexo_app', 'cloud_notice_status', 'delete')) as app_deletes_status,"
        " (select has_table_privilege('nexo_app', 'cloud_notice_status', 'insert')) as app_inserts_status"
    )
    assert locks["accounts_rls"] is True and locks["status_rls"] is True, locks
    assert locks["attempts_cascade"] is True, locks
    assert locks["app_deletes_status"] is False and locks["app_inserts_status"] is True, locks

    fixture = sql(
        "begin;"
        "insert into cloud_accounts (tenant_id, name, phone_number_id, graph_version, token_enc, webhook_secret_enc) "
        "select id, 'cnContract', '100', 'v0.0', 'v1.fixture', 'v1.fixture' from tenants order by id limit 1 "
        "returning active::text;"
        "insert into notice_channels (tenant_id, name, url) "
        "select id, 'cnContract', 'https://invalid.test/cn-contract' from tenants order by id limit 1 "
        "returning adapter;"
        "do $$ declare tid uuid; begin "
        "select id into tid from tenants order by id limit 1; "
        "begin "
        "insert into notice_channels (tenant_id, name, url, adapter) "
        "values (tid, 'cnContract bad', 'https://invalid.test/cn-contract-bad', 'cloud_api'); "
        "raise exception 'cloud_api sem conta foi aceito'; "
        "exception when check_violation then null; "
        "end; end $$;"
        "rollback;",
        "nexo_test",
    ).splitlines()
    assert fixture[:2] == ["false", "generic_http"], fixture
    assert int(one("select count(*) as n from cloud_accounts")["n"]) == 0
    assert int(one("select count(*) as n from notice_channels where name like 'cnContract%'")["n"]) == 0

    health = api("/api/health")
    assert health["status"] == 200 and health["json"].get("demo") is True, health.get("json")
    path = "/api/webhooks/cloud-api/" + ACCOUNT
    assert path.startswith("/api/") and "graph.facebook.com" not in path
    denied = call(path, {"observe": "cn-contract"}, method="POST")
    assert denied["status"] == 401 and denied["json"].get("error") == "recusado", denied.get("json")
    body = denied.get("body") or b""
    assert b"v1.fixture" not in body and b"graph.facebook.com" not in body
    missing = call(path, method="GET")
    assert missing["status"] >= 400, missing["status"]

    spec = call("/openapi.json", None, INTERNAL, "GET")
    assert spec["status"] == 200 and isinstance(spec["json"], dict), spec["status"]
    paths = spec["json"].get("paths") or {}
    cloud = [key for key in paths if "cloud-api" in key]
    assert cloud == ["/api/webhooks/cloud-api/{account}"], cloud
    item = paths[cloud[0]]
    assert "post" in item and "get" not in item and "put" not in item and "delete" not in item, item
    routes = json.loads((ROOT / "apps/api-go/rotas.json").read_text())["routes"]
    listed = [route for route in routes if "cloud-api" in route.get("path", "")]
    assert len(listed) == 1 and listed[0]["method"] == "POST" and listed[0]["path"] == "/api/webhooks/cloud-api/:account", listed

    after = one(
        "select (select count(*) from cloud_accounts) as accounts,"
        " (select count(*) from cloud_notice_attempts) as attempts,"
        " (select count(*) from cloud_notice_status) as statuses,"
        " (select count(*) from payments) as payments,"
        " (select coalesce(sum(signed_cents), 0) from payments) as signed_cents,"
        " (select count(*) from invoices) as invoices,"
        " (select count(*) from invoice_movements) as movements,"
        " (select count(*) from notice_log) as notices,"
        " (select count(*) from provider_notices) as provider_notices,"
        " (select count(*) from notifications) as notifications,"
        " (select count(*) from webhook_deliveries) as deliveries"
    )
    for key in (
        "accounts", "attempts", "statuses", "payments", "signed_cents", "invoices",
        "movements", "notices", "provider_notices", "notifications", "deliveries",
    ):
        assert str(after[key]) == str(before[key]), (key, before[key], after[key])
    assert quote(ACCOUNT)
