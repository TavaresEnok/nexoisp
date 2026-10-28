"""Reconciliação somente leitura de um lote importado contra o estado atual do Nexo.
Chamado por nativo.py. Não altera o lote; a baixa manual é uma ação já existente.
"""
import json
import uuid
from lib import quote


def verify(api, call, sql):
    def records(q):
        return json.loads(sql("select coalesce(json_agg(r),'[]') from (" + q + ") r", 'nexo_test'))

    def cell(value):
        text = str(value)
        if any(ch in text for ch in ';"\r\n'):
            return '"' + text.replace('"', '""') + '"'
        return text

    def money(value):
        assert isinstance(value, str) and value.isdigit(), value
        return value

    def whole(value):
        assert isinstance(value, int) and not isinstance(value, bool), value
        return value

    marker = 'b13r-' + uuid.uuid4().hex
    open_ext, paid_ext, cancel_ext = marker + '-open', marker + '-paid', marker + '-cancel'
    sub_name = 'Assinante ' + marker
    restricted, pop = str(uuid.uuid4()), str(uuid.uuid4())
    tenants = {row['email']: row for row in records("select tenant_id::text as tenant_id, email from users where email in ('admin@alfa.demo','admin@beta.demo')")}
    alfa = tenants['admin@alfa.demo']['tenant_id']

    def apply(kind, csv):
        response = api('/api/import/apply', {'kind': kind, 'source': marker, 'csv': csv})
        assert response['status'] == 200, response['json']
        body = response['json']
        assert body['applied'] is True and body['totals']['error'] == 0, body
        return body

    def recon(batch_id, query=''):
        return api('/api/import/batches/' + batch_id + '/reconciliation' + query)

    try:
        bad = api('/api/import/batches/not-a-uuid/reconciliation')
        assert bad['status'] == 400, bad['json']
        plans = api('/api/plans')
        assert plans['status'] == 200 and plans['json'], plans['json']
        plan = next(item['name'] for item in plans['json'] if item.get('active') is not False)
        subscribers = apply('subscribers', '\n'.join([
            'id_externo;nome;situacao;plano;vencimento_dia',
            ';'.join([cell(marker), cell(sub_name), 'ativo', cell(plan), '10']),
        ]) + '\n')
        assert subscribers['totals']['created'] == 1, subscribers['totals']
        invoices = apply('invoices', '\n'.join([
            'id_externo;id_externo_assinante;vencimento;valor;situacao;pago_em;valor_pago',
            ';'.join([open_ext, marker, '2026-10-20', '99,90', 'aberto', '', '']),
            ';'.join([paid_ext, marker, '2026-10-05', '80,00', 'pago', '2026-10-05', '80,00']),
            ';'.join([cancel_ext, marker, '2026-09-10', '50,00', 'cancelado', '', '']),
        ]) + '\n')
        assert invoices['totals']['created'] == 3, invoices['totals']
        batch_id = invoices['batch_id']
        subscriber_batch = subscribers['batch_id']
        contract_id = records("select id::text as id from contracts where external_source=" + quote(marker))[0]['id']
        open_id = next(row['entity_id'] for row in invoices['sample'] if row['external_id'] == open_ext)

        unknown = recon(batch_id, '?tenant=other')
        assert unknown['status'] == 400 and unknown['json']['error'] == 'filtro desconhecido', unknown['json']
        repeated = recon(batch_id, '?x=1&x=2')
        assert repeated['status'] == 400 and repeated['json']['error'] == 'filtro repetido', repeated['json']

        page = recon(batch_id)
        assert page['status'] == 200, page['json']
        assert page['headers']['cache-control'] == 'no-store'
        body = page['json']
        assert body['source'] == 'import_rows'
        assert body['contracts'] is None
        assert body['evidence'] == {'snapshot': False, 'note': 'estado atual do Nexo; não comprova saldo na instituição de origem'}
        assert isinstance(body['generated_at'], str) and body['generated_at'].endswith('Z')
        assert body['batch']['id'] == batch_id and body['batch']['kind'] == 'invoices' and body['batch']['source'] == marker
        assert body['batch']['filename'] is None and isinstance(body['batch']['created_at'], str)
        assert body['rows'] == {'created': 3, 'updated': 0, 'unchanged': 0, 'error': 0, 'with_messages': 0}
        inv = body['invoices']
        assert whole(inv['count']) == 3 and whole(inv['missing']) == 0
        assert inv['by_status'] == {'open': 1, 'paid': 1, 'reconciling': 0, 'canceled': 1}
        for key in ('open', 'paid', 'reconciling', 'canceled'):
            whole(inv['by_status'][key])
        assert money(inv['amount_cents']) == '22990'
        assert money(inv['received_cents']) == '8000'
        assert money(inv['received_after_import_cents']) == '0'
        assert money(inv['open_residual_cents']) == '9990'
        assert whole(inv['legacy_issuance_violations']) == 0
        canceled = records(
            "select (count(*) filter (where i.status='canceled' and i.canceled_at > b.created_at))::int as n "
            "from import_batches b join import_rows ir on ir.batch_id=b.id and ir.status='created' "
            "join invoices i on i.id=ir.entity_id and i.tenant_id=ir.tenant_id "
            "where b.id=" + quote(batch_id) + "::uuid")[0]['n']
        assert whole(inv['canceled_after_import']) == canceled
        assert len(inv['by_contract']) == 1
        assert inv['by_contract'][0]['contract_id'] == contract_id
        assert whole(inv['by_contract'][0]['invoices']) == 3
        assert money(inv['by_contract'][0]['open_residual_cents']) == '9990'

        manual = api('/api/invoices/' + open_id + '/manual-payment', {
            'intent_id': str(uuid.uuid4()),
            'amount_cents': 9990,
            'paid_at': '2026-10-18',
            'note': 'Baixa posterior no Nexo',
        })
        assert manual['status'] == 200 and manual['json']['status'] == 'paid', manual['json']
        after = recon(batch_id)
        assert after['status'] == 200, after['json']
        paid = after['json']['invoices']
        assert paid['by_status'] == {'open': 0, 'paid': 2, 'reconciling': 0, 'canceled': 1}
        assert money(paid['amount_cents']) == '22990'
        assert money(paid['received_cents']) == '17990'
        assert money(paid['received_after_import_cents']) == '9990'
        assert money(paid['open_residual_cents']) == '0'
        assert whole(paid['legacy_issuance_violations']) == 0
        assert whole(paid['canceled_after_import']) == canceled
        assert paid['by_contract'][0]['contract_id'] == contract_id
        assert whole(paid['by_contract'][0]['invoices']) == 3
        assert money(paid['by_contract'][0]['open_residual_cents']) == '0'

        people = recon(subscriber_batch)
        assert people['status'] == 200 and people['headers']['cache-control'] == 'no-store', people['json']
        linked = people['json']
        assert linked['invoices'] is None and linked['source'] == 'import_rows'
        assert linked['batch']['kind'] == 'subscribers' and linked['batch']['id'] == subscriber_batch
        assert linked['rows']['created'] == 1 and linked['rows']['error'] == 0
        assert whole(linked['contracts']['entities_created']) == 1
        assert linked['contracts']['contracts_by_status'].get('active') == 1
        assert sum(linked['contracts']['contracts_by_status'].values()) == 1
        assert whole(linked['contracts']['resources_pending_provision']) == 0
        assert linked['evidence']['snapshot'] is False

        beta_login = call('/api/auth/login', {'email': 'admin@beta.demo', 'password': 'demo1234', 'bearer': True})
        assert beta_login['status'] == 200, beta_login['json']
        hidden = call('/api/import/batches/' + batch_id + '/reconciliation', token=beta_login['json']['token'])
        assert hidden['status'] == 404, hidden['json']
        sql(
            "insert into pops(id,tenant_id,name) values(" + quote(pop) + "," + quote(alfa) + "," + quote('POP ' + marker[:20]) + ");"
            "insert into users(id,tenant_id,email,name,password_hash,role) select " + quote(restricted) + ",tenant_id," + quote(marker + '@synthetic.invalid') + ",'Batch POP fixture',password_hash,'noc' from users where email='admin@alfa.demo';"
            "insert into user_pops(tenant_id,user_id,pop_id) values(" + quote(alfa) + "," + quote(restricted) + "," + quote(pop) + ")",
            'nexo_test')
        pop_login = call('/api/auth/login', {'email': marker + '@synthetic.invalid', 'password': 'demo1234', 'bearer': True})
        assert pop_login['status'] == 200, pop_login['json']
        denied = call('/api/import/batches/' + batch_id + '/reconciliation', token=pop_login['json']['token'])
        assert denied['status'] == 403, denied['json']
        return {'ok': True, 'checks': ['lote de títulos com saldo exato', 'baixa posterior entra no recebido após importação', 'invariante de legado zerado', 'lote de assinantes sem faturas', 'outro tenant 404', 'POP 403', 'filtros recusados']}
    finally:
        sql(
            "begin;"
            "alter table payments disable trigger immutable_payments;"
            "alter table invoice_movements disable trigger immutable_invoice_movements;"
            "delete from manual_payment_intents where invoice_id in (select id from invoices where external_source=" + quote(marker) + ");"
            "delete from payments where invoice_id in (select id from invoices where external_source=" + quote(marker) + ");"
            "delete from invoice_items where invoice_id in (select id from invoices where external_source=" + quote(marker) + ");"
            "delete from invoice_movements where invoice_id in (select id from invoices where external_source=" + quote(marker) + ");"
            "delete from payment_effects where invoice_id in (select id from invoices where external_source=" + quote(marker) + ");"
            "delete from agreement_sources where invoice_id in (select id from invoices where external_source=" + quote(marker) + ");"
            "delete from invoices where external_source=" + quote(marker) + ";"
            "alter table payments enable trigger immutable_payments;"
            "alter table invoice_movements enable trigger immutable_invoice_movements;"
            "delete from contract_history where contract_id in (select id from contracts where external_source=" + quote(marker) + ");"
            "delete from contracts where external_source=" + quote(marker) + ";"
            "delete from subscribers where external_source=" + quote(marker) + ";"
            "delete from audit_events where entity_type='import_batch' and entity_id in (select id::text from import_batches where source=" + quote(marker) + ");"
            "delete from import_rows where batch_id in (select id from import_batches where source=" + quote(marker) + ");"
            "delete from import_batches where source=" + quote(marker) + ";"
            "delete from user_pops where user_id=" + quote(restricted) + "::uuid;"
            "delete from sessions where user_id=" + quote(restricted) + "::uuid;"
            "delete from users where id=" + quote(restricted) + "::uuid;"
            "delete from pops where id=" + quote(pop) + "::uuid;"
            "commit;",
            'nexo_test')
