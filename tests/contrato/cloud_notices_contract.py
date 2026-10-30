"""Contrato B15 do laboratório nativo. Chamado por nativo.py.

Não é runner. Não liga NEXO_CLOUD_API, não cria conta permanente e não chama a Meta.
R2 e G continuam pendentes de PostgreSQL: a gerência executa NEXO_CLOUD_PG_REQUIRED=1
em tests/contrato/go_integration.py, o runner que já existe. Skip não aprova esses dois.
"""
import json
from pathlib import Path
import subprocess
import uuid

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

    migrations = sorted((ROOT / "db/migrations").glob("[0-9][0-9][0-9][0-9][0-9]_*.sql"))
    assert migrations and migrations[-1].name == "00082_tenant_branding.sql", migrations[-1:]
    latest = int(migrations[-1].name[:5])
    applied = one(
        "select count(*) filter (where version_id = 79 and is_applied) as v79,"
        " count(*) filter (where version_id = 80 and is_applied) as v80,"
        " count(*) filter (where version_id = 81 and is_applied) as v81,"
        " count(*) filter (where version_id = 82 and is_applied) as v82,"
        " max(version_id) as max_version from goose_db_version"
    )
    assert int(applied["v79"]) == 1 and int(applied["v80"]) == 1 and int(applied["v81"]) == 1 and int(applied["v82"]) == 1 and int(applied["max_version"]) == latest, applied

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
    journal_path = "/api/notice-log/{id}/cloud-journal"
    assert journal_path in paths, sorted(key for key in paths if "notice-log" in key)
    journal_item = paths[journal_path]
    assert "get" in journal_item and "post" not in journal_item and "put" not in journal_item and "patch" not in journal_item and "delete" not in journal_item, journal_item
    listed_journal = [route for route in routes if route.get("path") == "/api/notice-log/:id/cloud-journal"]
    assert listed_journal == [{"method": "GET", "path": "/api/notice-log/:id/cloud-journal"}], listed_journal

    prove_cloud_journal(call, sql, one)

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


MARKER = "cn-journal-fixture"
OPERATOR = "operador@nexoisp.demo"
SUBSCRIBER = "cn-journal-subscriber@alfa.demo"
SUBSCRIBER_ID = "c15c0000-0000-4000-8000-0000000000e1"
assert str(uuid.UUID(SUBSCRIBER_ID)) == SUBSCRIBER_ID and uuid.UUID(SUBSCRIBER_ID).version == 4
ACCOUNT_IDS = (
    "c15c0000-0000-4000-8000-0000000000a1",
    "c15c0000-0000-4000-8000-0000000000a2",
    "c15c0000-0000-4000-8000-0000000000b1",
)
POISON = (
    "v1.cj-fixture-token",
    "v1.cj-fixture-hook",
    "cj-excerpt-secret",
    "cj-phone-a1",
    "cj-phone-a2",
    "cj-phone-b1",
    "cj-msg-page",
    "cj-msg-unlinked",
    "cj-msg-beta",
    "cj-raw-unlinked",
    "cj-raw-foreign-account",
    "cj-raw-other-tenant",
    "v0.0",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
) + ACCOUNT_IDS + (SUBSCRIBER_ID,)
ROOT_KEYS = {
    "notice_log_id", "log_status", "cloud_lock_timeouts", "attempts", "statuses",
    "attempts_truncated", "statuses_truncated",
}
ATTEMPT_KEYS = {"attempt_no", "state", "created_at", "wire_at", "http_status"}
STATUS_KEYS = {"attempt_no", "raw_status", "created_at"}
STATES = {"reserved", "wire", "submitted", "refused", "uncertain", "not_sent"}

