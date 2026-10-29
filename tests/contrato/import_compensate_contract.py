"""Contrato HTTP da compensação de lote importado (C25-v1, casos B13-01..22).

Chamado por nativo.py depois dos contratos de importação. Usa o request e o SQL
do laboratório atual. Não lê .env e não importa fixture de outra worktree.
Escrita de teste não é execução: nativo.py no host descartável é o gate.
"""
import concurrent.futures
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

    def counts():
        row = records(
            "select (select count(*)::int from payments) as payments,"
            "(select count(*)::int from invoice_movements) as movements,"
            "(select count(*)::int from import_batches) as batches,"
            "(select count(*)::int from import_rows) as rows,"
            "(select count(*)::int from audit_events) as audits,"
            "(select count(*)::int from import_batch_compensations) as markers,"
            "(select count(*)::int from provider_operations) as operations,"
            "(select count(*)::int from invoices) as invoices,"
            "(select count(*)::int from subscribers) as subscribers,"
            "(select count(*)::int from contracts) as contracts"
        )[0]
        return row

    def whole(value):
        return isinstance(value, int) and not isinstance(value, bool) and value >= 0

    def uuid_text(value):
        try:
            return str(uuid.UUID(str(value))) == str(value)
        except (ValueError, TypeError, AttributeError):
            return False

    marker = 'b13c' + uuid.uuid4().hex[:8]
    source = marker
    reason = 'motivo de compensacao do lote'
    tenants = {row['email']: row['tenant_id'] for row in records(
        "select tenant_id::text as tenant_id, email from users where email in ('admin@alfa.demo','admin@beta.demo')")}
    alfa = tenants['admin@alfa.demo']
    beta = tenants['admin@beta.demo']
    before = counts()

    def run_sql(statement):
        sql(statement, 'nexo_test')

    def apply(kind, csv, origin=None):
        response = api('/api/import/apply', {'kind': kind, 'source': origin or source, 'csv': csv, 'filename': marker + '.csv'})
        assert response['status'] == 200, response['json']
        body = response['json']
        assert body['applied'] is True, body
        return body

    def titles(lines):
        return 'id_externo;id_externo_assinante;vencimento;valor;situacao;pago_em;valor_pago\n' + '\n'.join(lines) + '\n'

    def line(ext, valor, situacao, pago_em='', valor_pago=''):
        return ';'.join([cell(ext), cell(marker), '2026-11-20', valor, situacao, pago_em, valor_pago])

    def invoice_of(body, ext):
        return next(row for row in body['sample'] if row['external_id'] == ext)

    def compensate(batch, key, why=reason, query='', token=None, cookie=False, headers=None, body=None, method='POST'):
        extra = {}
        if key is not None:
            extra['Idempotency-Key'] = key
        if headers:
            extra.update(headers)
        payload = {'reason': why, 'tenant': beta} if body is None else body
        path = '/api/import/batches/' + batch + '/compensate' + query
        # Sem token explícito, api envia o bearer do login admin de nativo.py.
        if token is None and not cookie:
            return api(path, payload, method=method, headers=extra)
        return call(path, payload, method=method, token=token, headers=extra, cookie=cookie)

    def eligibility(batch, token=None):
        if token is None:
            return api('/api/import/batches/' + batch + '/revert-eligibility')
        return call('/api/import/batches/' + batch + '/revert-eligibility', token=token)

    def cash(invoice):
        return records(
            "select i.id::text as id, i.status, i.external_id, i.external_source, i.amount_cents::int as amount_cents,"
            " (i.paid_at is not null) as paid, i.fee_cents::int as fee_cents, i.discount_cents::int as discount_cents,"
            " (select count(*)::int from payments p where p.invoice_id=i.id) as payments,"
            " (select count(*)::int from payments p where p.invoice_id=i.id and p.kind='reversal') as reversals,"
            " (select count(*)::int from payments p where p.invoice_id=i.id and p.kind='payment') as originals,"
            " coalesce((select sum(p.signed_cents)::int from payments p where p.invoice_id=i.id),0) as signed,"
            " coalesce((select s.collectible_cents::int from financial_balance_shadow s where s.invoice_id=i.id),0) as collectible,"
            " coalesce((select s.excess_cents::int from financial_balance_shadow s where s.invoice_id=i.id),0) as excess,"
            " (select count(*)::int from invoice_movements m where m.invoice_id=i.id) as movements,"
            " (select count(*)::int from provider_operations o where o.invoice_id=i.id) as operations,"
            " (select count(*)::int from provider_issuance j where j.invoice_id=i.id) as issuances,"
            " (select count(*)::int from financial_payment_allocations a where a.invoice_id=i.id) as allocations"
            " from invoices i where i.id=" + quote(invoice) + "::uuid"
        )[0]

    def marker_row(batch):
        rows = records(
            "select id::text as id, reason, result::text as result,"
            " (idempotency_key is not null) as has_key, (request_hash is not null) as has_hash"
            " from import_batch_compensations where batch_id=" + quote(batch) + "::uuid"
        )
        return rows

    def assert_absent(batch, invoice, status):
        state = cash(invoice)
        assert state['status'] == status, state
        assert marker_row(batch) == []
        assert state['reversals'] == 0

    def assert_reply(body, batch):
        for name in ('created_rows', 'reversed_payments', 'canceled_invoices', 'left_canceled', 'skipped_unchanged', 'skipped_error'):
            assert whole(body[name]), body
        assert body['batch_id'] == batch and uuid_text(body['compensation_id'])
        assert body['idempotent_replay'] is False or body['idempotent_replay'] is True
        assert body['evidence']['reverted'] is False
        assert isinstance(body['evidence']['note'], str) and 'apagada' in body['evidence']['note']
        assert 'idempotency_key' not in body and 'request_hash' not in body
        stored = marker_row(batch)
        assert len(stored) == 1 and stored[0]['id'] == body['compensation_id']
        persisted = json.loads(stored[0]['result'])
        assert 'idempotency_key' not in persisted and 'request_hash' not in persisted

    def assert_get(batch, state, compensation_id=None):
        page = eligibility(batch)
        assert page['status'] == 200, page['json']
        body = page['json']
        for name in ('batch', 'eligible', 'blockers', 'checked_at', 'evidence', 'compensation'):
            assert name in body, body
        assert body['evidence']['reverted'] is False
        assert body['batch']['id'] == batch and body['batch']['kind']
        assert isinstance(body['checked_at'], str) and body['checked_at'].endswith('Z')
        comp = body['compensation']
        assert 'idempotency_key' not in comp and 'request_hash' not in comp
        assert comp['state'] == state, comp
        if state == 'absent':
            assert set(comp) == {'state'}
        else:
            assert comp['compensation_id'] == compensation_id and uuid_text(comp['compensation_id'])
            assert isinstance(comp['created_at'], str) and comp['created_at'].endswith('Z')
            assert isinstance(comp['reason'], str) and len(comp['reason']) >= 10
            assert isinstance(comp['result'], dict) and 'idempotency_key' not in comp['result']
        return body

    def preserved(previous):
        now = counts()
        for name in ('payments', 'movements', 'batches', 'rows', 'audits', 'markers', 'invoices'):
            assert now[name] >= previous[name], (name, previous[name], now[name])
        return now

    plans = api('/api/plans')
    assert plans['status'] == 200 and plans['json'], plans['json']
    plan = next(item['name'] for item in plans['json'] if item.get('active') is not False)
    people = apply('subscribers', 'id_externo;nome;situacao;plano;vencimento_dia\n' + ';'.join([
        cell(marker), cell('Assinante ' + marker), 'ativo', cell(plan), '10']) + '\n')
    assert people['totals']['created'] == 1, people['totals']
    subscriber_name = records("select name from subscribers where external_source=" + quote(source) + " and external_id=" + quote(marker))[0]['name']

    def fresh(ext, valor, situacao, pago_em='', valor_pago=''):
        body = apply('invoices', titles([line(ext, valor, situacao, pago_em, valor_pago)]))
        assert body['totals']['error'] == 0 and body['totals']['created'] == 1, body['totals']
        row = invoice_of(body, ext)
        assert row['status'] == 'created' and row['entity_id']
        return body['batch_id'], row['entity_id']

    # B13-04 integral
    batch, invoice = fresh(marker + '-full', '100,00', 'pago', '2020-05-01', '')
    absent = assert_get(batch, 'absent')
    assert absent['batch']['source'] == source
    first = compensate(batch, 'b13-04-' + marker)
    assert first['status'] == 200, first['json']
    body = first['json']
    assert body['reversed_payments'] == 1 and body['canceled_invoices'] == 1 and body['idempotent_replay'] is False
    assert_reply(body, batch)
    paid = cash(invoice)
    assert paid['status'] == 'canceled' and paid['payments'] == 2 and paid['reversals'] == 1 and paid['originals'] == 1
    assert paid['signed'] == 0 and paid['collectible'] == 0 and paid['excess'] == 0 and paid['operations'] == 0
    assert paid['external_id'] == marker + '-full' and paid['external_source'] == source and paid['amount_cents'] == 10000
    original = records(
        "select id::text as id, kind, source, note, created_by::text as created_by, provider_refund_id, provider_return_id"
        " from payments where invoice_id=" + quote(invoice) + "::uuid and kind='payment'"
    )[0]
    assert original['source'] == 'manual' and original['created_by'] is None
    assert original['note'] == 'Importado de ' + source + ' (id ' + marker + '-full)'
    assert original['provider_refund_id'] is None and original['provider_return_id'] is None
    reversal = records(
        "select note, reversal_of::text as reversal_of, source, kind, amount_cents::int as amount_cents, provider_refund_id"
        " from payments where invoice_id=" + quote(invoice) + "::uuid and kind='reversal'"
    )[0]
    assert reversal['reversal_of'] == original['id'] and reversal['source'] == 'manual'
    assert reversal['amount_cents'] == 10000 and batch in reversal['note'] and reversal['provider_refund_id'] is None
    assert records("select status from import_rows where batch_id=" + quote(batch) + "::uuid")[0]['status'] == 'created'
    committed = assert_get(batch, 'committed', body['compensation_id'])
    assert committed['compensation']['reason'] == reason
    # B13-01 mesma chave e mesmo motivo
    replay = compensate(batch, 'b13-04-' + marker)
    assert replay['status'] == 200, replay['json']
    again = replay['json']
    assert again['idempotent_replay'] is True and again['compensation_id'] == body['compensation_id']
    assert again['reversed_payments'] == 1 and 'idempotency_key' not in again and 'request_hash' not in again
    assert cash(invoice)['payments'] == 2 and len(marker_row(batch)) == 1
    # B13-19 chave igual e motivo diferente, depois do 200
    clash = compensate(batch, 'b13-04-' + marker, 'motivo diferente do primeiro')
    assert clash['status'] == 409 and clash['json']['error'] == 'idempotency_conflict', clash['json']
    other_key = compensate(batch, 'b13-19-outra-' + marker)
    assert other_key['status'] == 409 and other_key['json']['error'] == 'already_compensated', other_key['json']

    # B13-05 parcial
    batch, invoice = fresh(marker + '-part', '100,00', 'pago', '2020-05-01', '40,00')
    opened = cash(invoice)
    assert opened['status'] == 'open' and opened['payments'] == 1 and opened['signed'] == 4000
    part = compensate(batch, 'b13-05-' + marker)
    assert part['status'] == 200, part['json']
    assert part['json']['reversed_payments'] == 1 and part['json']['canceled_invoices'] == 1 and part['json']['skipped_unchanged'] == 0
    state = cash(invoice)
    assert state['status'] == 'canceled' and state['reversals'] == 1 and state['signed'] == 0 and state['amount_cents'] == 10000
    assert records("select amount_cents::int as n from payments where invoice_id=" + quote(invoice) + "::uuid and kind='reversal'")[0]['n'] == 4000

    # B13-06 excedente
    batch, invoice = fresh(marker + '-over', '100,00', 'pago', '2020-05-01', '150,00')
    assert cash(invoice)['status'] == 'paid' and cash(invoice)['excess'] > 0
    over = compensate(batch, 'b13-06-' + marker)
    assert over['status'] == 200, over['json']
    state = cash(invoice)
    assert state['status'] == 'canceled' and state['signed'] == 0 and state['excess'] == 0 and state['collectible'] == 0
    assert records("select amount_cents::int as n from payments where invoice_id=" + quote(invoice) + "::uuid and kind='reversal'")[0]['n'] == 15000
    assert records("select agreement_id::text as id from invoices where id=" + quote(invoice) + "::uuid")[0]['id'] is None
    assert records(
        "select count(*)::int as n from financial_payment_allocations where payment_id in"
        " (select id from payments where invoice_id=" + quote(invoice) + "::uuid) and invoice_id<>" + quote(invoice) + "::uuid"
    )[0]['n'] == 0

    # B13-07 já cancelado na origem
    batch, invoice = fresh(marker + '-left', '80,00', 'cancelado')
    assert cash(invoice)['status'] == 'canceled' and cash(invoice)['payments'] == 0
    left = compensate(batch, 'b13-07-' + marker)
    assert left['status'] == 200, left['json']
    assert left['json']['left_canceled'] == 1 and left['json']['reversed_payments'] == 0 and left['json']['canceled_invoices'] == 0
    assert cash(invoice)['payments'] == 0 and cash(invoice)['external_id'] == marker + '-left' and cash(invoice)['movements'] == 1
    same = apply('invoices', titles([line(marker + '-left', '80,00', 'cancelado')]))
    row = invoice_of(same, marker + '-left')
    assert row['status'] == 'unchanged' and row['entity_id'] == invoice
    assert records("select count(*)::int as n from invoices where external_source=" + quote(source) + " and external_id=" + quote(marker + '-left'))[0]['n'] == 1

    # B13-08 aberto
    batch, invoice = fresh(marker + '-open', '70,00', 'aberto')
    assert cash(invoice)['payments'] == 0 and cash(invoice)['status'] == 'open'
    opened_reply = compensate(batch, 'b13-08-' + marker)
    assert opened_reply['status'] == 200, opened_reply['json']
    assert opened_reply['json']['canceled_invoices'] == 1 and opened_reply['json']['reversed_payments'] == 0
    state = cash(invoice)
    assert state['status'] == 'canceled' and state['reversals'] == 0 and state['amount_cents'] == 7000 and state['external_id'] == marker + '-open'
    assert state['movements'] == 2
    assert records(
        "select count(*)::int as n from invoices where id=" + quote(invoice) + "::uuid and external_source is null"
    )[0]['n'] == 0

    # B13-09 baixa posterior bloqueia GET e POST
    batch, invoice = fresh(marker + '-later', '55,00', 'aberto')
    manual = api('/api/invoices/' + invoice + '/manual-payment', {
        'intent_id': str(uuid.uuid4()), 'amount_cents': 5500, 'paid_at': '2026-10-18', 'note': 'Baixa posterior no Nexo'})
    assert manual['status'] == 200, manual['json']
    blocked = eligibility(batch)
    assert blocked['status'] == 200 and blocked['json']['eligible'] is False
    kinds = {item['kind'] for item in blocked['json']['blockers']}
    assert 'payments_after_import' in kinds, blocked['json']['blockers']
    denied = compensate(batch, 'b13-09-' + marker)
    assert denied['status'] == 409 and denied['json']['error'] == 'provenance_payment', denied['json']
    assert 'blockers' in denied['json']
    assert_absent(batch, invoice, 'paid')
    assert cash(invoice)['reversals'] == 0 and cash(invoice)['operations'] == 0

    # B13-12 eligible antigo não autoriza o POST
    batch, invoice = fresh(marker + '-stale', '33,00', 'aberto')
    fresh_get = eligibility(batch)
    assert fresh_get['status'] == 200 and fresh_get['json']['eligible'] is True and fresh_get['json']['blockers'] == []
    assert fresh_get['json']['evidence']['reverted'] is False and fresh_get['json']['compensation']['state'] == 'absent'
    manual = api('/api/invoices/' + invoice + '/manual-payment', {
        'intent_id': str(uuid.uuid4()), 'amount_cents': 3300, 'paid_at': '2026-10-19', 'note': 'Baixa depois do GET'})
    assert manual['status'] == 200, manual['json']
    stale = compensate(batch, 'b13-12-' + marker)
    assert stale['status'] == 409 and stale['json']['error'] == 'provenance_payment', stale['json']
    assert_absent(batch, invoice, 'paid')
    assert eligibility(batch)['json']['evidence']['reverted'] is False

    # B13-13 timestamp igual ou anterior não prova a baixa importada
    batch, invoice = fresh(marker + '-clock', '21,00', 'aberto')
    run_sql(
        "insert into payments (tenant_id, invoice_id, amount_cents, paid_at, method, source, note, created_by, created_at)"
        " select " + quote(alfa) + "::uuid, " + quote(invoice) + "::uuid, 2100, '2020-01-02T00:00:00Z', 'pix', 'manual', 'baixa alheia', u.id, b.created_at"
        " from import_batches b join users u on u.email='admin@alfa.demo' where b.id=" + quote(batch) + "::uuid"
    )
    clock_get = eligibility(batch)
    assert clock_get['status'] == 200, clock_get['json']
    assert 'payments_after_import' not in {item['kind'] for item in clock_get['json']['blockers']}
    clock = compensate(batch, 'b13-13-' + marker)
    assert clock['status'] == 409 and clock['json']['error'] == 'provenance_payment', clock['json']
    assert_absent(batch, invoice, 'open')
    assert cash(invoice)['payments'] == 1 and cash(invoice)['signed'] == 2100

    # B13-10 emissão, aviso, efeito e movimento extra
    def refuse_blocker(ext, setup, error):
        owned, title = fresh(ext, '12,00', 'aberto')
        setup(title, owned)
        reply = compensate(owned, 'b13-10-' + ext)
        assert reply['status'] == 409 and reply['json']['error'] == error, reply['json']
        assert isinstance(reply['json'].get('blockers'), list) and reply['json']['blockers']
        assert_absent(owned, title, 'open')
        assert cash(title)['operations'] == 0
        return title

    refuse_blocker(marker + '-notice', lambda title, owned: run_sql(
        "insert into notice_log (tenant_id, invoice_id, status) values (" + quote(alfa) + "::uuid, " + quote(title) + "::uuid, 'sent')"
    ), 'notices')
    refuse_blocker(marker + '-fee', lambda title, owned: run_sql(
        "update invoices set fee_cents=10 where id=" + quote(title) + "::uuid"
    ), 'provenance_movement')
    refuse_blocker(marker + '-move', lambda title, owned: run_sql(
        "insert into invoice_movements (tenant_id, invoice_id, origin, nominal_delta, fee_delta, discount_delta, status_after)"
        " select tenant_id, id, 'adjustment', 0, 0, 0, status from invoices where id=" + quote(title) + "::uuid"
    ), 'provenance_movement')
    issuance_invoice = refuse_blocker(marker + '-psp', lambda title, owned: run_sql(
        "update invoices set gateway_charge_id=" + quote('cob-' + marker) + " where id=" + quote(title) + "::uuid"
    ), 'provider_issuance')
    assert records("select gateway_charge_id from invoices where id=" + quote(issuance_invoice) + "::uuid")[0]['gateway_charge_id'] == 'cob-' + marker

    # B13-17 misto: created, unchanged e error; updated bloqueia o lote
    first_batch, first_invoice = fresh(marker + '-keep', '15,00', 'pago', '2020-05-01', '15,00')
    mixed = apply('invoices', titles([
        line(marker + '-new', '15,00', 'aberto'),
        line(marker + '-keep', '15,00', 'pago', '2020-05-01', '15,00'),
        line(marker + '-bad', '15,00', 'pago', '2020-05-01', '45,00'),
    ]))
    assert mixed['totals']['created'] == 1 and mixed['totals']['unchanged'] == 1 and mixed['totals']['error'] == 1, mixed['totals']
    created = invoice_of(mixed, marker + '-new')
    untouched = invoice_of(mixed, marker + '-keep')
    bad = invoice_of(mixed, marker + '-bad')
    assert created['status'] == 'created' and untouched['status'] == 'unchanged' and untouched['entity_id'] == first_invoice
    assert bad['status'] == 'error' and not bad['entity_id']
    mixed_reply = compensate(mixed['batch_id'], 'b13-17-' + marker)
    assert mixed_reply['status'] == 200, mixed_reply['json']
    assert mixed_reply['json']['canceled_invoices'] == 1 and mixed_reply['json']['skipped_unchanged'] == 1 and mixed_reply['json']['skipped_error'] == 1
    assert cash(created['entity_id'])['status'] == 'canceled'
    assert cash(first_invoice)['status'] == 'paid' and cash(first_invoice)['external_id'] == marker + '-keep'
    assert records("select count(*)::int as n from invoices where external_id=" + quote(marker + '-bad'))[0]['n'] == 0
    assert records("select status from import_rows where batch_id=" + quote(mixed['batch_id']) + "::uuid and external_id=" + quote(marker + '-new'))[0]['status'] == 'created'
    anomaly_batch, anomaly_invoice = fresh(marker + '-upd', '16,00', 'aberto')
    run_sql("update import_rows set status='updated' where batch_id=" + quote(anomaly_batch) + "::uuid")
    anomaly = compensate(anomaly_batch, 'b13-17b-' + marker)
    assert anomaly['status'] == 409 and anomaly['json']['error'] == 'provenance_movement', anomaly['json']
    assert_absent(anomaly_batch, anomaly_invoice, 'open')

    # B13-18 reimportação e lote dependente
    origin_batch, origin_invoice = fresh(marker + '-re', '18,00', 'aberto')
    done = compensate(origin_batch, 'b13-18-' + marker)
    assert done['status'] == 200, done['json']
    reimport = apply('invoices', titles([line(marker + '-re', '18,00', 'aberto')]))
    re_row = invoice_of(reimport, marker + '-re')
    assert re_row['status'] == 'unchanged' and re_row['entity_id'] == origin_invoice
    assert reimport['batch_id'] != origin_batch
    assert records("select count(*)::int as n from invoices where external_source=" + quote(source) + " and external_id=" + quote(marker + '-re'))[0]['n'] == 1
    assert len(marker_row(origin_batch)) == 1
    repeat = compensate(origin_batch, 'b13-18-nova-' + marker)
    assert repeat['status'] == 409 and repeat['json']['error'] == 'already_compensated', repeat['json']
    after = eligibility(origin_batch)
    dependent = next(item for item in after['json']['blockers'] if item['kind'] == 'dependent_batches')
    assert reimport['batch_id'] in dependent['sample_ids'], dependent
    assert after['json']['compensation']['state'] == 'committed'

    # B13-19 validação, lote vazio e teto
    batch, invoice = fresh(marker + '-valid', '11,00', 'aberto')
    missing_key = compensate(batch, None)
    assert missing_key['status'] == 400, missing_key['json']
    short_key = compensate(batch, 'curta')
    assert short_key['status'] == 400 and short_key['json']['error'] == 'Idempotency-Key ausente ou inválida', short_key['json']
    long_key = compensate(batch, 'k' * 201)
    assert long_key['status'] == 400, long_key['json']
    blank = compensate(batch, 'b13-19-blank-' + marker, '', body={'reason': '   '})
    assert blank['status'] == 400, blank['json']
    short_reason = compensate(batch, 'b13-19-short-' + marker, 'curto')
    assert short_reason['status'] == 400 and 'motivo' in short_reason['json']['error'], short_reason['json']
    long_reason = compensate(batch, 'b13-19-long-' + marker, 'm' * 201)
    assert long_reason['status'] == 400, long_reason['json']
    unknown = compensate(batch, 'b13-19-q-' + marker, query='?tenant=other')
    assert unknown['status'] == 400 and unknown['json']['error'] == 'filtro desconhecido', unknown['json']
    repeated = compensate(batch, 'b13-19-r-' + marker, query='?a=1&a=2')
    assert repeated['status'] == 400 and repeated['json']['error'] == 'filtro repetido', repeated['json']
    bad_id = compensate('nao-uuid', 'b13-19-id-' + marker)
    assert bad_id['status'] == 400, bad_id['json']
    assert marker_row(batch) == [] and cash(invoice)['status'] == 'open'
    trimmed = compensate(batch, 'b13-19-trim-' + marker, '  motivo valido com espacos  ')
    assert trimmed['status'] == 200, trimmed['json']
    assert marker_row(batch)[0]['reason'] == 'motivo valido com espacos'
    empty_id = str(uuid.uuid4())
    run_sql(
        "insert into import_batches (id, tenant_id, source, kind, filename, totals, created_by)"
        " select " + quote(empty_id) + "::uuid, tenant_id, " + quote(marker + '-empty') + ", 'invoices', 'vazio.csv', '{}'::jsonb, id"
        " from users where email='admin@alfa.demo';"
        "insert into import_rows (tenant_id, batch_id, row_number, external_id, status, messages)"
        " select tenant_id, " + quote(empty_id) + "::uuid, 1, 'ja', 'unchanged', '[]'::jsonb from users where email='admin@alfa.demo';"
        "insert into import_rows (tenant_id, batch_id, row_number, external_id, status, messages)"
        " select tenant_id, " + quote(empty_id) + "::uuid, 2, 'ruim', 'error', '[]'::jsonb from users where email='admin@alfa.demo'"
    )
    empty = compensate(empty_id, 'b13-19-empty-' + marker)
    assert empty['status'] == 409 and empty['json']['error'] == 'nothing_created', empty['json']
    assert marker_row(empty_id) == []
    cap_id = str(uuid.uuid4())
    run_sql(
        "insert into import_batches (id, tenant_id, source, kind, filename, totals, created_by)"
        " select " + quote(cap_id) + "::uuid, tenant_id, " + quote(marker + '-cap') + ", 'invoices', 'teto.csv', '{}'::jsonb, id"
        " from users where email='admin@alfa.demo';"
        "insert into import_rows (tenant_id, batch_id, row_number, external_id, status, messages, entity_id)"
        " select u.tenant_id, " + quote(cap_id) + "::uuid, g, gen_random_uuid()::text, 'created', '[]'::jsonb, gen_random_uuid()"
        " from users u cross join generate_series(1, 201) g where u.email='admin@alfa.demo'"
    )
    cap = compensate(cap_id, 'b13-19-cap-' + marker)
    assert cap['status'] == 409 and cap['json']['error'] == 'row_cap', cap['json']
    assert marker_row(cap_id) == []

    # B13-16 kinds fora do MVP e updated de assinante sem preimagem
    renamed = apply('subscribers', 'id_externo;nome;situacao\n' + ';'.join([cell(marker), cell('Nome novo ' + marker), 'ativo']) + '\n')
    assert renamed['totals']['updated'] == 1, renamed['totals']
    for lot in (people['batch_id'], renamed['batch_id']):
        refused = compensate(lot, 'b13-16-sub-' + lot[:8])
        assert refused['status'] == 409 and refused['json']['error'] == 'kind_not_compensatable', refused['json']
        assert marker_row(lot) == []
    assert records("select name from subscribers where external_source=" + quote(source) + " and external_id=" + quote(marker))[0]['name'] == 'Nome novo ' + marker
    assert records("select name from subscribers where external_source=" + quote(source) + " and external_id=" + quote(marker))[0]['name'] != subscriber_name
    contract_person = marker + 'b'
    apply('subscribers', 'id_externo;nome;situacao\n' + ';'.join([cell(contract_person), cell('Contrato ' + marker), 'ativo']) + '\n', origin=source)
    contract_ext = marker + '-ct'
    contracts = apply('contracts', 'id_externo;id_externo_assinante;plano;vencimento_dia\n' + ';'.join([
        cell(contract_ext), cell(contract_person), cell(plan), '12']) + '\n')
    assert contracts['totals']['created'] == 1, contracts['totals']
    refused = compensate(contracts['batch_id'], 'b13-16-ct-' + marker)
    assert refused['status'] == 409 and refused['json']['error'] == 'kind_not_compensatable', refused['json']
    assert records("select count(*)::int as n from contracts where external_source=" + quote(source) + " and external_id=" + quote(contract_ext))[0]['n'] == 1
    for kind in ('history', 'network', 'documents', 'users'):
        lot = str(uuid.uuid4())
        run_sql(
            "insert into import_batches (id, tenant_id, source, kind, filename, totals, created_by)"
            " select " + quote(lot) + "::uuid, tenant_id, " + quote(marker + '-' + kind) + ", " + quote(kind) + ", 'fora.csv', '{}'::jsonb, id"
            " from users where email='admin@alfa.demo';"
            "insert into import_rows (tenant_id, batch_id, row_number, external_id, status, messages, entity_id)"
            " select tenant_id, " + quote(lot) + "::uuid, 1, 'ext', 'created', '[]'::jsonb, gen_random_uuid() from users where email='admin@alfa.demo'"
        )
        refused = compensate(lot, 'b13-16-' + kind + '-' + marker)
        assert refused['status'] == 409 and refused['json']['error'] == 'kind_not_compensatable', (kind, refused['json'])
        assert marker_row(lot) == []

    # B13-20 estorno da reversão e baixa manual na fatura já compensada
    batch, invoice = fresh(marker + '-box', '100,00', 'pago', '2020-05-01', '100,00')
    boxed = compensate(batch, 'b13-20-' + marker)
    assert boxed['status'] == 200, boxed['json']
    pay_rows = records(
        "select id::text as id, kind from payments where invoice_id=" + quote(invoice) + "::uuid order by kind"
    )
    original_id = next(row['id'] for row in pay_rows if row['kind'] == 'payment')
    reversal_id = next(row['id'] for row in pay_rows if row['kind'] == 'reversal')
    audits_before = records("select count(*)::int as n from audit_events where action='import.compensate_batch' and entity_id=" + quote(batch))[0]['n']
    reverse_reversal = api('/api/invoices/' + invoice + '/payments/' + reversal_id + '/reverse', {'reason': 'desfazer o estorno da compensacao'})
    assert reverse_reversal['status'] == 400 and reverse_reversal['json']['error'] == 'este lançamento já é um estorno', reverse_reversal['json']
    reverse_original = api('/api/invoices/' + invoice + '/payments/' + original_id + '/reverse', {'reason': 'estornar a baixa original de novo'})
    assert reverse_original['status'] == 400 and reverse_original['json']['error'] == 'fatura cancelada', reverse_original['json']
    late_pay = api('/api/invoices/' + invoice + '/manual-payment', {
        'intent_id': str(uuid.uuid4()), 'amount_cents': 10000, 'paid_at': '2026-10-20', 'note': 'baixa depois da compensacao'})
    assert late_pay['status'] == 400 and late_pay['json']['error'] == 'fatura não está em aberto', late_pay['json']
    assert cash(invoice)['reversals'] == 1 and cash(invoice)['payments'] == 2
    assert records("select count(*)::int as n from payments where invoice_id=" + quote(invoice) + "::uuid and provider_refund_id is not null")[0]['n'] == 0
    assert len(marker_row(batch)) == 1
    assert records("select count(*)::int as n from audit_events where action='import.compensate_batch' and entity_id=" + quote(batch))[0]['n'] == audits_before

    # B13-02 duas chaves concorrentes no mesmo lote
    batch, invoice = fresh(marker + '-race', '100,00', 'pago', '2020-05-01', '100,00')
    keys = ['b13-02-a-' + marker, 'b13-02-b-' + marker]
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        raced = list(pool.map(lambda key: compensate(batch, key, 'motivo corrida ' + key[-1]), keys))
    statuses = sorted(item['status'] for item in raced)
    assert statuses == [200, 409], [item['json'] for item in raced]
    assert any(item['json'].get('error') == 'already_compensated' for item in raced if item['status'] == 409)
    assert len(marker_row(batch)) == 1 and cash(invoice)['reversals'] == 1 and cash(invoice)['status'] == 'canceled'

    # B13-14 outro tenant
    hidden = fresh(marker + '-alfa', '10,00', 'aberto')[0]
    beta_login = call('/api/auth/login', {'email': 'admin@beta.demo', 'password': 'demo1234', 'bearer': True})
    assert beta_login['status'] == 200, beta_login['json']
    beta_token = beta_login['json']['token']
    beta_get = eligibility(hidden, beta_token)
    beta_post = compensate(hidden, 'b13-14-' + marker, token=beta_token)
    assert beta_get['status'] == 404 and beta_post['status'] == 404, (beta_get['json'], beta_post['json'])
    assert beta_post['json'].get('blockers') is None
    assert marker_row(hidden) == []
    ignored = compensate(hidden, 'b13-14-own-' + marker)
    assert ignored['status'] == 200, ignored['json']

    # B13-15 POP, portal, suporte, permissão e CSRF
    batch, invoice = fresh(marker + '-scope', '10,00', 'aberto')
    pop = str(uuid.uuid4())
    run_sql(
        "insert into pops(id,tenant_id,name) values(" + quote(pop) + "," + quote(alfa) + "," + quote('POP ' + marker) + ");"
        "insert into users(id,tenant_id,email,name,password_hash,role)"
        " select gen_random_uuid(), " + quote(alfa) + ", " + quote(marker + '-pop@synthetic.invalid') + ", 'POP', password_hash, 'noc' from users where email='admin@alfa.demo';"
        "insert into users(id,tenant_id,email,name,password_hash,role)"
        " select gen_random_uuid(), " + quote(alfa) + ", " + quote(marker + '-empty@synthetic.invalid') + ", 'POP vazio', password_hash, 'noc' from users where email='admin@alfa.demo';"
        "insert into users(id,tenant_id,email,name,password_hash,role)"
        " select gen_random_uuid(), " + quote(alfa) + ", " + quote(marker + '-fin@synthetic.invalid') + ", 'Financeiro', password_hash, 'finance' from users where email='admin@alfa.demo';"
        "insert into users(id,tenant_id,email,name,password_hash,role,subscriber_id)"
        " select gen_random_uuid(), " + quote(alfa) + ", " + quote(marker + '-portal@synthetic.invalid') + ", 'Portal', password_hash, 'subscriber', s.id"
        " from users u join subscribers s on s.external_source=" + quote(source) + " and s.external_id=" + quote(marker) + " where u.email='admin@alfa.demo';"
        "insert into users(id,tenant_id,email,name,password_hash,role)"
        " select gen_random_uuid(), null, " + quote(marker + '-sup@synthetic.invalid') + ", 'Suporte', password_hash, 'saas_operator' from users where email='admin@alfa.demo';"
        "insert into user_pops(tenant_id,user_id,pop_id) select " + quote(alfa) + ", id, " + quote(pop) + " from users where email=" + quote(marker + '-pop@synthetic.invalid')
    )
    for email in (marker + '-pop@synthetic.invalid', marker + '-empty@synthetic.invalid', marker + '-fin@synthetic.invalid', marker + '-portal@synthetic.invalid'):
        login = call('/api/auth/login', {'email': email, 'password': 'demo1234', 'bearer': True})
        assert login['status'] == 200, (email, login['json'])
        token = login['json']['token']
        got = eligibility(batch, token)
        posted = compensate(batch, 'b13-15-' + email[:12], token=token)
        assert got['status'] == 403 and posted['status'] == 403, (email, got['json'], posted['json'])
    support = call('/api/auth/login', {'email': marker + '-sup@synthetic.invalid', 'password': 'demo1234', 'bearer': True})
    assert support['status'] == 200, support['json']
    run_sql(
        "update sessions set support_tenant_id=" + quote(alfa) + "::uuid where user_id=(select id from users where email=" + quote(marker + '-sup@synthetic.invalid') + ")"
    )
    support_token = support['json']['token']
    assert eligibility(batch, support_token)['status'] == 403
    assert compensate(batch, 'b13-15-support-' + marker, token=support_token)['status'] == 403
    cookie_login = call('/api/auth/login', {'email': 'admin@alfa.demo', 'password': 'demo1234', 'bearer': True})
    assert cookie_login['status'] == 200 and cookie_login['json'].get('csrf_token'), cookie_login['json']
    no_csrf = compensate(batch, 'b13-15-csrf-' + marker, token=cookie_login['json']['token'], cookie=True, headers={'X-Nexo-Csrf': ''})
    assert no_csrf['status'] == 403, no_csrf['json']
    with_csrf = compensate(
        batch, 'b13-15-ok-' + marker, token=cookie_login['json']['token'], cookie=True,
        headers={'X-Nexo-Csrf': cookie_login['json']['csrf_token']})
    assert with_csrf['status'] == 200, with_csrf['json']
    assert with_csrf['json']['canceled_invoices'] == 1 and cash(invoice)['status'] == 'canceled'
    assert len(marker_row(batch)) == 1

    # B13-11 e B13-21 no HTTP: a ordem commitada, sem corrida falsa. A barreira fica no teste Go.
    batch, invoice = fresh(marker + '-payfirst', '19,00', 'aberto')
    paid_first = api('/api/invoices/' + invoice + '/manual-payment', {
        'intent_id': str(uuid.uuid4()), 'amount_cents': 1900, 'paid_at': '2026-10-21', 'note': 'baixa antes da compensacao'})
    assert paid_first['status'] == 200, paid_first['json']
    after_pay = compensate(batch, 'b13-11-pay-' + marker)
    assert after_pay['status'] == 409, after_pay['json']
    assert_absent(batch, invoice, 'paid')
    batch, invoice = fresh(marker + '-compfirst', '19,00', 'aberto')
    comp_first = compensate(batch, 'b13-11-comp-' + marker)
    assert comp_first['status'] == 200, comp_first['json']
    pay_after = api('/api/invoices/' + invoice + '/manual-payment', {
        'intent_id': str(uuid.uuid4()), 'amount_cents': 1900, 'paid_at': '2026-10-21', 'note': 'baixa depois da compensacao'})
    assert pay_after['status'] == 400, pay_after['json']
    assert cash(invoice)['status'] == 'canceled' and cash(invoice)['payments'] == 0 and len(marker_row(batch)) == 1

    after = preserved(before)
    assert after['operations'] >= before['operations']
    assert after['subscribers'] >= before['subscribers'] and after['contracts'] >= before['contracts']
