-- name: Read16a0e01f :many
select m.*, d.name as device_name, u.name as created_by_name,
      case when m.canceled_at is not null then 'canceled' when now() < m.starts_at then 'scheduled' when now() <= m.ends_at then 'active' else 'ended' end as state,
      case when m.device_id is null
        then (select count(distinct subscriber_id) from contracts where status = 'active')
        else (select count(distinct k.subscriber_id) from service_resources r join contracts k on k.id = r.contract_id where k.status = 'active' and r.device_id = m.device_id)
      end::int as affected_subscribers
    from maintenance_notices m left join devices d on d.id = m.device_id left join users u on u.id = m.created_by order by m.starts_at desc limit 100;