SEED = """
begin;
insert into cloud_accounts (id, tenant_id, name, phone_number_id, graph_version, token_enc, webhook_secret_enc)
select 'c15c0000-0000-4000-8000-0000000000a1', id, 'cnJournal', 'cj-phone-a1', 'v0.0', 'v1.cj-fixture-token', 'v1.cj-fixture-hook'
from tenants where slug = 'alfa';
insert into cloud_accounts (id, tenant_id, name, phone_number_id, graph_version, token_enc, webhook_secret_enc)
select 'c15c0000-0000-4000-8000-0000000000a2', id, 'cnJournal', 'cj-phone-a2', 'v0.0', 'v1.cj-fixture-token', 'v1.cj-fixture-hook'
from tenants where slug = 'alfa';
insert into cloud_accounts (id, tenant_id, name, phone_number_id, graph_version, token_enc, webhook_secret_enc)
select 'c15c0000-0000-4000-8000-0000000000b1', id, 'cnJournal', 'cj-phone-b1', 'v0.0', 'v1.cj-fixture-token', 'v1.cj-fixture-hook'
from tenants where slug = 'beta';
insert into notice_log (tenant_id, status, cloud_lock_timeouts, error)
select id, 'sent', 2, 'cn-journal-fixture' from tenants where slug = 'alfa';
insert into notice_log (tenant_id, status, cloud_lock_timeouts, error)
select id, 'uncertain', 3, 'cn-journal-fixture' from tenants where slug = 'alfa';
insert into notice_log (tenant_id, status, cloud_lock_timeouts, error)
select id, 'failed', 1, 'cn-journal-fixture' from tenants where slug = 'alfa';
insert into notice_log (tenant_id, status, cloud_lock_timeouts, error)
select id, 'skipped_settled', 0, 'cn-journal-fixture' from tenants where slug = 'alfa';
insert into notice_log (tenant_id, status, cloud_lock_timeouts, error)
select id, 'queued', 0, 'cn-journal-fixture' from tenants where slug = 'beta';
insert into cloud_notice_attempts (
  tenant_id, cloud_account_id, notice_log_id, attempt_no, state, provider_message_id, http_status, excerpt, created_at, wire_at
)
select t.id, 'c15c0000-0000-4000-8000-0000000000a1', l.id, g,
  case when g = 101 then 'submitted'
       else (array['reserved','wire','submitted','refused','uncertain','not_sent'])[1 + ((g - 1) % 6)] end,
  case when g = 101 then 'cj-msg-page' else null end,
  case when g = 101 then 201 when 1 + ((g - 1) % 6) = 2 then 204 else null end,
  'cj-excerpt-secret',
  timestamptz '2026-02-01 00:00:00+00' + (g || ' seconds')::interval,
  case when g = 101 then timestamptz '2026-02-02 03:04:05+00'
       when 1 + ((g - 1) % 6) in (1, 6) then null
       else timestamptz '2026-02-02 01:00:00+00' end
from generate_series(1, 101) g
join tenants t on t.slug = 'alfa'
join notice_log l on l.tenant_id = t.id and l.error = 'cn-journal-fixture' and l.status = 'sent';
insert into cloud_notice_attempts (
  tenant_id, cloud_account_id, notice_log_id, attempt_no, state, excerpt, created_at
)
select t.id, 'c15c0000-0000-4000-8000-0000000000a1', l.id, g, 'not_sent', 'cj-excerpt-secret',
  timestamptz '2026-02-03 00:00:00+00'
from generate_series(1, 101) g
join tenants t on t.slug = 'alfa'
join notice_log l on l.tenant_id = t.id and l.error = 'cn-journal-fixture' and l.status = 'uncertain';
insert into cloud_notice_attempts (
  tenant_id, cloud_account_id, notice_log_id, attempt_no, state, excerpt, created_at
)
select t.id, 'c15c0000-0000-4000-8000-0000000000a1', l.id, g, 'reserved', 'cj-excerpt-secret',
  timestamptz '2026-02-04 00:00:00+00'
from generate_series(1, 100) g
join tenants t on t.slug = 'alfa'
join notice_log l on l.tenant_id = t.id and l.error = 'cn-journal-fixture' and l.status = 'failed';
insert into cloud_notice_attempts (
  tenant_id, cloud_account_id, notice_log_id, attempt_no, state, provider_message_id, excerpt, created_at
)
select t.id, 'c15c0000-0000-4000-8000-0000000000b1', l.id, 1, 'reserved', 'cj-msg-beta', 'cj-excerpt-secret',
  timestamptz '2026-02-05 00:00:00+00'
from tenants t
join notice_log l on l.tenant_id = t.id and l.error = 'cn-journal-fixture' and l.status = 'queued'
where t.slug = 'beta';
insert into cloud_notice_status (id, tenant_id, cloud_account_id, provider_message_id, body_hash, raw_status, created_at)
select ('00000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
  t.id, 'c15c0000-0000-4000-8000-0000000000a1', 'cj-msg-page', lpad(to_hex(g), 64, '0'),
  'cj-raw-' || lpad(g::text, 3, '0'),
  timestamptz '2026-03-01 00:00:00+00' + (g || ' seconds')::interval
from generate_series(1, 99) g
join tenants t on t.slug = 'alfa';
insert into cloud_notice_status (id, tenant_id, cloud_account_id, provider_message_id, body_hash, raw_status, created_at)
select '00000000-0000-4000-8000-0000000000aa', t.id, 'c15c0000-0000-4000-8000-0000000000a1', 'cj-msg-page',
  lpad('aa', 64, 'a'), 'cj-raw-tie-lo', timestamptz '2026-03-01 00:00:00+00' + interval '1000 seconds'
from tenants t where t.slug = 'alfa';
insert into cloud_notice_status (id, tenant_id, cloud_account_id, provider_message_id, body_hash, raw_status, created_at)
select '00000000-0000-4000-8000-0000000000bb', t.id, 'c15c0000-0000-4000-8000-0000000000a1', 'cj-msg-page',
  lpad('bb', 64, 'b'), 'cj-raw-tie-hi', timestamptz '2026-03-01 00:00:00+00' + interval '1000 seconds'
from tenants t where t.slug = 'alfa';
insert into cloud_notice_status (tenant_id, cloud_account_id, provider_message_id, body_hash, raw_status, created_at)
select t.id, 'c15c0000-0000-4000-8000-0000000000a1', 'cj-msg-unlinked', lpad('cc', 64, 'c'),
  'cj-raw-unlinked', timestamptz '2090-01-01 00:00:00+00'
from tenants t where t.slug = 'alfa';
insert into cloud_notice_status (tenant_id, cloud_account_id, provider_message_id, body_hash, raw_status, created_at)
select t.id, 'c15c0000-0000-4000-8000-0000000000a2', 'cj-msg-page', lpad('dd', 64, 'd'),
  'cj-raw-foreign-account', timestamptz '2090-01-01 00:00:00+00'
from tenants t where t.slug = 'alfa';
insert into cloud_notice_status (tenant_id, cloud_account_id, provider_message_id, body_hash, raw_status, created_at)
select t.id, 'c15c0000-0000-4000-8000-0000000000b1', 'cj-msg-beta', lpad('ee', 64, 'e'),
  'cj-raw-other-tenant', timestamptz '2090-01-01 00:00:00+00'
from tenants t where t.slug = 'beta';
select json_build_object(
  'full', (select id::text from notice_log where error = 'cn-journal-fixture' and status = 'sent'),
  'busy', (select id::text from notice_log where error = 'cn-journal-fixture' and status = 'uncertain'),
  'exact', (select id::text from notice_log where error = 'cn-journal-fixture' and status = 'failed'),
  'empty', (select id::text from notice_log where error = 'cn-journal-fixture' and status = 'skipped_settled'),
  'beta', (select id::text from notice_log where error = 'cn-journal-fixture' and status = 'queued'),
  'active', (select coalesce(json_agg(active order by id), '[]'::json) from cloud_accounts where name = 'cnJournal')
);
commit;
"""


