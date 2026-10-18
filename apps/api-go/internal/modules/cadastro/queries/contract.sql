-- name: Contract :one

  select c.*, s.name as subscriber_name, s.document as subscriber_document,
         p.id as plan_id, p.name as plan_name, pv.version as plan_version, pv.price_cents, pv.down_kbps, pv.up_kbps, pv.profile_name,
         coalesce((select json_agg(json_build_object('id', t.id, 'name', t.name) order by t.name) from contract_tags ct join tags t on t.id = ct.tag_id where ct.contract_id = c.id), '[]') as tags
  from contracts c
  join subscribers s on s.id = c.subscriber_id
  join plan_versions pv on pv.id = c.plan_version_id
  join plans p on p.id = pv.plan_id where c.id = $1;
