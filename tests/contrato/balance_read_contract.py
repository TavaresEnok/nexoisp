"""Gate B04-I1 da leitura de saldo, chamado por nativo.py.

Não é um runner. Não liga allowlist, não altera centavos e não executa EXPLAIN.
PostgreSQL real e EXPLAIN ANALYZE continuam pendentes para a gerência.
Um skip não aprova esses dois itens.
"""
import json
from pathlib import Path

from lib import quote

ROOT = Path(__file__).resolve().parents[2]
EXPLAIN_ANALYZE = "pending"


def verify(api, call, sql):
    if EXPLAIN_ANALYZE != "pending":
        raise AssertionError("EXPLAIN ANALYZE não está aceito nesta entrega")

    def records(query):
        return json.loads(sql("select coalesce(json_agg(r),'[]') from (" + query + ") r", "nexo_test"))

    def one(query):
        found = records(query)
        assert len(found) == 1, found
        return found[0]

    def reject_cmp(value, path):
        if isinstance(value, dict):
            for key, item in value.items():
                assert not str(key).startswith("cmp_"), (path, key)
                reject_cmp(item, path + "." + str(key))
        elif isinstance(value, list):
            for index, item in enumerate(value):
                reject_cmp(item, "%s[%d]" % (path, index))

    def get(path):
        response = api(path)
        assert response["status"] == 200, (path, response.get("json"))
        reject_cmp(response["json"], path)
        return response["json"]

    core = (ROOT / "apps/api-go/internal/modules/leitura/balance_read.go").read_text()
    assert "func productionShadowAllowlist() map[string]struct{} { return map[string]struct{}{} }" in core
    assert "func productionCutAllowlist() map[string]struct{} { return map[string]struct{}{} }" in core
    due = (ROOT / "apps/api-go/internal/modules/leitura/due_http.go").read_text()
    assert 'return duePolicy{mode: "off", shadowAllow: map[string]struct{}{}, cutAllow: map[string]struct{}{}, variants: map[string]string{}}' in due

    sample = one(
        "select i.id::text as invoice_id, i.contract_id::text as contract_id, i.tenant_id::text as tenant_id, "
        "i.subscriber_id::text as subscriber_id, c.pop_id::text as pop_id, "
        "coalesce((select sum(p.signed_cents) from payments p where p.invoice_id=i.id),0)::bigint as signed_cents "
        "from invoices i join contracts c on c.id=i.contract_id "
        "join financial_balance_shadow s on s.invoice_id=i.id "
        "where s.matches and c.pop_id is not null limit 1"
    )
    beta = call("/api/auth/login", {"email": "admin@beta.demo", "password": "demo1234", "bearer": True})
    assert beta["status"] == 200 and beta["json"].get("token"), beta["json"]
    hidden = call("/api/invoices/" + sample["invoice_id"], token=beta["json"]["token"])
    assert hidden["status"] == 404, hidden["json"]
    reject_cmp(hidden["json"], "beta-invoice")
    detail = get("/api/invoices/" + sample["invoice_id"])
    assert detail.get("status") and "paid_cents" in detail and "cmp_matches" not in detail
    assert int(detail["paid_cents"]) == int(sample["signed_cents"])
    assert abs(int(detail["paid_cents"])) <= 2147483647
    due_body = get("/api/invoices/" + sample["invoice_id"] + "/due")
    for key in ("status", "amount_cents", "paid_cents", "remaining_cents", "fine_cents", "interest_cents", "fee_if_applied_cents"):
        assert key in due_body, (key, due_body)
    assert "cmp_fee_cents" not in due_body
    finance = get("/api/contracts/" + sample["contract_id"] + "/finance")
    assert "open_cents" in finance and isinstance(finance["invoices"], list)
    summary = get("/api/finance/summary")
    assert "open_cents" in summary and "overdue_cents" in summary and "received_month_cents" in summary
    reconciliation = get("/api/finance/reconciliation")
    assert isinstance(reconciliation.get("invoices"), list) and reconciliation["invoices"], reconciliation
    invoices = get("/api/invoices?limit=5")
    assert isinstance(invoices, list) and invoices
    today = get("/api/today")
    assert isinstance(today, dict) and isinstance(today.get("items"), list)
    quote_body = get("/api/contracts/" + sample["contract_id"] + "/termination-quote")
    assert "open_invoices_cents" in quote_body and "total_cents" in quote_body

    census = one(
        "select count(*) filter (where status='open') as open_n,"
        " count(*) filter (where status='paid') as paid_n,"
        " count(*) filter (where status='reconciling') as reconciling_n,"
        " count(*) filter (where status='canceled') as canceled_n,"
        " count(*) filter (where received_cents>0 and residual_cents>0) as partial_n,"
        " count(*) filter (where excess_cents>0) as excess_n,"
        " count(*) as matched_formula"
        " from financial_balance_shadow"
        " where matches"
        " and residual_cents = greatest(0, nominal_cents + fee_cents - discount_cents - received_cents)"
        " and excess_cents = greatest(0, received_cents - (nominal_cents + fee_cents - discount_cents))"
        " and collectible_cents = case when status='canceled' then 0 else residual_cents end"
    )
    for key in ("open_n", "paid_n", "reconciling_n", "canceled_n", "partial_n", "excess_n", "matched_formula"):
        assert int(census[key]) > 0, (key, census)
    total = one("select count(*) as n from financial_balance_shadow")
    assert int(total["n"]) == int(census["matched_formula"])
    assert int(one("select count(*) as n from financial_balance_shadow where not matches")["n"]) == 0
    assert int(one("select count(*) as n from payments where kind='reversal'")["n"]) > 0
    assert int(one("select count(*) as n from financial_agreement_shadow where matches and not source_unproven and source_cents>0")["n"]) > 0
    assert int(one("select count(*) as n from import_batch_compensations")["n"]) > 0

    movements = json.loads((ROOT / "tests/contrato/relatorios/financial-movements.json").read_text())
    for text in (
        "signed reversal restores residual",
        "tenant portal and POP restrictions",
        "shadow detects synthetic drift",
        "source_unproven",
    ):
        assert any(text in item for item in movements["checks"]), text
    assert not records("select id from agreements where reason='B04 gate source unproven'")
    provider = json.loads((ROOT / "tests/contrato/relatorios/provider-contract.json").read_text())
    assert any("refund" in item or "chargeback" in item for item in provider["checks"]), provider["checks"]

    other = one("select id::text as id from tenants where id<>" + quote(sample["tenant_id"]) + " limit 1")
    random_pop = "00000000-0000-4000-8000-00000000b041"
    random_subscriber = "00000000-0000-4000-8000-00000000b042"

    def scoped(extra):
        statement = (
            "begin;set local role nexo_app;"
            "select set_config('app.tenant_id'," + quote(sample["tenant_id"]) + ",true);"
            + extra +
            "select count(*) from financial_balance_shadow where invoice_id=" + quote(sample["invoice_id"]) + "::uuid;"
            "rollback;"
        )
        return sql(statement, "nexo_test").splitlines()[-1]

    assert scoped("") == "1"
    assert scoped("select set_config('app.subscriber_id'," + quote(random_subscriber) + ",true);") == "0"
    assert scoped("select set_config('app.subscriber_id'," + quote(sample["subscriber_id"]) + ",true);") == "1"
    assert scoped("select set_config('app.pop_ids'," + quote(random_pop) + ",true);") == "0"
    assert scoped("select set_config('app.pop_ids'," + quote(sample["pop_id"]) + ",true);") == "1"
    assert sql(
        "begin;set local role nexo_app;select set_config('app.tenant_id'," + quote(other["id"]) + ",true);"
        "select count(*) from invoice_movements where invoice_id=" + quote(sample["invoice_id"]) + "::uuid;rollback;",
        "nexo_test",
    ).splitlines()[-1] == "0"

    # A sentença dedicada e o plano não foram executados aqui.
    assert "explain" not in EXPLAIN_ANALYZE
    assert (ROOT / "apps/api-go/internal/modules/leitura/queries/balance_shadow_compare.sql").is_file()