def clean_subscriber_fixtures(sql):
    sql(
        "delete from users where email in ("
        + quote(SUBSCRIBER)
        + ", 'cn-collision@alfa.demo', 'cn-collision-plpgsql@alfa.demo') "
        "or subscriber_id = "
        + quote(SUBSCRIBER_ID)
        + "::uuid;"
        "delete from subscribers where id = "
        + quote(SUBSCRIBER_ID)
        + "::uuid;",
        "nexo_test",
    )


def prove_cloud_journal(call, sql, one):
    """Fixtures inativas no banco do runner. GET não grava e não devolve segredo."""
    journal_go = (ROOT / "apps/api-go/internal/modules/leitura/cloud_notice_journal.go").read_text()
    assert "actor.PopIDs != nil" in journal_go
    assert "actor.Support" in journal_go
    assert 'actor.SubscriberID != ""' in journal_go
    assert "insert " not in cloud_journal_sql(journal_go)
    clean_subscriber_fixtures(sql)
    alfa_modules = one("select modules::text as modules from tenants where slug = 'alfa'")["modules"]
    preexisting = json.loads(sql(
        "select coalesce(json_agg(id::text) filter (where support_tenant_id is not null), '[]') "
        "from sessions where user_id = (select id from users where email = " + quote(OPERATOR) + ")",
        "nexo_test",
    ))
    sql(
        "update tenants t set modules = t.modules || array['messages']::text[] "
        "where t.slug = 'alfa' and not ('messages' = any(t.modules))",
        "nexo_test",
    )
    try:
        seeded = json.loads(sql(SEED, "nexo_test"))
        assert seeded["active"] == [False, False, False], seeded["active"]
        for key in ("full", "busy", "exact", "empty", "beta"):
            assert seeded[key] and str(int(seeded[key])) == seeded[key], seeded[key]
        try:
            exercise_cloud_journal(call, sql, one, seeded)
        finally:
            remove_cloud_journal_fixtures(sql)
    finally:
        restore_operator_support(sql, preexisting)
        sql(
            "update tenants set modules = " + quote(alfa_modules) + "::text[] where slug = 'alfa'",
            "nexo_test",
        )
        clean_subscriber_fixtures(sql)


