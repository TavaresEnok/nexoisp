package leitura

import (
	"context"
	"net/http"
	"net/url"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/endpoint"
)

// importRevertEligibilityScope reuses the batch reconciliation gate: portal,
// POP and support sessions never evaluate a revert. The permission remains import:run.
func importRevertEligibilityScope(ctx context.Context) error {
	return importReconciliationScope(ctx)
}

// No query parameter is defined. Repeated and unknown filters follow the reconciliation route.
func parseImportRevertEligibilityRequest(id string, q url.Values) error {
	return parseImportReconciliationRequest(id, q)
}

// entity_id on import_rows (same mapping as importReconciliationSQL):
//   - subscribers => subscribers.id (not the contract created in the same row)
//   - contracts   => contracts.id
//   - invoices    => invoices.id
//
// Only status='created' rows with entity_id define this batch. Import writes
// the batch and its rows in one transaction, so original created_at,
// recorded_at and contract_history.at equal b.created_at. Posterior means
// strictly greater than b.created_at.
//
// Invoice universe: kind invoices => those invoices; kind subscribers or
// contracts => invoices of the involved contracts. Contract universe: kind
// contracts => the batch contracts; kind subscribers => contracts of those
// subscribers; kind invoices => contracts of the batch invoices, used only
// for operations and notices tied to those invoices. A title batch is not
// blocked by contract effects that do not involve its invoices. Notices and
// payments of the invoices themselves still count. invoices_created_after_import
// is one of those contract effects: only subscriber and contract batches. A
// later invoice on the same contract does not block an invoice batch.
//
// payments_after_import samples payments.id. dependent_batches samples the
// other import_batches.id. Rows of those other batches count when they
// reference this batch's entities with status created, updated or unchanged.
// A later reimport that only changes the subscriber name writes updated and
// still blocks the original batch. Error rows are not references. Kind
// subscribers expands to later contracts and invoices of those subscribers.
// Kind contracts expands only to rows that reference the contracts this
// batch created (their invoices). Sibling contracts of the same subscriber,
// and invoices of those siblings, do not block a contract batch. Kind
// invoices matches entity_id only. Blockers with count 0 are omitted.
const importRevertEligibilitySQL = `
with b as (
  select id, kind, source, created_at, tenant_id
  from import_batches
  where id = $1::uuid
),
created_entities as (
  select ir.entity_id
  from import_rows ir
  join b on b.id = ir.batch_id
  where ir.status = 'created'
    and ir.entity_id is not null
),
batch_subscribers as (
  select s.id
  from b
  join subscribers s on s.tenant_id = b.tenant_id
  where (b.kind = 'subscribers' and s.id in (select entity_id from created_entities))
     or (b.kind = 'contracts' and s.id in (
          select k.subscriber_id from contracts k
          where k.tenant_id = b.tenant_id and k.id in (select entity_id from created_entities)))
     or (b.kind = 'invoices' and s.id in (
          select i.subscriber_id from invoices i
          where i.tenant_id = b.tenant_id and i.id in (select entity_id from created_entities)))
),
batch_contracts as (
  select k.id
  from b
  join contracts k on k.tenant_id = b.tenant_id
  where (b.kind = 'contracts' and k.id in (select entity_id from created_entities))
     or (b.kind = 'subscribers' and k.subscriber_id in (select entity_id from created_entities))
     or (b.kind = 'invoices' and k.id in (
          select i.contract_id from invoices i
          where i.tenant_id = b.tenant_id and i.id in (select entity_id from created_entities)))
),
batch_invoices as (
  select i.id
  from b
  join invoices i on i.tenant_id = b.tenant_id
  where (b.kind = 'invoices' and i.id in (select entity_id from created_entities))
     or (b.kind in ('subscribers', 'contracts') and i.contract_id in (select id from batch_contracts))
),
pay_ids as (
  select p.id::text as id
  from b
  join payments p on p.tenant_id = b.tenant_id and p.created_at > b.created_at
  where p.invoice_id in (select id from batch_invoices)
),
movement_ids as (
  select m.id::text as id
  from b
  join invoice_movements m on m.tenant_id = b.tenant_id and m.recorded_at > b.created_at
  where m.invoice_id in (select id from batch_invoices)
),
issuance_ids as (
  select i.id::text as id
  from b
  join invoices i on i.tenant_id = b.tenant_id
  where i.id in (select id from batch_invoices)
    and (
      i.gateway_charge_id is not null
      or i.provider_issuance_id is not null
      or exists (
        select 1 from provider_issuance j
        where j.invoice_id = i.id and j.tenant_id = i.tenant_id
      )
    )
),
effect_ids as (
  select pe.id::text as id
  from b
  join payment_effects pe on pe.tenant_id = b.tenant_id and pe.created_at > b.created_at
  where pe.invoice_id in (select id from batch_invoices)
),
notice_ids as (
  select n.id::text as id
  from b
  join notice_log n on n.tenant_id = b.tenant_id
  where n.invoice_id in (select id from batch_invoices)
     or (
       b.kind in ('subscribers', 'contracts')
       and (
         n.contract_id in (select id from batch_contracts)
         or n.subscriber_id in (select id from batch_subscribers)
       )
     )
),
operation_ids as (
  select o.id::text as id
  from b
  join service_resources r on r.tenant_id = b.tenant_id
  join operations o on o.tenant_id = r.tenant_id and o.resource_id = r.id
  where r.contract_id in (select id from batch_contracts)
    and (
      b.kind in ('subscribers', 'contracts')
      or (
        b.kind = 'invoices'
        and exists (
          select 1 from payment_effects pe
          where pe.tenant_id = b.tenant_id
            and pe.operation_id = o.id
            and pe.invoice_id in (select id from batch_invoices)
        )
      )
    )
),
resource_ids as (
  select r.id::text as id
  from b
  join service_resources r on r.tenant_id = b.tenant_id
  where b.kind in ('subscribers', 'contracts')
    and r.contract_id in (select id from batch_contracts)
    and r.desired_version > 0
),
history_ids as (
  select h.id::text as id
  from b
  join contract_history h on h.tenant_id = b.tenant_id and h.at > b.created_at
  where b.kind in ('subscribers', 'contracts')
    and h.contract_id in (select id from batch_contracts)
),
later_invoice_ids as (
  select i.id::text as id
  from b
  join invoices i on i.tenant_id = b.tenant_id and i.created_at > b.created_at
  where b.kind in ('subscribers', 'contracts')
    and i.contract_id in (select id from batch_contracts)
    and not exists (
      select 1 from import_rows ir
      where ir.batch_id = b.id and ir.status = 'created' and ir.entity_id = i.id
    )
),
support_ids as (
  select t.id::text as id
  from b
  join tickets t on t.tenant_id = b.tenant_id
  where b.kind in ('subscribers', 'contracts')
    and (t.subscriber_id in (select id from batch_subscribers) or t.contract_id in (select id from batch_contracts))
    and (
      t.created_at > b.created_at
      or exists (
        select 1 from import_rows o
        where o.tenant_id = t.tenant_id and o.batch_id <> b.id and o.status = 'created' and o.entity_id = t.id
      )
    )
  union all
  select w.id::text
  from b
  join work_orders w on w.tenant_id = b.tenant_id
  where b.kind in ('subscribers', 'contracts')
    and (w.subscriber_id in (select id from batch_subscribers) or w.contract_id in (select id from batch_contracts))
    and (
      w.created_at > b.created_at
      or exists (
        select 1 from import_rows o
        where o.tenant_id = w.tenant_id and o.batch_id <> b.id and o.status = 'created' and o.entity_id = w.id
      )
    )
  union all
  select sn.id::text
  from b
  join subscriber_notes sn on sn.tenant_id = b.tenant_id
  where b.kind in ('subscribers', 'contracts')
    and (sn.subscriber_id in (select id from batch_subscribers) or sn.contract_id in (select id from batch_contracts))
    and (
      sn.created_at > b.created_at
      or exists (
        select 1 from import_rows o
        where o.tenant_id = sn.tenant_id and o.batch_id <> b.id and o.status = 'created' and o.entity_id = sn.id
      )
    )
),
dependent_ids as (
  select distinct ob.id::text as id
  from b
  join import_rows o on o.tenant_id = b.tenant_id and o.batch_id <> b.id
    and o.status in ('created', 'updated', 'unchanged') and o.entity_id is not null
  join import_batches ob on ob.id = o.batch_id and ob.tenant_id = o.tenant_id
  where o.entity_id in (select entity_id from created_entities)
     or (
       b.kind = 'subscribers'
       and (
         exists (
           select 1 from contracts k
           where k.tenant_id = b.tenant_id and k.id = o.entity_id
             and k.subscriber_id in (select id from batch_subscribers)
         )
         or exists (
           select 1 from invoices i
           where i.tenant_id = b.tenant_id and i.id = o.entity_id
             and (
               i.subscriber_id in (select id from batch_subscribers)
               or i.contract_id in (select id from batch_contracts)
             )
         )
       )
     )
     or (
       b.kind = 'contracts'
       and exists (
         select 1 from invoices i
         where i.tenant_id = b.tenant_id and i.id = o.entity_id
           and i.contract_id in (select id from batch_contracts)
       )
     )
)
select json_build_object(
  'batch', json_build_object(
    'id', b.id,
    'kind', b.kind,
    'source', b.source,
    'created_at', to_char(b.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ),
  'eligible', found.n = 0,
  'blockers', found.items,
  'checked_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'evidence', json_build_object(
    'reverted', false,
    'note', 'avaliação do estado atual; nenhuma reversão foi executada. Reversão futura deve compensar, não apagar, registros financeiros'
  )
) as payload
from b
cross join lateral (
  select coalesce(json_agg(json_build_object(
           'kind', g.kind,
           'count', g.n,
           'sample_ids', g.sample,
           'description', g.description
         ) order by g.ord), '[]'::json) as items,
         count(g.kind)::int as n
  from (
    select 10 as ord, 'payments_after_import' as kind,
           (select count(*)::int from pay_ids) as n,
           coalesce((select json_agg(s.id order by s.id) from (select id from pay_ids order by id limit 20) s), '[]'::json) as sample,
           'Pagamentos lançados após a importação do lote. A amostra lista o id do pagamento (payments.id).' as description
    union all
    select 20, 'invoice_movements_after_import',
           (select count(*)::int from movement_ids),
           coalesce((select json_agg(s.id order by s.id) from (select id from movement_ids order by id limit 20) s), '[]'::json),
           'Movimentos de fatura registrados após a importação. A amostra lista ids de invoice_movements.'
    union all
    select 30, 'provider_issuance',
           (select count(*)::int from issuance_ids),
           coalesce((select json_agg(s.id order by s.id) from (select id from issuance_ids order by id limit 20) s), '[]'::json),
           'Faturas com emissão no PSP ou identificador de cobrança. A amostra lista ids de invoices.'
    union all
    select 40, 'payment_effects',
           (select count(*)::int from effect_ids),
           coalesce((select json_agg(s.id order by s.id) from (select id from effect_ids order by id limit 20) s), '[]'::json),
           'Efeitos de pagamento criados após a importação. A amostra lista ids de payment_effects.'
    union all
    select 50, 'notices',
           (select count(*)::int from notice_ids),
           coalesce((select json_agg(s.id order by s.id) from (select id from notice_ids order by id limit 20) s), '[]'::json),
           'Avisos ligados às faturas, contratos ou assinantes do lote. A amostra lista ids de notice_log.'
    union all
    select 60, 'network_operations',
           (select count(*)::int from operation_ids),
           coalesce((select json_agg(s.id order by s.id) from (select id from operation_ids order by id limit 20) s), '[]'::json),
           'Operações de rede dos recursos dos contratos envolvidos. Num lote de títulos, só entra operação ligada à fatura. A amostra lista ids de operations.'
    union all
    select 70, 'resources_provisioned',
           (select count(*)::int from resource_ids),
           coalesce((select json_agg(s.id order by s.id) from (select id from resource_ids order by id limit 20) s), '[]'::json),
           'Recursos de serviço dos contratos com versão desejada já acima de zero. A amostra lista ids de service_resources.'
    union all
    select 80, 'contract_history_after_import',
           (select count(*)::int from history_ids),
           coalesce((select json_agg(s.id order by s.id) from (select id from history_ids order by id limit 20) s), '[]'::json),
           'Histórico de contrato posterior à importação. A amostra lista ids de contract_history.'
    union all
    select 90, 'invoices_created_after_import',
           (select count(*)::int from later_invoice_ids),
           coalesce((select json_agg(s.id order by s.id) from (select id from later_invoice_ids order by id limit 20) s), '[]'::json),
           'Faturas dos contratos envolvidos criadas depois e que não pertencem a este lote. Vale só para lotes de assinantes e de contratos; um lote de títulos não é bloqueado por outra fatura do mesmo contrato. A amostra lista ids de invoices.'
    union all
    select 100, 'support_records',
           (select count(*)::int from support_ids),
           coalesce((select json_agg(s.id order by s.id) from (select id from support_ids order by id limit 20) s), '[]'::json),
           'Atendimentos, ordens de serviço ou anotações posteriores à importação, ou importados por outro lote. A amostra lista esses ids.'
    union all
    select 110, 'dependent_batches',
           (select count(*)::int from dependent_ids),
           coalesce((select json_agg(s.id order by s.id) from (select id from dependent_ids order by id limit 20) s), '[]'::json),
           'Outros lotes do provedor cujas linhas criadas, atualizadas ou inalteradas referenciam entidades deste lote, inclusive uma reimportação que só altera o nome. Para contratos, só entram linhas que apontam para os contratos criados pelo lote, não contratos irmãos do mesmo assinante nem as faturas deles. A amostra lista ids de import_batches.'
  ) g
  where g.n > 0
) found`

func registerImportRevertEligibility(api huma.API, r *endpoint.Registry, s Service) {
	r.Get(api, "/api/import/batches/{id}/revert-eligibility", "import:run", false, func(ctx context.Context, req *http.Request) (endpoint.Result, error) {
		if err := importRevertEligibilityScope(ctx); err != nil {
			return endpoint.Result{}, err
		}
		if err := parseImportRevertEligibilityRequest(chi.URLParam(req, "id"), req.URL.Query()); err != nil {
			return endpoint.Result{}, err
		}
		rows, err := s.rows(ctx, importRevertEligibilitySQL, chi.URLParam(req, "id"))
		if err != nil {
			return endpoint.Result{}, err
		}
		if len(rows) == 0 || rows[0].Get("payload") == nil {
			return endpoint.Result{}, apierr.New(404, "lote não encontrado")
		}
		return endpoint.Result{Value: rows[0].Get("payload"), CacheControl: "no-store"}, nil
	})
}
