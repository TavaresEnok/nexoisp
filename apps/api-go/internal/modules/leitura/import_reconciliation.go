package leitura

import (
	"context"
	"net/http"
	"net/url"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/validate"
)

// importReconciliationScope matches accountingScope: portal, POP and support
// sessions never see a batch balance. The permission remains import:run.
func importReconciliationScope(ctx context.Context) error {
	actor := auth.From(ctx)
	if actor == nil || actor.TenantID == "" || actor.SubscriberID != "" || actor.PopIDs != nil || actor.Support {
		return apierr.New(403, "a reconciliação do lote exige escopo integral do provedor, fora do suporte")
	}
	return nil
}

// No query parameter is defined. Repeated and unknown filters follow parseHistory.
func rejectImportReconciliationQuery(q url.Values) error {
	for _, values := range q {
		if len(values) != 1 {
			return apierr.New(400, "filtro repetido")
		}
		return apierr.New(400, "filtro desconhecido")
	}
	return nil
}

func parseImportReconciliationRequest(id string, q url.Values) error {
	if err := rejectImportReconciliationQuery(q); err != nil {
		return err
	}
	return validate.UUID(id)
}

// entity_id stored on import_rows (importacao.go / importacao_ampliada.go):
//   - kind subscribers: subscribers.id. importSubscriber returns the subscriber,
//     not the contract created in the same row.
//   - kind contracts: contracts.id. importContract returns the inserted contract.
//   - kind invoices: invoices.id. importInvoice returns the inserted invoice.
//
// contracts_by_status reads the current Nexo state of those created entities:
// subscribers match contracts.subscriber_id, contracts match contracts.id.
// resources_pending_provision uses the same predicate as queries/read20240638.sql
// (external_source = batch source, external_id on a row of this batch,
// desired_version = 0, secret_enc is not null).
// Money leaves PostgreSQL as exact decimal text. Counts stay integers.
// legacy_issuance_violations counts batch invoices that gained a provider charge;
// a legacy title must stay at zero.
const importReconciliationSQL = `
with b as (
  select id, kind, source, filename, created_at, totals, tenant_id
  from import_batches
  where id = $1::uuid
),
stats as (
  select
    (count(*) filter (where ir.status = 'created'))::int as created,
    (count(*) filter (where ir.status = 'updated'))::int as updated,
    (count(*) filter (where ir.status = 'unchanged'))::int as unchanged,
    (count(*) filter (where ir.status = 'error'))::int as error,
    (count(*) filter (where ir.messages <> '[]'::jsonb))::int as with_messages
  from import_rows ir
  where ir.batch_id = (select id from b)
),
created_entities as (
  select ir.entity_id
  from import_rows ir
  where ir.batch_id = (select id from b)
    and ir.status = 'created'
    and ir.entity_id is not null
),
inv as (
  select i.id, i.contract_id, i.amount_cents, i.status, i.canceled_at,
         coalesce((select sum(p.signed_cents)::bigint from payments p where p.invoice_id = i.id), 0) as received,
         coalesce((select sum(p.signed_cents)::bigint from payments p where p.invoice_id = i.id and p.created_at > b.created_at), 0) as received_after,
         (i.provider_issuance_id is not null
           or i.gateway_charge_id is not null
           or exists (select 1 from provider_issuance j where j.invoice_id = i.id and j.tenant_id = i.tenant_id)) as legacy_violation
  from b
  join import_rows ir on ir.batch_id = b.id and ir.status = 'created' and ir.entity_id is not null
  join invoices i on i.id = ir.entity_id and i.tenant_id = ir.tenant_id
  where b.kind = 'invoices'
)
select json_build_object(
  'batch', json_build_object(
    'id', b.id,
    'kind', b.kind,
    'source', b.source,
    'filename', b.filename,
    'created_at', to_char(b.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'totals', b.totals
  ),
  'rows', json_build_object(
    'created', (select created from stats),
    'updated', (select updated from stats),
    'unchanged', (select unchanged from stats),
    'error', (select error from stats),
    'with_messages', (select with_messages from stats)
  ),
  'invoices', case when b.kind = 'invoices' then json_build_object(
    'count', (select count(*)::int from inv),
    'by_status', json_build_object(
      'open', (select (count(*) filter (where status = 'open'))::int from inv),
      'paid', (select (count(*) filter (where status = 'paid'))::int from inv),
      'reconciling', (select (count(*) filter (where status = 'reconciling'))::int from inv),
      'canceled', (select (count(*) filter (where status = 'canceled'))::int from inv)
    ),
    'missing', (
      select count(*)::int
      from import_rows ir
      where ir.batch_id = b.id
        and ir.status = 'created'
        and ir.entity_id is not null
        and not exists (select 1 from invoices i where i.id = ir.entity_id and i.tenant_id = ir.tenant_id)
    ),
    'amount_cents', coalesce((select sum(amount_cents) from inv), 0)::bigint::text,
    'received_cents', coalesce((select sum(received) from inv), 0)::bigint::text,
    'received_after_import_cents', coalesce((select sum(received_after) from inv), 0)::bigint::text,
    'open_residual_cents', coalesce((
      select sum(greatest(amount_cents::bigint - received, 0)) filter (where status in ('open', 'reconciling'))
      from inv
    ), 0)::bigint::text,
    'canceled_after_import', (
      select (count(*) filter (where status = 'canceled' and canceled_at > b.created_at))::int from inv
    ),
    'legacy_issuance_violations', (select (count(*) filter (where legacy_violation))::int from inv),
    'by_contract', coalesce((
      select json_agg(json_build_object(
        'contract_id', g.contract_id,
        'invoices', g.invoices,
        'open_residual_cents', g.residual::text
      ) order by g.residual desc, g.contract_id)
      from (
        select contract_id::text as contract_id,
               count(*)::int as invoices,
               sum(case when status in ('open', 'reconciling') then greatest(amount_cents::bigint - received, 0) else 0 end)::bigint as residual
        from inv
        group by contract_id
        order by residual desc, contract_id
        limit 500
      ) g
    ), '[]'::json)
  ) else null end,
  'contracts', case when b.kind in ('subscribers', 'contracts') then json_build_object(
    'entities_created', (select count(*)::int from created_entities),
    'contracts_by_status', coalesce((
      select json_object_agg(status, n order by status)
      from (
        select k.status, count(*)::int as n
        from contracts k
        where k.tenant_id = b.tenant_id
          and (
            (b.kind = 'subscribers' and k.subscriber_id in (select entity_id from created_entities))
            or (b.kind = 'contracts' and k.id in (select entity_id from created_entities))
          )
        group by k.status
      ) statuses
    ), '{}'::json),
    'resources_pending_provision', (
      select count(*)::int
      from service_resources r
      join import_rows ir on ir.batch_id = b.id and ir.external_id = r.external_id
      where r.external_source = b.source
        and r.tenant_id = b.tenant_id
        and r.desired_version = 0
        and r.secret_enc is not null
    )
  ) else null end,
  'generated_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'source', 'import_rows',
  'evidence', json_build_object(
    'snapshot', false,
    'note', 'estado atual do Nexo; não comprova saldo na instituição de origem'
  )
) as payload
from b`

func registerImportReconciliation(api huma.API, r *endpoint.Registry, s Service) {
	r.Get(api, "/api/import/batches/{id}/reconciliation", "import:run", false, func(ctx context.Context, req *http.Request) (endpoint.Result, error) {
		if err := importReconciliationScope(ctx); err != nil {
			return endpoint.Result{}, err
		}
		if err := parseImportReconciliationRequest(chi.URLParam(req, "id"), req.URL.Query()); err != nil {
			return endpoint.Result{}, err
		}
		rows, err := s.rows(ctx, importReconciliationSQL, chi.URLParam(req, "id"))
		if err != nil {
			return endpoint.Result{}, err
		}
		if len(rows) == 0 || rows[0].Get("payload") == nil {
			return endpoint.Result{}, apierr.New(404, "lote não encontrado")
		}
		return endpoint.Result{Value: rows[0].Get("payload"), CacheControl: "no-store"}, nil
	})
}