def cloud_journal_sql(source):
    start = source.index("const cloudNoticeJournalSQL = `")
    body = source[start:].split("`", 2)[1]
    return body.lower()


def login(call, email):
    response = call("/api/auth/login", {"email": email, "password": "demo1234", "bearer": True})
    assert response["status"] == 200, response["status"]
    token = response["json"].get("token")
    assert token, response["status"]
    return token


def journal_get(call, token, path):
    return call(path, method="GET", token=token)


def surface(response):
    raw = response.get("body") or b""
    text = raw.decode("utf-8", "replace")
    for marker in POISON:
        assert marker not in text, response["status"]
    return text


def assert_journal(payload, notice_id, status, timeouts, attempt_numbers, statuses, attempts_truncated, statuses_truncated):
    assert set(payload) == ROOT_KEYS, sorted(payload)
    assert payload["notice_log_id"] == notice_id and isinstance(payload["notice_log_id"], str)
    assert payload["log_status"] == status
    assert payload["cloud_lock_timeouts"] == timeouts
    assert payload["attempts_truncated"] is attempts_truncated
    assert payload["statuses_truncated"] is statuses_truncated
    assert [row["attempt_no"] for row in payload["attempts"]] == attempt_numbers
    raws = []
    for row in payload["attempts"]:
        assert set(row) == ATTEMPT_KEYS, sorted(row)
        assert row["state"] in STATES and row["attempt_no"] > 0
        assert isinstance(row["created_at"], str) and row["created_at"].endswith("Z") and "T" in row["created_at"]
        assert row["wire_at"] is None or (isinstance(row["wire_at"], str) and row["wire_at"].endswith("Z"))
        assert row["http_status"] is None or 100 <= row["http_status"] <= 599
    for row in payload["statuses"]:
        assert set(row) == STATUS_KEYS, sorted(row)
        assert row["attempt_no"] > 0 and isinstance(row["raw_status"], str) and 1 <= len(row["raw_status"]) <= 300
        assert isinstance(row["created_at"], str) and row["created_at"].endswith("Z")
        raws.append(row["raw_status"])
    assert raws == statuses


def fingerprint(one):
    return one(
        "select (select count(*) from cloud_accounts) as accounts,"
        " (select count(*) filter (where active) from cloud_accounts) as active_accounts,"
        " (select count(*) from cloud_notice_attempts) as attempts,"
        " (select count(*) from cloud_notice_status) as statuses,"
        " (select count(*) from notice_log) as notices,"
        " (select count(*) from payments) as payments,"
        " (select coalesce(sum(signed_cents), 0) from payments) as signed_cents,"
        " (select count(*) from invoices) as invoices,"
        " (select count(*) from invoice_movements) as movements,"
        " (select md5(coalesce(string_agg(id::text || status || cloud_lock_timeouts::text || attempts::text, ',' order by id), '')) from notice_log) as notice_hash,"
        " (select md5(coalesce(string_agg(id::text || state || attempt_no::text || coalesce(http_status::text, '') || coalesce(excerpt, ''), ',' order by id), '')) from cloud_notice_attempts) as attempt_hash,"
        " (select md5(coalesce(string_agg(id::text || raw_status || body_hash, ',' order by id), '')) from cloud_notice_status) as status_hash"
    )


