select r.*, k.status as contract_status, pv.profile_name, pl.reduced_profile, pl.rate_limit, pl.address_pool, d.simultaneous_use, d.acct_interim_seconds,
            d.agent_id, d.name as device_name, ag.version as agent_version, ag.internal as agent_internal
     from service_resources r join contracts k on k.id = r.contract_id join plan_versions pv on pv.id = k.plan_version_id join plans pl on pl.id = pv.plan_id
     join devices d on d.id = r.device_id left join agents ag on ag.id = d.agent_id where r.id = $1 for update of r