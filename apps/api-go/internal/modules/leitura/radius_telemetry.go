package leitura

import (
	"context"
	"net/http"
	"net/url"

	"github.com/danielgtaylor/huma/v2"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
)

// One row per RADIUS concentrator, plus database metadata even when the tenant
// has no NAS. The meta row is the left side, so zero concentrators still yield
// generated_at and last_usage_applied_at with items=[]. Aggregates stay in
// lateral subqueries so joins cannot multiply NAS rows. Pending usage uses the
// same window and counter delta as the usage consumer (sql/2d1c3b4c_2.sql),
// not a new quota. Open accounting and packet recency are not online or policy proof.
const radiusTelemetrySQL = `select nas.device_id, nas.name, nas.nas_ip,
 nas.acct_interim_seconds,
 nas.threshold_seconds, nas.threshold_source,
 nas.last_packet_at,
 nas.last_accounting_at,
 nas.open_sessions, nas.overdue_sessions,
 nas.oldest_open_seen_at,
 nas.events_24h, nas.max_reported_delay_seconds_24h,
 nas.quarantined_events, nas.pending_usage_sessions,
 meta.generated_at, meta.last_usage_applied_at
from (
 select now() as generated_at,
        (select max(ss.reported_at) from service_sessions ss
           join service_resources sr on sr.id = ss.resource_id
           join devices rd on rd.id = sr.device_id and rd.driver = 'radius') as last_usage_applied_at
) meta
left join lateral (
 select d.id as device_id, d.name, host(n.nas_ip) as nas_ip,
  d.acct_interim_seconds,
  coalesce(2*d.acct_interim_seconds+60, 900)::int as threshold_seconds,
  case when d.acct_interim_seconds is null then 'default' else 'interim' end as threshold_source,
  n.last_packet_at,
  acct.last_accounting_at,
  coalesce(acct.open_sessions, 0)::int as open_sessions,
  coalesce(acct.overdue_sessions, 0)::int as overdue_sessions,
  acct.oldest_open_seen_at,
  coalesce(ev.events_24h, 0)::int as events_24h,
  ev.max_reported_delay_seconds_24h,
  coalesce(ev.quarantined_events, 0)::int as quarantined_events,
  coalesce(pend.pending_usage_sessions, 0)::int as pending_usage_sessions
 from devices d
 join radius_nas n on n.device_id = d.id
 left join lateral (
   select max(x.seen_at) as last_accounting_at,
          count(*) filter (where x.stopped_at is null)::int as open_sessions,
          count(*) filter (where x.stopped_at is null and x.seen_at < now() - make_interval(secs => (coalesce(2*d.acct_interim_seconds+60, 900))::double precision))::int as overdue_sessions,
          min(x.seen_at) filter (where x.stopped_at is null) as oldest_open_seen_at
   from radius_acct x
   where x.nas_device_id = d.id
 ) acct on true
 left join lateral (
   select count(*) filter (where e.received_at > now() - interval '24 hours')::int as events_24h,
          max(case when e.received_at > now() - interval '24 hours' and e.data->>'delay' ~ '^[0-9]{1,9}$' then (e.data->>'delay')::bigint end) as max_reported_delay_seconds_24h,
          count(*) filter (where e.status = 'quarantine')::int as quarantined_events
   from radius_accounting_events e
   where e.nas_device_id = d.id
 ) ev on true
 left join lateral (
   select count(*)::int as pending_usage_sessions
   from radius_acct x
   join service_resources r on r.tenant_id = x.tenant_id and r.pppoe_username = x.username
   join devices rd on rd.id = r.device_id and rd.driver = 'radius'
   left join service_sessions s on s.resource_id = r.id and s.session_key = left(x.unique_id, 80)
   where x.nas_device_id = d.id
     and (x.stopped_at is null or x.updated_at > now() - interval '2 days')
     and (x.bytes_in > coalesce(s.bytes_in, 0) or x.bytes_out > coalesce(s.bytes_out, 0))
 ) pend on true
 where d.driver = 'radius'
 order by d.name, d.id
 limit 500
) nas on true
order by nas.name, nas.device_id`

func rejectTelemetryQuery(q url.Values) error {
	for _, values := range q {
		if len(values) != 1 {
			return apierr.New(400, "filtro repetido")
		}
		return apierr.New(400, "filtro desconhecido")
	}
	return nil
}

func telemetryItems(rows []jsonx.Object) (items []jsonx.Object, generated, applied any) {
	items = []jsonx.Object{}
	if len(rows) > 0 {
		generated = rows[0].Get("generated_at")
		applied = rows[0].Get("last_usage_applied_at")
	}
	for _, row := range rows {
		if row.Get("device_id") == nil {
			continue
		}
		item := make(jsonx.Object, 0, len(row))
		for _, field := range row {
			if field.Name == "generated_at" || field.Name == "last_usage_applied_at" {
				continue
			}
			item = append(item, field)
		}
		items = append(items, item)
	}
	return items, generated, applied
}

func registerRadiusTelemetry(api huma.API, r *endpoint.Registry, s Service) {
	r.Get(api, "/api/radius/accounting/telemetry", "network:read", false, func(ctx context.Context, req *http.Request) (endpoint.Result, error) {
		if e := accountingScope(ctx); e != nil {
			return endpoint.Result{}, e
		}
		if e := rejectTelemetryQuery(req.URL.Query()); e != nil {
			return endpoint.Result{}, e
		}
		rows, e := s.rows(ctx, radiusTelemetrySQL)
		if e != nil {
			return endpoint.Result{}, e
		}
		items, generated, applied := telemetryItems(rows)
		return endpoint.Result{Value: map[string]any{
			"items": items, "generated_at": generated, "last_usage_applied_at": applied,
			"limit": 500, "source": "radius_acct",
			"open_accounting_is_online_proof": false, "packet_recency_is_policy_proof": false,
		}, CacheControl: "no-store"}, nil
	})
}
