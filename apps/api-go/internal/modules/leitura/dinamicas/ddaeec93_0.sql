
  select g.*, pub.name as public_pool_name, priv.name as private_pool_name, u.name as created_by_name
  from cgnat_plans g join ip_pools pub on pub.id = g.public_pool_id join ip_pools priv on priv.id = g.private_pool_id left join users u on u.id = g.created_by order by g.retired_at nulls first, g.created_at desc