def exercise_cloud_journal(call, sql, one, seeded):
    assert str(uuid.UUID(SUBSCRIBER_ID)) == SUBSCRIBER_ID
    admin = login(call, "admin@alfa.demo")
    attendant = login(call, "atendimento@alfa.demo")
    operator = login(call, OPERATOR)
    sql(
        "insert into subscribers (id, tenant_id, name) "
        "select " + quote(SUBSCRIBER_ID) + "::uuid, id, 'CN journal fixture subscriber' "
        "from tenants where slug = 'alfa';"
        "insert into users (tenant_id, email, name, password_hash, role, subscriber_id) "
        "select t.id, " + quote(SUBSCRIBER) + ", 'CN journal', u.password_hash, 'subscriber', " + quote(SUBSCRIBER_ID) + "::uuid "
        "from tenants t join users u on u.email = 'admin@alfa.demo' where t.slug = 'alfa';",
        "nexo_test",
    )
    # Prova dirigida da colisão users_subscriber_uq (migration 00004, linha 11):
    # O banco deve rejeitar um segundo usuário para o mesmo assinante
    # disparando exatamente a restrição users_subscriber_uq.
    # 1. Prova via PL/pgSQL capturando o nome exato da restrição violada
    sql(
        "do $$ declare v_con text; begin "
        "begin "
        "insert into users (tenant_id, email, name, password_hash, role, subscriber_id) "
        "select t.id, 'cn-collision-plpgsql@alfa.demo', 'CN collision', u.password_hash, 'subscriber', " + quote(SUBSCRIBER_ID) + "::uuid "
        "from tenants t join users u on u.email = 'admin@alfa.demo' where t.slug = 'alfa'; "
        "raise exception 'users_subscriber_uq nao disparou'; "
        "exception when unique_violation then "
        "get stacked diagnostics v_con = CONSTRAINT_NAME; "
        "if v_con <> 'users_subscriber_uq' then "
        "raise exception 'violacao inesperada em vez de users_subscriber_uq: %', v_con; "
        "end if; "
        "end; end $$;",
        "nexo_test",
    )
    # 2. Prova direta no cliente psql via chamada externa com assert na mensagem de erro
    collision_failed = False
    try:
        sql(
            "insert into users (tenant_id, email, name, password_hash, role, subscriber_id) "
            "select t.id, 'cn-collision@alfa.demo', 'CN collision', u.password_hash, 'subscriber', " + quote(SUBSCRIBER_ID) + "::uuid "
            "from tenants t join users u on u.email = 'admin@alfa.demo' where t.slug = 'alfa'",
            "nexo_test",
        )
    except subprocess.CalledProcessError as exc:
        collision_failed = True
        err_msg = (exc.stderr or "") + (exc.stdout or "")
        assert "users_subscriber_uq" in err_msg, err_msg
    assert collision_failed, "inserção duplicada de assinante em users deve violar users_subscriber_uq"
    assert int(one("select count(*) as n from users where subscriber_id = " + quote(SUBSCRIBER_ID))["n"]) == 1
    subscriber = login(call, SUBSCRIBER)
    sql(
        "update sessions set support_tenant_id = (select id from tenants where slug = 'alfa') "
        "where user_id = (select id from users where email = " + quote(OPERATOR) + ") "
        "and support_tenant_id is null",
        "nexo_test",
    )
    before = fingerprint(one)
    assert int(before["accounts"]) == 3 and int(before["active_accounts"]) == 0, before
    assert int(before["attempts"]) == 303 and int(before["statuses"]) == 104, before
    full_id = seeded["full"]
    path = "/api/notice-log/" + full_id + "/cloud-journal"
    denied = journal_get(call, None, path)
    assert denied["status"] == 401, denied["status"]
    surface(denied)
    for token in (attendant, subscriber):
        blocked = journal_get(call, token, path)
        assert blocked["status"] == 403 and blocked["json"].get("error") == "sem permissão para esta ação", blocked.get("json")
        surface(blocked)
    support = journal_get(call, operator, path)
    assert support["status"] == 403 and support["json"].get("error") == "o histórico Cloud exige escopo integral do provedor, fora do suporte", support.get("json")
    surface(support)
    for bad in ("0", "0001", "-1", "1.2", "9223372036854775808"):
        rejected = journal_get(call, admin, "/api/notice-log/" + bad + "/cloud-journal")
        assert rejected["status"] == 400, (bad, rejected["status"])
        surface(rejected)
    for query, status in (("?page=1", 400), ("?a=1&a=2", 400), ("?a=%ZZ", 400)):
        rejected = journal_get(call, admin, path + query)
        assert rejected["status"] == status, (query, rejected["status"])
        surface(rejected)
    full = journal_get(call, admin, path)
    assert full["status"] == 200, full.get("json")
    surface(full)
    assert_journal(
        full["json"], full_id, "sent", 2, list(range(101, 1, -1)),
        ["cj-raw-tie-hi", "cj-raw-tie-lo"] + ["cj-raw-" + str(i).zfill(3) for i in range(99, 1, -1)],
        True, True,
    )
    assert full["json"]["statuses"][0]["created_at"] == full["json"]["statuses"][1]["created_at"]
    assert full["json"]["statuses"][1]["created_at"] > full["json"]["statuses"][2]["created_at"]
    assert {row["attempt_no"] for row in full["json"]["statuses"]} == {101}
    assert {row["state"] for row in full["json"]["attempts"]} == STATES
    sent = next(row for row in full["json"]["attempts"] if row["attempt_no"] == 101)
    assert sent["state"] == "submitted" and sent["http_status"] == 201 and sent["wire_at"].startswith("2026-02-02T03:04:05")
    reserved = next(row for row in full["json"]["attempts"] if row["attempt_no"] == 7)
    assert reserved["state"] == "reserved" and reserved["wire_at"] is None and reserved["http_status"] is None
    busy = journal_get(call, admin, "/api/notice-log/" + seeded["busy"] + "/cloud-journal")
    assert busy["status"] == 200, busy["status"]
    surface(busy)
    assert_journal(busy["json"], seeded["busy"], "uncertain", 3, list(range(101, 1, -1)), [], True, False)
    exact = journal_get(call, admin, "/api/notice-log/" + seeded["exact"] + "/cloud-journal")
    assert exact["status"] == 200, exact["status"]
    surface(exact)
    assert_journal(exact["json"], seeded["exact"], "failed", 1, list(range(100, 0, -1)), [], False, False)
    empty = journal_get(call, admin, "/api/notice-log/" + seeded["empty"] + "/cloud-journal")
    assert empty["status"] == 200, empty["status"]
    surface(empty)
    assert_journal(empty["json"], seeded["empty"], "skipped_settled", 0, [], [], False, False)
    missing = journal_get(call, admin, "/api/notice-log/9223372036854775807/cloud-journal")
    other = journal_get(call, admin, "/api/notice-log/" + seeded["beta"] + "/cloud-journal")
    assert missing["status"] == 404 and other["status"] == 404, (missing["status"], other["status"])
    assert missing["json"] == other["json"] and missing["json"].get("error") == "aviso não encontrado"
    assert seeded["beta"].encode() not in (other.get("body") or b"")
    surface(missing)
    surface(other)
    posted = call(path, {}, method="POST", token=admin)
    assert posted["status"] >= 400, posted["status"]
    surface(posted)
    again = journal_get(call, admin, path)
    assert again["status"] == 200 and again["json"] == full["json"]
    after = fingerprint(one)
    assert after == before, (before, after)


