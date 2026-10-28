"""Elegibilidade somente leitura para reverter um lote importado.
Chamado por nativo.py. A consulta não altera dados. A baixa manual é uma ação já existente.
payments_after_import.sample_ids traz payments.id (não o id da fatura).
dependent_batches.sample_ids traz import_batches.id dos outros lotes.
Uma reimportação do mesmo assinante com nome alterado grava status updated
e também entra em dependent_batches do lote que criou a entidade.
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

    def counts():
        row = records(
            "select (select count(*)::int from invoices) as invoices,"
            "(select count(*)::int from payments) as payments,"
            "(select count(*)::int from contracts) as contracts")[0]
        return (row['invoices'], row['payments'], row['contracts'])

    marker = 'b13v-' + uuid.uuid4().hex
    open_ext = marker + '-open'
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

    def eligibility(batch_id, query=''):
        before = counts()
        page = api('/api/import/batches/' + batch_id + '/revert-eligibility' + query)
        after = counts()
        assert before == after, (before, after, page['json'])
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
            "insert into user_pops(tenant_id,user_id,pop_id) values(" + quote(alfa) + "," + quote(restricted) + "," + quote(pop) + ")",
            'nexo_test')
        pop_login = call('/api/auth/login', {'email': marker + '@synthetic.invalid', 'password': 'demo1234', 'bearer': True})
        assert pop_login['status'] == 200, pop_login['json']
        denied = call('/api/import/batches/' + batch_id + '/revert-eligibility', token=pop_login['json']['token'])
        assert denied['status'] == 403, denied['json']
        return {'ok': True, 'checks': ['lote de assinantes limpo é elegível', 'lote de títulos limpo é elegível', 'fatura posterior do mesmo contrato não bloqueia o lote de títulos', 'baixa posterior bloqueia com payments.id', 'lote dependente bloqueia o lote de assinantes', 'lote de contratos ignora irmãos e a fatura deles', 'fatura do contrato novo bloqueia o lote de contratos', 'reimportação com atualização bloqueia o lote original', 'outro tenant 404', 'POP 403', 'consulta não altera contagens']}
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
