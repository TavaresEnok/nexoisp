package escrita

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
)

// Portas PON identificadas pelas ONUs vinculadas e pelas descobertas da OLT
// (tela FTTx - PON do v0). Consulta derivada: capacidade e VLAN da porta não
// são cadastradas, e o sinal é o último observado em cada ONU.
const ponPortsSQL = `
with ports as (
  select device_id, pon_port from onus where desired_state = 'authorized'
  union
  select device_id, pon_port from onu_discoveries
)
select d.id as device_id, d.name as olt, p.pon_port,
  (select count(*)::int from onus o where o.device_id = p.device_id and o.pon_port = p.pon_port and o.desired_state = 'authorized') as onus,
  (select count(*)::int from onus o where o.device_id = p.device_id and o.pon_port = p.pon_port and o.desired_state = 'authorized' and o.observed_online) as online,
  (select round(avg(o.observed_rx_dbm), 2)::float8 from onus o where o.device_id = p.device_id and o.pon_port = p.pon_port and o.desired_state = 'authorized' and o.observed_online and o.observed_rx_dbm is not null) as rx_avg,
  (select count(*)::int from onu_discoveries x where x.device_id = p.device_id and x.pon_port = p.pon_port) as pending,
  coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'contract_id', k.id, 'online', o.observed_online, 'rx_dbm', o.observed_rx_dbm::float8) order by s.name)
    from onus o join contracts k on k.id = o.contract_id join subscribers s on s.id = k.subscriber_id
    where o.device_id = p.device_id and o.pon_port = p.pon_port and o.desired_state = 'authorized'), '[]'::jsonb) as subscribers
from ports p join devices d on d.id = p.device_id
order by d.name, p.pon_port`

func registerPonPorts(api huma.API, registry *endpoint.Registry, s Service) {
	registry.Get(api, "/api/olt/pon-ports", "network:read", false, func(ctx context.Context, _ *http.Request) (endpoint.Result, error) {
		var value any
		err := s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error {
			var err error
			value, err = tx.Objects(ctx, ponPortsSQL)
			return err
		})
		return endpoint.Result{Value: value}, err
	})
}
