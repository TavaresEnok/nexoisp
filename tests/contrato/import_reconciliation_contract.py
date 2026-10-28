"""Reimportação de títulos legados: no-op idêntico e divergências explicadas.
Chamado por nativo.py. Não altera o título já importado nem cria pagamento.
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

    def line(body, ext):
        found = [row for row in body['sample'] if row.get('external_id') == ext]
        assert len(found) == 1, (ext, body['sample'])
        return found[0]

    def no_conflicts(body):
        assert body['totals'].get('conflicts', 0) in (0, 0.0), body['totals']

    marker = 'b13-' + uuid.uuid4().hex[:8]
    open_ext, paid_ext, cancel_ext = marker + '-open', marker + '-paid', marker + '-cancel'
    sub_name = 'Assinante ' + marker

    def invoices_csv(open_status='aberto', open_value='99,90', open_due='2026-10-20', open_paid_at='', open_paid=''):
        rows = [
            'id_externo;id_externo_assinante;vencimento;valor;situacao;pago_em;valor_pago',
            ';'.join([open_ext, marker, open_due, open_value, open_status, open_paid_at, open_paid]),
            ';'.join([paid_ext, marker, '2026-10-05', '80,00', 'pago', '2026-10-05', '80,00']),
            ';'.join([cancel_ext, marker, '2026-09-10', '50,00', 'cancelado', '', '']),
        ]
        return '\n'.join(rows) + '\n'

    def apply(kind, csv):
        response = api('/api/import/apply', {'kind': kind, 'source': marker, 'csv': csv})
        assert response['status'] == 200, response['json']
        body = response['json']
        assert body['applied'] is True, body
        assert body['totals']['error'] == 0, body
        return body

    def state():
        return {row['external_id']: row for row in records(
            "select external_id, status, amount_cents, due_date::text as due_date, "
            "(select count(*)::int from payments p where p.invoice_id = i.id) as payments "
            "from invoices i where external_source=" + quote(marker))}

    original = invoices_csv()
    try:
        plans = api('/api/plans')
        assert plans['status'] == 200 and plans['json'], plans['json']
        plan = next(item['name'] for item in plans['json'] if item.get('active') is not False)
        subscribers = apply('subscribers', '\n'.join([
            'id_externo;nome;situacao;plano;vencimento_dia',
            ';'.join([cell(marker), cell(sub_name), 'ativo', cell(plan), '10']),
        ]) + '\n')
        assert subscribers['totals']['created'] == 1, subscribers['totals']
        assert subscribers['totals']['contracts_created'] == 1, subscribers['totals']
        first = apply('invoices', original)
        assert first['totals']['created'] == 3, first['totals']
        assert first['totals']['invoices_paid'] == 1, first['totals']
        assert first['totals']['invoices_canceled'] == 1, first['totals']
        no_conflicts(first)
        assert all(row['messages'] == [] for row in first['sample']), first['sample']
        open_id = line(first, open_ext)['entity_id']
        paid_id = line(first, paid_ext)['entity_id']
        cancel_id = line(first, cancel_ext)['entity_id']
        loaded = state()
        assert loaded[open_ext] == {'external_id': open_ext, 'status': 'open', 'amount_cents': 9990, 'due_date': '2026-10-20', 'payments': 0}, loaded
        assert loaded[paid_ext]['status'] == 'paid' and loaded[paid_ext]['payments'] == 1 and loaded[paid_ext]['amount_cents'] == 8000
        assert loaded[cancel_ext]['status'] == 'canceled' and loaded[cancel_ext]['payments'] == 0
        same = apply('invoices', original)
        assert same['totals']['created'] == 0 and same['totals']['unchanged'] == 3, same['totals']
        assert same['rows'] == []
        no_conflicts(same)
        assert all(row['status'] == 'unchanged' and row['messages'] == [] for row in same['sample']), same['sample']
        assert state() == loaded
        paid_origin = apply('invoices', invoices_csv(open_status='pago', open_paid_at='2026-10-05', open_paid='99,90'))
        assert paid_origin['totals']['created'] == 0 and paid_origin['totals']['unchanged'] == 3, paid_origin['totals']
        assert paid_origin['totals']['conflicts'] == 1, paid_origin['totals']
        open_row = line(paid_origin, open_ext)
        assert open_row['status'] == 'unchanged' and open_row['entity_id'] == open_id
        assert open_row['messages'] == ['origem: pago em 2026-10-05 R$ 99,90; Nexo: em aberto — título não alterado, conciliar manualmente'], open_row
        assert line(paid_origin, paid_ext)['messages'] == [] and line(paid_origin, cancel_ext)['messages'] == []
        assert state() == loaded
        valued = apply('invoices', invoices_csv(open_value='120,00'))
        assert valued['totals']['unchanged'] == 3 and valued['totals']['conflicts'] == 1 and valued['totals']['created'] == 0, valued['totals']
        value_row = line(valued, open_ext)
        assert value_row['status'] == 'unchanged' and value_row['entity_id'] == open_id
        assert value_row['messages'] == ['origem: valor R$ 120,00; Nexo: valor R$ 99,90 — título não alterado, conciliar manualmente'], value_row
        dated = apply('invoices', invoices_csv(open_due='2026-11-15'))
        assert dated['totals']['conflicts'] == 1 and dated['totals']['created'] == 0, dated['totals']
        due_row = line(dated, open_ext)
        assert due_row['status'] == 'unchanged' and due_row['entity_id'] == open_id
        assert due_row['messages'] == ['origem: vencimento 2026-11-15; Nexo: vencimento 2026-10-20 — título não alterado, conciliar manualmente'], due_row
        assert state() == loaded
        manual = api('/api/invoices/' + open_id + '/manual-payment', {
            'intent_id': str(uuid.uuid4()),
            'amount_cents': 9990,
            'paid_at': '2026-10-18',
            'note': 'Baixa posterior no Nexo',
        })
        assert manual['status'] == 200 and manual['json']['status'] == 'paid', manual['json']
        local = apply('invoices', original)
        assert local['totals']['unchanged'] == 3 and local['totals']['conflicts'] == 1 and local['totals']['created'] == 0, local['totals']
        local_row = line(local, open_ext)
        assert local_row['status'] == 'unchanged' and local_row['entity_id'] == open_id
        assert local_row['messages'] == ['origem: em aberto; Nexo: pago R$ 99,90 — título não alterado, conciliar manualmente'], local_row
        assert line(local, paid_ext)['messages'] == [] and line(local, cancel_ext)['messages'] == []
        after_local = state()
        assert after_local[open_ext]['status'] == 'paid' and after_local[open_ext]['payments'] == 1
        assert after_local[open_ext]['amount_cents'] == 9990 and after_local[open_ext]['due_date'] == '2026-10-20'
        assert after_local[paid_ext] == loaded[paid_ext] and after_local[cancel_ext] == loaded[cancel_ext]
        detail = api('/api/invoices/' + open_id)
        assert detail['status'] == 200 and detail['json']['status'] == 'paid', detail['json']
        assert len(detail['json']['payments']) == 1, detail['json']
        beta_login = call('/api/auth/login', {'email': 'admin@beta.demo', 'password': 'demo1234', 'bearer': True})
        assert beta_login['status'] == 200, beta_login['json']
        beta = call('/api/invoices?q=' + marker, token=beta_login['json']['token'])
        assert beta['status'] == 200 and beta['json'] == [], beta['json']
        for hidden in (open_id, paid_id, cancel_id):
            denied = call('/api/invoices/' + hidden, token=beta_login['json']['token'])
            assert denied['status'] == 404, denied['json']
        visible = api('/api/invoices?q=' + marker)
        assert visible['status'] == 200 and {row['id'] for row in visible['json']} == {open_id, paid_id, cancel_id}, visible['json']
        return {'ok': True, 'checks': ['reimportação idêntica sem conflicts', 'pago na origem não baixa o título', 'valor divergente explicado', 'vencimento divergente explicado', 'baixa posterior no Nexo explicada', 'isolamento entre tenants']}
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
            "delete from audit_events where entity_type='import_batch' and entity_id in (select id from import_batches where source=" + quote(marker) + ");"
            "delete from import_rows where batch_id in (select id from import_batches where source=" + quote(marker) + ");"
            "delete from import_batches where source=" + quote(marker) + ";"
            "commit;",
            'nexo_test')
