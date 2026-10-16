select d.vendor, n.nas_ip::text as nas_ip, host(n.nas_ip) as nas_host, n.secret, n.coa_host, n.coa_port, pv.down_kbps, pv.up_kbps
         from devices d join radius_nas n on n.device_id = d.id join service_resources r on r.device_id = d.id
         join contracts k on k.id = r.contract_id join plan_versions pv on pv.id = k.plan_version_id where r.id = $1