def remove_cloud_journal_fixtures(sql):
    removed = sql(
        "with gone as (delete from notice_log where error = " + quote(MARKER) + " returning id) "
        "select count(*) from gone",
        "nexo_test",
    )
    retained = {}
    for slug in ("alfa", "beta"):
        retained[slug] = sql(
            "select set_config('app.tenant_id', (select id::text from tenants where slug = " + quote(slug) + "), false);"
            "select set_config('app.subscriber_id', '', false);"
            "select cloud_notice_retain_expired(timestamptz '2100-01-01+00');",
            "nexo_test",
        ).splitlines()[-1]
    sql(
        "delete from cloud_accounts where id in (" + ",".join(quote(item) for item in ACCOUNT_IDS) + ")",
        "nexo_test",
    )
    left = sql(
        "select (select count(*) from cloud_accounts) || ',' ||"
        " (select count(*) from cloud_notice_attempts) || ',' ||"
        " (select count(*) from cloud_notice_status) || ',' ||"
        " (select count(*) from notice_log where error = " + quote(MARKER) + ")",
        "nexo_test",
    )
    assert removed == "5" and retained == {"alfa": "103", "beta": "1"} and left == "0,0,0,0", (removed, retained, left)


def restore_operator_support(sql, preexisting):
    kept = "array[" + ",".join(quote(item) for item in preexisting) + "]::uuid[]" if preexisting else "array[]::uuid[]"
    sql(
        "update sessions set support_tenant_id = null "
        "where user_id = (select id from users where email = " + quote(OPERATOR) + ") "
        "and support_tenant_id is not null and not (id = any(" + kept + "))",
        "nexo_test",
    )
