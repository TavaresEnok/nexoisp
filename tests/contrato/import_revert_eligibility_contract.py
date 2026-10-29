"""Elegibilidade somente leitura para reverter um lote importado.
Chamado por nativo.py. A consulta não altera dados. A baixa manual é uma ação já existente.
payments_after_import.sample_ids traz payments.id (não o id da fatura).
dependent_batches.sample_ids traz import_batches.id dos outros lotes.
Uma reimportação do mesmo assinante com nome alterado grava status updated
e também entra em dependent_batches do lote que criou a entidade.
C25-v1: compensation absent ou committed. O POST /compensate é o fluxo HTTP
registrado. eligible não autoriza mutação. A chave e o hash não saem na leitura.
"""
import inspect
import json
import time
import uuid
from lib import quote, request as http_request

READ_NOTE = 'avaliação do estado atual; nenhuma reversão foi executada. Reversão futura deve compensar, não apagar, registros financeiros'
WRITE_NOTE = 'compensação append-only; nenhuma linha financeira, lote ou auditoria foi apagada'
SCOPE_ERROR = 'a reconciliação do lote exige escopo integral do provedor, fora do suporte'
COUNT_NAMES = (
    'created_rows', 'reversed_payments', 'canceled_invoices',
    'left_canceled', 'skipped_unchanged', 'skipped_error',
)


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
            "select (select count(*)::int from invoices) as invoices,"
            "(select count(*)::int from payments) as payments,"
            "(select count(*)::int from contracts) as contracts")[0]
        return (row['invoices'], row['payments'], row['contracts'])

    marker = 'b13v-' + uuid.uuid4().hex
    open_ext = marker + '-open'
    sub_name = 'Assinante ' + marker
    restricted, pop, portal = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    support_token = None
    tenants = {row['email']: row for row in records("select tenant_id::text as tenant_id, email from users where email in ('admin@alfa.demo','admin@beta.demo')")}
    alfa = tenants['admin@alfa.demo']['tenant_id']

    def apply(kind, csv):
        response = api('/api/import/apply', {'kind': kind, 'source': marker, 'csv': csv})
        assert response['status'] == 200, response['json']
        body = response['json']
        assert body['applied'] is True and body['totals']['error'] == 0, body
        return body

    def peek(batch_id, query=''):
        before = counts()
        page = api('/api/import/batches/' + batch_id + '/revert-eligibility' + query)
        after = counts()
        assert before == after, (before, after, page['json'])
        if page['status'] == 200:
            assert page['headers']['cache-control'] == 'no-store'
            assert page['json']['evidence']['reverted'] is False
            blob = json.dumps(page['json'])
            assert 'idempotency_key' not in blob and 'request_hash' not in blob
        return page

    def eligibility(batch_id, query=''):
        page = peek(batch_id, query)
        if page['status'] == 200:
            assert page['json']['compensation'] == {'state': 'absent'}, page['json']
        return page

    try:
        bad = api('/api/import/batches/not-a-uuid/revert-eligibility')
        assert bad['status'] == 400, bad['json']
        missing = api('/api/import/batches/' + str(uuid.uuid4()) + '/revert-eligibility')
        assert missing['status'] == 404, missing['json']
        plans = api('/api/plans')
        assert plans['status'] == 200 and plans['json'], plans['json']
        plan = next(item['name'] for item in plans['json'] if item.get('active') is not False)
        subscribers = apply('subscribers', '\n'.join([
            'id_externo;nome;situacao;plano;vencimento_dia',
            ';'.join([cell(marker), cell(sub_name), 'ativo', cell(plan), '10']),
        ]) + '\n')
        assert subscribers['totals']['created'] == 1, subscribers['totals']
        subscriber_batch = subscribers['batch_id']

        people = eligibility(subscriber_batch)
        assert people['status'] == 200, people['json']
        assert people['headers']['cache-control'] == 'no-store'
        clean = people['json']
        assert clean['eligible'] is True and clean['blockers'] == []
        assert clean['batch'] == {
            'id': subscriber_batch,
            'kind': 'subscribers',
            'source': marker,
            'created_at': clean['batch']['created_at'],
        }
        assert isinstance(clean['batch']['created_at'], str) and clean['batch']['created_at'].endswith('Z')
        assert isinstance(clean['checked_at'], str) and clean['checked_at'].endswith('Z')
        assert clean['checked_at'] >= clean['batch']['created_at']
        assert clean['evidence'] == {
            'reverted': False,
            'note': 'avaliação do estado atual; nenhuma reversão foi executada. Reversão futura deve compensar, não apagar, registros financeiros',
        }

        unknown = eligibility(subscriber_batch, '?tenant=other')
        assert unknown['status'] == 400 and unknown['json']['error'] == 'filtro desconhecido', unknown['json']
        repeated = eligibility(subscriber_batch, '?x=1&x=2')
        assert repeated['status'] == 400 and repeated['json']['error'] == 'filtro repetido', repeated['json']

        invoices = apply('invoices', '\n'.join([
            'id_externo;id_externo_assinante;vencimento;valor;situacao;pago_em;valor_pago',
            ';'.join([open_ext, marker, '2026-10-20', '99,90', 'aberto', '', '']),
        ]) + '\n')
        assert invoices['totals']['created'] == 1, invoices['totals']
        batch_id = invoices['batch_id']
        open_id = next(row['entity_id'] for row in invoices['sample'] if row['external_id'] == open_ext)

        fresh = eligibility(batch_id)
        assert fresh['status'] == 200 and fresh['headers']['cache-control'] == 'no-store', fresh['json']
        assert fresh['json']['eligible'] is True and fresh['json']['blockers'] == [], fresh['json']
        assert fresh['json']['batch']['id'] == batch_id and fresh['json']['batch']['kind'] == 'invoices'
        assert fresh['json']['batch']['source'] == marker
        assert fresh['json']['evidence']['reverted'] is False

        linked = eligibility(subscriber_batch)
        assert linked['status'] == 200, linked['json']
        assert linked['json']['eligible'] is False
        kinds = {item['kind']: item for item in linked['json']['blockers']}
        assert 'dependent_batches' in kinds, linked['json']['blockers']
        dependent = kinds['dependent_batches']
        assert dependent['count'] == 1 and batch_id in dependent['sample_ids'], dependent
        assert isinstance(dependent['count'], int) and not isinstance(dependent['count'], bool)
        assert 1 <= len(dependent['sample_ids']) <= 20
        assert 'invoices_created_after_import' in kinds, linked['json']['blockers']
        subscriber_later = kinds['invoices_created_after_import']
        assert subscriber_later['count'] >= 1 and open_id in subscriber_later['sample_ids'], subscriber_later

        later_ext = marker + '-later'
        later = apply('invoices', '\n'.join([
            'id_externo;id_externo_assinante;vencimento;valor;situacao;pago_em;valor_pago',
            ';'.join([later_ext, marker, '2026-11-20', '49,90', 'aberto', '', '']),
        ]) + '\n')
        assert later['totals']['created'] == 1, later['totals']
        later_id = next(row['entity_id'] for row in later['sample'] if row['external_id'] == later_ext)
        same = records(
            "select (a.contract_id = b.contract_id) as same_contract, (b.created_at > a.created_at) as later"
            " from invoices a join invoices b on true"
            " where a.id=" + quote(open_id) + "::uuid and b.id=" + quote(later_id) + "::uuid"
        )[0]
        assert same['same_contract'] is True and same['later'] is True, same
        untouched = eligibility(batch_id)
        assert untouched['status'] == 200, untouched['json']
        assert untouched['json']['eligible'] is True and untouched['json']['blockers'] == [], untouched['json']
        assert 'invoices_created_after_import' not in {item['kind'] for item in untouched['json']['blockers']}

        manual = api('/api/invoices/' + open_id + '/manual-payment', {
            'intent_id': str(uuid.uuid4()),
            'amount_cents': 9990,
            'paid_at': '2026-10-18',
            'note': 'Baixa posterior no Nexo',
        })
        assert manual['status'] == 200 and manual['json']['status'] == 'paid', manual['json']
        pay_id = records(
            "select id::text as id from payments where invoice_id=" + quote(open_id) + "::uuid and source='manual' order by created_at desc limit 1"
        )[0]['id']
        blocked = eligibility(batch_id)
        assert blocked['status'] == 200, blocked['json']
        body = blocked['json']
        assert body['eligible'] is False and body['evidence']['reverted'] is False
        payment_block = next(item for item in body['blockers'] if item['kind'] == 'payments_after_import')
        assert payment_block['count'] == 1, payment_block
        assert isinstance(payment_block['count'], int) and not isinstance(payment_block['count'], bool)
        assert pay_id in payment_block['sample_ids'], payment_block
        assert open_id not in payment_block['sample_ids']
        assert len(payment_block['sample_ids']) <= 20
        assert isinstance(payment_block['description'], str) and 'payments.id' in payment_block['description']
        for item in body['blockers']:
            assert item['count'] > 0 and item['sample_ids'] and len(item['sample_ids']) <= 20, item

        # Dois contratos do mesmo assinante, em lotes distintos. A fatura do
        # contrato anterior não referencia o contrato novo, então não bloqueia.
        sib = marker[:24] + '-sib'
        old_contract_ext = sib + '-c1'
        new_contract_ext = sib + '-c2'
        sib_people = apply('subscribers', '\n'.join([
            'id_externo;nome;situacao',
            ';'.join([cell(sib), cell('Assinante irmao ' + marker), 'ativo']),
        ]) + '\n')
        assert sib_people['totals']['created'] == 1, sib_people['totals']
        old_contracts = apply('contracts', '\n'.join([
            'id_externo;id_externo_assinante;plano;vencimento_dia',
            ';'.join([cell(old_contract_ext), cell(sib), cell(plan), '10']),
        ]) + '\n')
        assert old_contracts['totals']['created'] == 1, old_contracts['totals']
        old_contract_batch = old_contracts['batch_id']
        old_invoice_ext = sib + '-old'
        old_titles = apply('invoices', '\n'.join([
            'id_externo;id_externo_contrato;id_externo_assinante;vencimento;valor;situacao;pago_em;valor_pago',
            ';'.join([cell(old_invoice_ext), cell(old_contract_ext), cell(sib), '2026-09-20', '10,00', 'aberto', '', '']),
        ]) + '\n')
        assert old_titles['totals']['created'] == 1, old_titles['totals']
        old_invoice_batch = old_titles['batch_id']
        new_contracts = apply('contracts', '\n'.join([
            'id_externo;id_externo_assinante;plano;vencimento_dia',
            ';'.join([cell(new_contract_ext), cell(sib), cell(plan), '12']),
        ]) + '\n')
        assert new_contracts['totals']['created'] == 1, new_contracts['totals']
        new_contract_batch = new_contracts['batch_id']
        clean_contract = eligibility(new_contract_batch)
        assert clean_contract['status'] == 200, clean_contract['json']
        assert clean_contract['json']['eligible'] is True and clean_contract['json']['blockers'] == [], clean_contract['json']
        assert clean_contract['json']['batch']['kind'] == 'contracts'
        new_invoice_ext = sib + '-new'
        new_titles = apply('invoices', '\n'.join([
            'id_externo;id_externo_contrato;id_externo_assinante;vencimento;valor;situacao;pago_em;valor_pago',
            ';'.join([cell(new_invoice_ext), cell(new_contract_ext), cell(sib), '2026-12-20', '15,00', 'aberto', '', '']),
        ]) + '\n')
        assert new_titles['totals']['created'] == 1, new_titles['totals']
        new_invoice_batch = new_titles['batch_id']
        blocked_contract = eligibility(new_contract_batch)
        assert blocked_contract['status'] == 200, blocked_contract['json']
        assert blocked_contract['json']['eligible'] is False
        contract_kinds = {item['kind']: item for item in blocked_contract['json']['blockers']}
        assert 'dependent_batches' in contract_kinds, blocked_contract['json']['blockers']
        contract_dependent = contract_kinds['dependent_batches']
        assert contract_dependent['count'] == 1, contract_dependent
        assert new_invoice_batch in contract_dependent['sample_ids'], contract_dependent
        assert old_contract_batch not in contract_dependent['sample_ids'], contract_dependent
        assert old_invoice_batch not in contract_dependent['sample_ids'], contract_dependent

        # Assinante sem plano: a segunda carga só muda o nome e grava updated.
        # O lote que criou a entidade deixa de ser elegível.
        plain_ext = marker + '-plain'
        plain = apply('subscribers', '\n'.join([
            'id_externo;nome;situacao',
            ';'.join([cell(plain_ext), cell('Sem plano ' + marker), 'ativo']),
        ]) + '\n')
        assert plain['totals']['created'] == 1 and plain['totals']['updated'] == 0, plain['totals']
        plain_batch = plain['batch_id']
        plain_id = next(row['entity_id'] for row in plain['sample'] if row['external_id'] == plain_ext)
        plain_clean = eligibility(plain_batch)
        assert plain_clean['status'] == 200, plain_clean['json']
        assert plain_clean['json']['eligible'] is True and plain_clean['json']['blockers'] == [], plain_clean['json']
        renamed = apply('subscribers', '\n'.join([
            'id_externo;nome;situacao',
            ';'.join([cell(plain_ext), cell('Nome novo ' + marker), 'ativo']),
        ]) + '\n')
        assert renamed['totals']['created'] == 0 and renamed['totals']['updated'] == 1, renamed['totals']
        rename_row = next(row for row in renamed['sample'] if row['external_id'] == plain_ext)
        assert rename_row['status'] == 'updated' and rename_row['entity_id'] == plain_id, rename_row
        after_rename = eligibility(plain_batch)
        assert after_rename['status'] == 200, after_rename['json']
        assert after_rename['json']['eligible'] is False
        rename_kinds = {item['kind']: item for item in after_rename['json']['blockers']}
        assert set(rename_kinds) == {'dependent_batches'}, after_rename['json']['blockers']
        rename_dependent = rename_kinds['dependent_batches']
        assert rename_dependent['count'] == 1 and renamed['batch_id'] in rename_dependent['sample_ids'], rename_dependent
        assert plain_batch not in rename_dependent['sample_ids']

        beta_login = call('/api/auth/login', {'email': 'admin@beta.demo', 'password': 'demo1234', 'bearer': True})
        assert beta_login['status'] == 200, beta_login['json']
        hidden = call('/api/import/batches/' + batch_id + '/revert-eligibility', token=beta_login['json']['token'])
        assert hidden['status'] == 404, hidden['json']
        sql(
            "insert into pops(id,tenant_id,name) values(" + quote(pop) + "," + quote(alfa) + "," + quote('POP ' + marker[:20]) + ");"
            "insert into users(id,tenant_id,email,name,password_hash,role) select " + quote(restricted) + ",tenant_id," + quote(marker + '@synthetic.invalid') + ",'Revert POP fixture',password_hash,'noc' from users where email='admin@alfa.demo';"
            "insert into users(id,tenant_id,email,name,password_hash,role,subscriber_id) select " + quote(portal) + ",tenant_id," + quote(marker + '@portal.invalid') + ",'Revert portal fixture',password_hash,'subscriber'," + quote(plain_id) + "::uuid from users where email='admin@alfa.demo';"
            "insert into user_pops(tenant_id,user_id,pop_id) values(" + quote(alfa) + "," + quote(restricted) + "," + quote(pop) + ")",
            'nexo_test')
        pop_login = call('/api/auth/login', {'email': marker + '@synthetic.invalid', 'password': 'demo1234', 'bearer': True})
        assert pop_login['status'] == 200, pop_login['json']
        denied = call('/api/import/batches/' + batch_id + '/revert-eligibility', token=pop_login['json']['token'])
        assert denied['status'] == 403, denied['json']

        # call() do nativo não envia cabeçalho. O POST registrado lê Idempotency-Key do HTTP.
        defaults = api.__defaults__ or ()
        names = api.__code__.co_varnames[:api.__code__.co_argcount]
        bound = dict(zip(names[-len(defaults):], defaults)) if defaults else {}
        closed = inspect.getclosurevars(api).nonlocals
        base = bound.get('base') or closed.get('base')
        alfa_token = closed.get('token') or bound.get('token')
        assert isinstance(base, str) and base.startswith('http'), base
        assert isinstance(alfa_token, str) and alfa_token, alfa_token

        def markers(batch):
            return records(
                "select id::text as id, idempotency_key, request_hash, reason, result"
                " from import_batch_compensations where batch_id=" + quote(batch) + "::uuid"
            )

        def invoice_status(invoice_id):
            return records("select status from invoices where id=" + quote(invoice_id) + "::uuid")[0]['status']

        def movement_count(invoice_id):
            return records("select count(*)::int as n from invoice_movements where invoice_id=" + quote(invoice_id) + "::uuid")[0]['n']

        def post_compensate(batch, key, reason, token=None, query='', cookie=False):
            headers = {'Content-Type': 'application/json'}
            if key is not None:
                headers['Idempotency-Key'] = key
            return http_request(
                base,
                '/api/import/batches/' + batch + '/compensate' + query,
                token=alfa_token if token is None else token,
                cookie=cookie,
                method='POST',
                headers=headers,
                body=json.dumps({'reason': reason}).encode(),
            )

        def hides(page, secret):
            blob = json.dumps(page['json'])
            assert secret not in blob and 'idempotency_key' not in blob and 'request_hash' not in blob, page['json']

        refused = post_compensate(subscriber_batch, 'c25-kind-' + uuid.uuid4().hex[:12], 'Lote de assinante nao compensa')
        assert refused['status'] == 409 and refused['json']['error'] == 'kind_not_compensatable', refused['json']
        assert markers(subscriber_batch) == []
        still_people = eligibility(subscriber_batch)
        assert still_people['json']['eligible'] is False
        assert any(item['kind'] == 'dependent_batches' for item in still_people['json']['blockers'])

        cmp_ext = marker + '-cmp'
        opened = apply('invoices', '\n'.join([
            'id_externo;id_externo_assinante;vencimento;valor;situacao;pago_em;valor_pago',
            ';'.join([cell(cmp_ext), cell(marker), '2026-10-25', '30,00', 'aberto', '', '']),
        ]) + '\n')
        assert opened['totals']['created'] == 1, opened['totals']
        cmp_batch = opened['batch_id']
        cmp_invoice = next(row['entity_id'] for row in opened['sample'] if row['external_id'] == cmp_ext)
        moves = movement_count(cmp_invoice)
        assert invoice_status(cmp_invoice) == 'open' and markers(cmp_batch) == []
        absent = eligibility(cmp_batch)
        assert absent['json']['eligible'] is True and absent['json']['blockers'] == []
        assert absent['json']['evidence'] == {'reverted': False, 'note': READ_NOTE}
        assert absent['json']['compensation'] == {'state': 'absent'}

        beta_token = beta_login['json']['token']
        pop_token = pop_login['json']['token']
        portal_login = call('/api/auth/login', {'email': marker + '@portal.invalid', 'password': 'demo1234', 'bearer': True})
        assert portal_login['status'] == 200, portal_login['json']
        portal_token = portal_login['json']['token']
        operator = call('/api/auth/login', {'email': 'operador@nexoisp.demo', 'password': 'demo1234', 'bearer': True})
        assert operator['status'] == 200, operator['json']
        entered = call('/api/support/enter', {'tenant_id': alfa, 'reason': 'ensaio de escopo'}, token=operator['json']['token'])
        assert entered['status'] == 200, entered['json']
        support_token = operator['json']['token']
        cookie_login = call('/api/auth/login', {'email': 'admin@alfa.demo', 'password': 'demo1234'})
        assert cookie_login['status'] == 200, cookie_login['json']
        set_cookie = cookie_login['headers'].get('set-cookie', '')
        assert set_cookie.startswith('nexo_session='), set_cookie
        session = set_cookie.split(';', 1)[0].split('=', 1)[1]

        def gate(token, status, error=None):
            seen = call('/api/import/batches/' + cmp_batch + '/revert-eligibility', token=token)
            assert seen['status'] == status, seen['json']
            if error is not None:
                assert seen['json']['error'] == error, seen['json']
            posted = post_compensate(cmp_batch, 'c25-gate-' + uuid.uuid4().hex[:12], 'Escopo nao compensa o lote', token=token)
            assert posted['status'] == status, posted['json']
            if error is not None:
                assert posted['json']['error'] == error, posted['json']
            assert markers(cmp_batch) == [] and invoice_status(cmp_invoice) == 'open'

        me = None
        for _ in range(40):
            me = call('/api/me', token=support_token)
            if me['status'] == 200 and me['json'].get('support') is True:
                break
            time.sleep(0.05)
        assert me['status'] == 200 and me['json'].get('support') is True, me['json']
        gate(beta_token, 404)
        gate(pop_token, 403)
        gate(portal_token, 403)
        gate(support_token, 403, SCOPE_ERROR)
        cookie_get = http_request(base, '/api/import/batches/' + cmp_batch + '/revert-eligibility', token=session, cookie=True)
        assert cookie_get['status'] == 200 and cookie_get['json']['compensation'] == {'state': 'absent'}, cookie_get['json']
        assert cookie_get['json']['evidence']['reverted'] is False
        csrf_denied = post_compensate(cmp_batch, 'c25-csrf-' + uuid.uuid4().hex[:12], 'Sem CSRF de sessao cookie', token=session, cookie=True)
        assert csrf_denied['status'] == 403 and csrf_denied['json']['error'] == 'requisição sem proteção CSRF', csrf_denied['json']
        assert markers(cmp_batch) == [] and invoice_status(cmp_invoice) == 'open' and movement_count(cmp_invoice) == moves

        missing_key = post_compensate(cmp_batch, None, 'Motivo valido do lote')
        assert missing_key['status'] == 400, missing_key['json']
        short = post_compensate(cmp_batch, 'c25-short-' + uuid.uuid4().hex[:8], 'curto')
        assert short['status'] == 400, short['json']
        unknown = post_compensate(cmp_batch, 'c25-query-' + uuid.uuid4().hex[:8], 'Motivo valido do lote', query='?tenant=other')
        assert unknown['status'] == 400 and unknown['json']['error'] == 'filtro desconhecido', unknown['json']
        repeated = post_compensate(cmp_batch, 'c25-repeat-' + uuid.uuid4().hex[:8], 'Motivo valido do lote', query='?x=1&x=2')
        assert repeated['status'] == 400 and repeated['json']['error'] == 'filtro repetido', repeated['json']
        assert markers(cmp_batch) == [] and invoice_status(cmp_invoice) == 'open'

        reason = '  Compensar lote de laboratório  '
        trimmed = reason.strip()
        key = 'c25-' + uuid.uuid4().hex
        assert 8 <= len(key) <= 200 and 10 <= len(trimmed) <= 200
        created = post_compensate(cmp_batch, key, reason)
        assert created['status'] == 200, created['json']
        body = created['json']
        compensation_id = str(uuid.UUID(body['compensation_id']))
        assert body['batch_id'] == cmp_batch and body['compensation_id'] == compensation_id
        assert body['idempotent_replay'] is False
        assert [body[name] for name in COUNT_NAMES] == [1, 0, 1, 0, 0, 0]
        for name in COUNT_NAMES:
            assert isinstance(body[name], int) and not isinstance(body[name], bool)
        assert body['evidence'] == {'reverted': False, 'note': WRITE_NOTE}
        hides(created, key)
        assert invoice_status(cmp_invoice) == 'canceled'
        assert movement_count(cmp_invoice) == moves + 1
        stored = markers(cmp_batch)
        assert len(stored) == 1, stored
        assert stored[0]['id'] == compensation_id
        assert stored[0]['idempotency_key'] == key and stored[0]['request_hash']
        assert stored[0]['reason'] == trimmed
        assert stored[0]['result'] == body

        committed = peek(cmp_batch)
        assert committed['status'] == 200, committed['json']
        view = committed['json']
        comp = view['compensation']
        assert view['evidence'] == {'reverted': False, 'note': READ_NOTE}
        assert set(comp) == {'state', 'compensation_id', 'created_at', 'reason', 'result'}
        assert comp['state'] == 'committed' and comp['compensation_id'] == compensation_id
        assert isinstance(comp['created_at'], str) and comp['created_at'].endswith('Z') and 'T' in comp['created_at']
        assert comp['reason'] == trimmed and comp['result'] == body
        assert view['eligible'] is False
        assert 'invoice_movements_after_import' in {item['kind'] for item in view['blockers']}
        hides(committed, key)
        assert movement_count(cmp_invoice) == moves + 1 and len(markers(cmp_batch)) == 1

        replay = post_compensate(cmp_batch, key, reason)
        assert replay['status'] == 200, replay['json']
        again = replay['json']
        assert again['idempotent_replay'] is True and again['compensation_id'] == compensation_id
        assert again['batch_id'] == cmp_batch and again['evidence'] == body['evidence']
        assert [again[name] for name in COUNT_NAMES] == [body[name] for name in COUNT_NAMES]
        hides(replay, key)
        assert len(markers(cmp_batch)) == 1 and movement_count(cmp_invoice) == moves + 1
        reread = peek(cmp_batch)
        assert reread['json']['evidence']['reverted'] is False
        assert reread['json']['compensation']['result'] == body
        assert reread['json']['compensation']['result']['idempotent_replay'] is False
        assert movement_count(cmp_invoice) == moves + 1

        other = post_compensate(cmp_batch, 'c25-other-' + uuid.uuid4().hex, trimmed)
        assert other['status'] == 409 and other['json']['error'] == 'already_compensated', other['json']
        clash = post_compensate(cmp_batch, key, trimmed + ' diferente')
        assert clash['status'] == 409 and clash['json']['error'] == 'idempotency_conflict', clash['json']
        assert len(markers(cmp_batch)) == 1 and movement_count(cmp_invoice) == moves + 1

        leaked = call('/api/import/batches/' + cmp_batch + '/revert-eligibility', token=beta_token)
        assert leaked['status'] == 404, leaked['json']
        assert compensation_id not in json.dumps(leaked['json'])
        for token in (pop_token, portal_token, support_token):
            hidden_get = call('/api/import/batches/' + cmp_batch + '/revert-eligibility', token=token)
            hidden_post = post_compensate(cmp_batch, 'c25-late-' + uuid.uuid4().hex[:12], 'Escopo nao compensa o lote', token=token)
            assert hidden_get['status'] == 403 and hidden_post['status'] == 403, (hidden_get['json'], hidden_post['json'])
            assert compensation_id not in json.dumps(hidden_get['json']) and compensation_id not in json.dumps(hidden_post['json'])
        assert len(markers(cmp_batch)) == 1 and movement_count(cmp_invoice) == moves + 1
        left = call('/api/support/exit', {}, token=support_token)
        assert left['status'] == 200, left['json']
        support_token = None
        return {'ok': True, 'checks': ['lote de assinantes limpo é elegível', 'lote de títulos limpo é elegível', 'fatura posterior do mesmo contrato não bloqueia o lote de títulos', 'baixa posterior bloqueia com payments.id', 'lote dependente bloqueia o lote de assinantes', 'lote de contratos ignora irmãos e a fatura deles', 'fatura do contrato novo bloqueia o lote de contratos', 'reimportação com atualização bloqueia o lote original', 'outro tenant 404', 'POP 403', 'portal 403', 'suporte 403', 'consulta não altera contagens', 'compensação ausente antes do POST', 'POST committed com contagens do result', 'replay sem efeito novo e reverted false']}
    finally:
        if support_token:
            try:
                call('/api/support/exit', {}, token=support_token)
            except Exception:
                pass
        sql(
            "begin;"
            "alter table import_batch_compensations disable trigger immutable_import_batch_compensations;"
            "delete from import_batch_compensations where batch_id in (select id from import_batches where source=" + quote(marker) + ");"
            "alter table import_batch_compensations enable trigger immutable_import_batch_compensations;"
            "alter table payments disable trigger immutable_payments;"
            "alter table invoice_movements disable trigger immutable_invoice_movements;"
            "delete from manual_payment_intents where invoice_id in (select id from invoices where external_source=" + quote(marker) + ");"
            "delete from payments where invoice_id in (select id from invoices where external_source=" + quote(marker) + ");"
            "delete from invoice_items where invoice_id in (select id from invoices where external_source=" + quote(marker) + ");"
            "delete from invoice_movements where invoice_id in (select id from invoices where external_source=" + quote(marker) + ");"
            "delete from payment_effects where invoice_id in (select id from invoices where external_source=" + quote(marker) + ");"
            "delete from agreement_sources where invoice_id in (select id from invoices where external_source=" + quote(marker) + ");"
            "delete from audit_events where entity_type='invoice' and entity_id in (select id::text from invoices where external_source=" + quote(marker) + ");"
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
            "delete from sessions where user_id=" + quote(restricted) + "::uuid or user_id=" + quote(portal) + "::uuid;"
            "delete from users where id=" + quote(restricted) + "::uuid or id=" + quote(portal) + "::uuid;"
            "delete from pops where id=" + quote(pop) + "::uuid;"
            "commit;",
            'nexo_test')
